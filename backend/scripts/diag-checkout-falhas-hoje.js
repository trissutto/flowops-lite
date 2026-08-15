/**
 * Por que as sessões de HOJE falharam no checkout: pega toda sessão com
 * `checkout_error`, imprime a linha do tempo dela (evento + dados) e diz se
 * terminou em pedido pago.
 *
 *   node backend/scripts/diag-checkout-falhas-hoje.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const cols = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='site_eventos' ORDER BY ordinal_position`,
  );
  console.log('── colunas site_eventos ──');
  console.log(cols.rows.map((r) => `${r.column_name}:${r.data_type}`).join(', '));

  const sessoes = await db.query(
    `SELECT DISTINCT session_id FROM site_eventos
      WHERE evento='checkout_error'
        AND criado_em > NOW() - INTERVAL '30 hours'
        AND session_id IS NOT NULL`,
  );
  console.log(`\n── ${sessoes.rows.length} sessões com falha nas últimas 30h ──`);

  for (const { session_id } of sessoes.rows) {
    const ev = await db.query(
      `SELECT evento, dados, criado_em AT TIME ZONE 'America/Sao_Paulo' AS h
         FROM site_eventos WHERE session_id=$1 AND criado_em > NOW() - INTERVAL '48 hours'
        ORDER BY criado_em`,
      [session_id],
    );
    console.log(`\n### ${session_id.slice(0, 10)} (${ev.rows.length} eventos)`);
    for (const r of ev.rows) {
      const d = r.dados && Object.keys(r.dados).length ? JSON.stringify(r.dados) : '';
      console.log(`  ${new Date(r.h).toISOString().slice(11, 19)}  ${r.evento.padEnd(26)} ${d}`);
    }
  }

  console.log('\n── contagem por evento+reason (30h) ──');
  const cont = await db.query(
    `SELECT evento, dados->>'reason' AS reason, dados->>'method' AS metodo, COUNT(*) n,
            COUNT(DISTINCT session_id) pessoas
       FROM site_eventos
      WHERE criado_em > NOW() - INTERVAL '30 hours'
        AND evento IN ('checkout_error','checkout_validation_error','checkout_submission','card_declined')
      GROUP BY 1,2,3 ORDER BY n DESC`,
  );
  console.table(cont.rows);

  console.log('\n── checkout_validation_error por campo (7 dias) ──');
  const vf = await db.query(
    `SELECT dados->>'section' AS secao, dados->>'field' AS campo, COUNT(*) n,
            COUNT(DISTINCT session_id) pessoas
       FROM site_eventos
      WHERE evento='checkout_validation_error' AND criado_em > NOW() - INTERVAL '7 days'
      GROUP BY 1,2 ORDER BY n DESC LIMIT 25`,
  );
  console.table(vf.rows);

  await db.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
