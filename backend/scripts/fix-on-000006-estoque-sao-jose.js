/**
 * ON-000006 — Bruna Pacheco Torres (São José dos Campos, retirada na loja)
 *
 * O QUE ACONTECEU (tudo medido no Postgres, nada inferido)
 *   17/08 17:40  Nasce o ON-000006 (pdv_online, loja canal 13, retirada em SJC).
 *                Roteamento `force-manual`: as 11 peças BMM-100 vão pro card da
 *                loja 08, tenha ela estoque ou não.
 *   17/08 20:24  ITANHAÉM (01) fecha a REM-2026-001250 (TRANSFERENCIA, 5 peças:
 *                PRETO 50, UVA 50, UVA 52, VINHO 50, VINHO 52) → baixa em 01.
 *   19/08 17:35  São José bipa 10 peças no card — INCLUSIVE as 5 que ainda
 *                estavam dentro da caixa em trânsito. Flow aplica -1 em cada.
 *   19/08 17:36  O cron do outbox replica as baixas no Giga e o write-through
 *                (`mirrorStockWriteThrough`) grava o saldo do GIGA por cima do
 *                estoque do Flow. Prova: `erp_outbox.done_at` ==
 *                `giga_estoque.synced_at`, no mesmo milissegundo, linha a linha
 *                (ex.: VINHO 52 bipada 17:35:50.614, regravada 17:36:01.926).
 *   19/08 19:48  São José dá entrada na caixa → +1 no Flow, +1 no Giga, e o
 *                write-through carimba o número do Giga de novo.
 *
 * RESULTADO: a peça saiu na sacola da cliente e São José continua com saldo 1
 * de VINHO 50 e VINHO 52 — o número que o GIGA tinha, não o que o Flow contou.
 * As outras 3 peças da mesma caixa (PRETO 50, UVA 50, UVA 52) ficaram em 0
 * porque ali os dois bancos concordavam.
 *
 * A CAUSA está corrigida no código (o write-through virou no-op atrás de
 * `ERP_STOCK_WRITEBACK_GIGA`). Este script só limpa o que já ficou errado.
 *
 * CORREÇÃO
 *   Loja 08 · 8000000004499 (BMM-100 VINHO 50): 1 → 0
 *   Loja 08 · 8000000004505 (BMM-100 VINHO 52): 1 → 0
 *
 * NÃO TOCA (suspeitas com a mesma digital, mas sem contagem física — o script
 * só IMPRIME pra alguém conferir na arara antes de mexer):
 *   Loja 01 · VINHO 52 = 1 depois de ter enviado a peça na REM-2026-001250;
 *   Loja 08 · MARINHO 50 = 1 depois de ter sido bipada no mesmo pedido.
 *
 * Rodar da RAIZ do repo, com o railway linkado em heroic-mercy.
 * Dry-run por padrão:
 *   railway run --service Postgres node backend/scripts/fix-on-000006-estoque-sao-jose.js
 *   railway run --service Postgres node backend/scripts/fix-on-000006-estoque-sao-jose.js --apply
 */
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');

// [sku, loja, valor final, descrição]
const AJUSTES = [
  ['8000000004499', '08', 0, 'BMM-100 VINHO 50 — veio na REM-2026-001250 e saiu no ON-000006'],
  ['8000000004505', '08', 0, 'BMM-100 VINHO 52 — veio na REM-2026-001250 e saiu no ON-000006'],
];

// [sku, loja, descrição] — só conferência, nunca escrita.
const CONFERIR = [
  ['8000000004505', '01', 'ITANHAÉM: enviou a peça na REM-2026-001250 e continua com saldo'],
  ['8000000004178', '08', 'SÃO JOSÉ: MARINHO 50 bipada no ON-000006 e continua com saldo'],
];

const lerEstoque = async (db, sku, loja) => {
  const { rows } = await db.query(
    `SELECT id, estoque FROM giga_estoque
      WHERE regexp_replace(codigo,'^0+','') = regexp_replace($1,'^0+','') AND loja = $2`,
    [sku, loja],
  );
  return rows[0] || null;
};

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  console.log('CORREÇÃO — ON-000006 / REM-2026-001250\n');
  const plano = [];
  for (const [sku, loja, alvo, desc] of AJUSTES) {
    const row = await lerEstoque(db, sku, loja);
    const antes = row ? Number(row.estoque) : null;
    plano.push({ sku, loja, alvo, desc, row, antes });
    if (!row) {
      console.log(`⚠️  ${sku} loja ${loja}: SEM LINHA de estoque — pulado`);
    } else if (antes === alvo) {
      console.log(`   ${sku} loja ${loja}: já está ${alvo} — nada a fazer`);
    } else {
      console.log(`   ${sku} loja ${loja}: ${antes} → ${alvo}   (${desc})`);
    }
  }

  console.log('\nCONFERIR NA ARARA (o script NÃO mexe nestes):');
  for (const [sku, loja, desc] of CONFERIR) {
    const row = await lerEstoque(db, sku, loja);
    console.log(`   ${sku} loja ${loja}: sistema diz ${row ? row.estoque : 'sem linha'} — ${desc}`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN. Nada gravado. Rode com --apply pra valer.');
    await db.end();
    return;
  }

  await db.query('BEGIN');
  try {
    for (const p of plano) {
      if (!p.row || p.antes === p.alvo) continue;
      await db.query(`UPDATE giga_estoque SET estoque=$1, synced_at=now() WHERE id=$2`, [
        p.alvo,
        p.row.id,
      ]);
      await db.query(
        `INSERT INTO wincred_estoque (codigo, loja, estoque, synced_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (codigo, loja) DO UPDATE SET estoque=$3, synced_at=now()`,
        [p.sku, p.loja, p.alvo],
      );
      console.log(`✅ ${p.sku} loja ${p.loja}: ${p.antes} → ${p.alvo}`);
    }
    await db.query('COMMIT');
    console.log('\nCOMMIT ok.');
    console.log(
      '⚠️  Só vale com o deploy do fix do write-through no ar. Sem ele, a próxima\n' +
      '    baixa ou entrada dessas peças traz o número do Giga de volta.',
    );
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('ROLLBACK:', e.message);
    process.exit(1);
  }
  await db.end();
})().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
