/**
 * ZERAR AS LINHAS DE ESTOQUE NEGATIVO (ordem do dono, 24/08/2026).
 *
 * Saldo negativo não é quantidade: ninguém envia "menos uma peça". Ele nasce de
 * venda que baixou estoque que o sistema não sabia que tinha, e fica no espelho
 * como dívida — atrapalhando duas coisas ao mesmo tempo:
 *
 *  1. a CONTA DO SITE, que soma o saldo de todas as lojas por `codigo`: um -197
 *     na loja 01 escondia 197 peças que a loja 06 tem de verdade na arara;
 *  2. a CONFERÊNCIA, onde a linha negativa aparece como divergência eterna.
 *
 * Mexe nos DOIS espelhos (`wincred_estoque` e `giga_estoque`, o do financeiro) —
 * senão a próxima conferência mostra os dois brigando entre si — e registra cada
 * ajuste em `stock_movements`, exatamente como o `puxarDoGiga` do conferidor.
 * Zerar sem deixar rastro seria trocar um número errado por um número sem
 * história.
 *
 * ⚠️ Isto NÃO resolve a causa: enquanto uma venda puder baixar peça que a loja
 * não tinha, a negativa volta. O script é seguro pra rodar de novo.
 *
 *   railway run --service Postgres node backend/scripts/zerar-estoque-negativo.js            # simulação
 *   railway run --service Postgres node backend/scripts/zerar-estoque-negativo.js --apply    # grava
 *   ... --loja 13    → só uma loja
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const APLICAR = process.argv.includes('--apply');
const lojaArg = (() => {
  const i = process.argv.indexOf('--loja');
  return i > 0 ? String(process.argv[i + 1] || '').trim() : null;
})();

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const filtroLoja = lojaArg ? `AND TRIM(loja) = '${lojaArg.replace(/'/g, "''")}'` : '';

  const wincred = (
    await db.query(`SELECT codigo, TRIM(loja) AS loja, estoque FROM wincred_estoque WHERE estoque < 0 ${filtroLoja} ORDER BY loja, codigo`)
  ).rows;
  const giga = (
    await db.query(`SELECT codigo, TRIM(loja) AS loja, estoque FROM giga_estoque WHERE estoque < 0 ${filtroLoja} ORDER BY loja, codigo`)
  ).rows;

  const soma = (rows) => rows.reduce((a, r) => a + (Number(r.estoque) || 0), 0);
  console.log(`wincred_estoque: ${wincred.length} linhas negativas (${soma(wincred)} peças)`);
  console.log(`giga_estoque:    ${giga.length} linhas negativas (${soma(giga)} peças)`);
  if (lojaArg) console.log(`(filtrado na loja ${lojaArg})`);

  const porLoja = new Map();
  for (const r of wincred) porLoja.set(r.loja, (porLoja.get(r.loja) || 0) + 1);
  console.log('por loja:', [...porLoja.entries()].map(([l, n]) => `${l}=${n}`).join(' · ') || '(nenhuma)');

  if (!wincred.length && !giga.length) {
    console.log('\nNada a fazer.');
    await db.end();
    return;
  }

  // BACKUP ANTES DE ESCREVER — é o que permite voltar atrás linha por linha.
  const arquivo = path.join(__dirname, `backup-negativos-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(arquivo, JSON.stringify({ wincred, giga }, null, 2));
  console.log(`\nbackup: ${arquivo}`);

  if (!APLICAR) {
    console.log('\nSIMULAÇÃO — nada foi gravado. Rode com --apply pra valer.');
    await db.end();
    return;
  }

  await db.query('BEGIN');
  try {
    // O movimento vai ANTES do update, com o valor de antes ainda no banco.
    for (let i = 0; i < wincred.length; i += 500) {
      const lote = wincred.slice(i, i + 500);
      // Os casts são obrigatórios: numa tabela derivada de VALUES o Postgres lê
      // todo parâmetro como `text` e recusa gravar em coluna `integer`.
      const valores = lote
        .map(
          (r, j) =>
            `($${j * 5 + 1}::text, $${j * 5 + 2}::text, $${j * 5 + 3}::int, $${j * 5 + 4}::int, 0::int, 'ZERAR_NEGATIVO'::text, $${j * 5 + 5}::text)`,
        )
        .join(', ');
      const params = lote.flatMap((r) => [
        r.loja,
        String(r.codigo),
        -Number(r.estoque), // delta que leva a 0
        Number(r.estoque),
        `Saldo negativo zerado (${r.estoque} → 0) — ordem do dono 24/08/2026`,
      ]);
      await db.query(
        `INSERT INTO stock_movements (id, store_code, sku, delta, qty_before, qty_after, reason, note)
         SELECT gen_random_uuid(), v.store_code, v.sku, v.delta, v.qty_before, v.qty_after, v.reason, v.note
           FROM (VALUES ${valores}) AS v(store_code, sku, delta, qty_before, qty_after, reason, note)`,
        params,
      );
    }

    const u1 = await db.query(`UPDATE wincred_estoque SET estoque = 0, synced_at = NOW() WHERE estoque < 0 ${filtroLoja}`);
    const u2 = await db.query(`UPDATE giga_estoque SET estoque = 0, synced_at = NOW() WHERE estoque < 0 ${filtroLoja}`);
    await db.query('COMMIT');
    console.log(`\nwincred_estoque zeradas: ${u1.rowCount}`);
    console.log(`giga_estoque zeradas:    ${u2.rowCount}`);
    console.log(`movimentos registrados:  ${wincred.length} (reason=ZERAR_NEGATIVO)`);
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('ROLLBACK —', e.message);
    process.exitCode = 1;
  }

  const sobrou = await db.query(`SELECT COUNT(*)::int AS n FROM wincred_estoque WHERE estoque < 0`);
  console.log(`negativas restantes em wincred_estoque: ${sobrou.rows[0].n}`);
  await db.end();
}

main().catch((e) => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
