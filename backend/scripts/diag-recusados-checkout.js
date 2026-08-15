/**
 * POR QUE O SERVIDOR RECUSOU — motivo real dos "Pedido recusado pelo servidor".
 *   railway run --service Postgres node backend/scripts/diag-recusados-checkout.js [dias]
 */
const { Client } = require('pg');
const DIAS = Number(process.argv[2] || 3);

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const J = `criado_em > NOW() - INTERVAL '${DIAS} days'`;

  console.log(`══ eventos de checkout/erro (${DIAS}d) — nomes e volume ══`);
  const nomes = await db.query(
    `SELECT evento, COUNT(*) n, COUNT(DISTINCT session_id) pessoas
       FROM site_eventos WHERE ${J}
        AND (evento ILIKE '%error%' OR evento ILIKE '%recus%' OR evento ILIKE '%fail%'
             OR evento ILIKE '%block%' OR evento ILIKE '%checkout%' OR evento ILIKE '%payment%'
             OR evento ILIKE '%purchase%' OR evento ILIKE '%pix%')
      GROUP BY evento ORDER BY n DESC`);
  for (const r of nomes.rows) console.log(`  ${r.evento.padEnd(28)} ${String(r.n).padStart(4)} ev  ${r.pessoas} pessoas`);

  console.log(`\n══ DETALHE dos que cheiram a recusa (dados JSON) ══`);
  const det = await db.query(
    `SELECT evento, path, valor, dados, criado_em, LEFT(session_id,10) sid
       FROM site_eventos WHERE ${J}
        AND (evento ILIKE '%error%' OR evento ILIKE '%recus%' OR evento ILIKE '%fail%'
             OR evento ILIKE '%block%' OR (evento ILIKE '%payment%' AND evento ILIKE '%fail%'))
      ORDER BY criado_em DESC LIMIT 40`);
  for (const r of det.rows) {
    const d = typeof r.dados === 'string' ? r.dados : JSON.stringify(r.dados);
    console.log(`  ${r.criado_em.toISOString().slice(5,16)} ${r.sid} ${r.evento} ${r.path ?? ''} :: ${d}`);
  }

  console.log(`\n══ PEDIDOS payment_failed / cancelados (${DIAS}d) ══`);
  const ped = await db.query(
    `SELECT numero, status, forma_pagamento, total, motivo_recusa, criado_em
       FROM "Order" WHERE criado_em > NOW() - INTERVAL '${DIAS} days'
        AND (status = 'payment_failed' OR status ILIKE '%cancel%' OR motivo_recusa IS NOT NULL)
      ORDER BY criado_em DESC LIMIT 30`).catch(async () => {
    // fallback: nome de coluna diferente
    return db.query(
      `SELECT * FROM "Order" WHERE criado_em > NOW() - INTERVAL '${DIAS} days'
         AND status = 'payment_failed' ORDER BY criado_em DESC LIMIT 30`);
  });
  for (const r of ped.rows) console.log('  ', JSON.stringify(r));

  await db.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
