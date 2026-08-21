/**
 * ON-000080 — Andreia Renata José da Silva (R$ 249,80, 21/08/2026)
 *
 * O QUE ACONTECEU
 *   16:59  LIMEIRA (11) abre a venda no PDV e finaliza 17:07 → nasce o pedido
 *          ON-000080 (`pdv_online`, seller_store_code = 11), método SEDEX.
 *   17:07  A loja VENDEDORA não baixa estoque — é o desenho do pedido online
 *          (`pedido-online.service.ts`): quem baixa é a loja que SEPARA.
 *   17:23  O roteamento criou o card em CAMPINAS (07) — Limeira não tinha o
 *          sutiã no sistema, então o motor mandou pra quem tinha as duas peças.
 *   17:31  Campinas bipou as 2 peças → BAIXOU O ESTOQUE DE CAMPINAS.
 *   17:33  Card virou `shipped` com etiqueta SEDEX AD827124080BR.
 *
 * A VERDADE FÍSICA (gerente de Limeira): era pedido de MOTOBOY, as peças
 * saíram de LIMEIRA e foram entregues à cliente lá. O rastreio confirma que a
 * etiqueta de Campinas está só "Etiqueta emitida" — a caixa NUNCA foi postada.
 *
 * CORREÇÃO
 *   Campinas (07): +1 em cada peça — estorna a baixa indevida, as peças
 *                  continuam no cabide de lá.
 *   Limeira  (11): -1 no VESTIDO — a peça saiu de lá de verdade.
 *                  O SUTIÃ não tem linha de estoque em Limeira (o sistema já
 *                  conta 0), então não há o que debitar: Limeira vendeu uma
 *                  peça que o sistema não sabia que ela tinha. Fica o registro.
 *   Os 2 bipes de Campinas são marcados como revertidos, pra evidência não
 *   dizer "Campinas baixou" enquanto o estoque diz o contrário.
 *
 * ⚠️ NÃO POSTAR a etiqueta AD827124080BR. Se a caixa de Campinas for postada,
 *    a cliente recebe as peças duas vezes.
 *
 * Rodar da RAIZ do repo, com o railway linkado em heroic-mercy > Postgres.
 * Dry-run por padrão. `railway run node backend/scripts/fix-on-000080-estoque.js --apply` grava.
 */
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');

const PICK_ORDER_ID = 'df49eb55-5a55-4b96-a8e5-6b3af7a67faa';
const ORDER_ID = 'a9401716-c14e-4711-9e8e-b5b2fa4e62aa';
const MOTIVO = 'ON-000080 roteado pra Campinas — motoboy saiu de Limeira';

// [sku, loja, delta]
const AJUSTES = [
  ['5358564', '07', +1], // VESTIDO MID VMS-223 PRETO 58 — estorna Campinas
  ['7909392119945', '07', +1], // SUTIÃ 41216 PRETO 52/54 — estorna Campinas
  ['5358564', '11', -1], // VESTIDO — saiu de Limeira de verdade
];

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  const plano = [];
  for (const [sku, loja, delta] of AJUSTES) {
    const { rows } = await db.query(
      `SELECT id, estoque FROM giga_estoque
        WHERE regexp_replace(codigo,'^0+','')=$1 AND loja=$2`,
      [sku, loja],
    );
    const row = rows[0] || null;
    const antes = row ? Number(row.estoque) : null;
    const depois = row ? antes + delta : null;
    plano.push({ sku, loja, delta, row, antes, depois });
    const sinal = delta > 0 ? `+${delta}` : String(delta);
    if (!row) {
      console.log(`⚠️  ${sku} loja ${loja}: SEM LINHA de estoque — pulado (${sinal})`);
    } else if (depois < 0) {
      console.log(`⛔ ${sku} loja ${loja}: ${antes} ${sinal} = ${depois} — NEGATIVO, pulado`);
    } else {
      console.log(`   ${sku} loja ${loja}: ${antes} → ${depois}  (${sinal})`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY-RUN. Nada gravado. Rode com --apply pra valer.');
    await db.end();
    return;
  }

  await db.query('BEGIN');
  try {
    for (const p of plano) {
      if (!p.row || p.depois < 0) continue;
      await db.query(`UPDATE giga_estoque SET estoque=$1, synced_at=now() WHERE id=$2`, [
        p.depois,
        p.row.id,
      ]);
      await db.query(
        `INSERT INTO wincred_estoque (codigo, loja, estoque, synced_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (codigo, loja) DO UPDATE SET estoque=$3, synced_at=now()`,
        [p.sku, p.loja, p.depois],
      );
      console.log(`✅ ${p.sku} loja ${p.loja}: ${p.antes} → ${p.depois}`);
    }

    // Evidência: os bipes de Campinas não valem mais.
    const r = await db.query(
      `UPDATE pick_order_scans
          SET reverted_at = now(), revert_reason = $1, stock_increased_at = now()
        WHERE pick_order_id = $2 AND order_id = $3 AND reverted_at IS NULL`,
      [MOTIVO, PICK_ORDER_ID, ORDER_ID],
    );
    console.log(`✅ ${r.rowCount} bipe(s) de Campinas marcados como revertidos`);

    await db.query('COMMIT');
    console.log('\nCOMMIT ok.');
    console.log('⚠️  Avisar Campinas pra NÃO postar a etiqueta AD827124080BR.');
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
