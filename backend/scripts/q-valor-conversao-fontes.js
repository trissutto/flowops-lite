// Compara as 2 fontes de "valor de conversão" HOJE (Brasília).
const { Client } = require('pg');
(async () => {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const hojeBr = `(NOW() AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date`;

  // FONTE A — eventos purchase do funil (o que a tela mostra hoje)
  const a = await db.query(
    `SELECT COUNT(DISTINCT session_id)::int pessoas, COUNT(*)::int eventos,
            COALESCE(SUM(valor),0)::float valor
       FROM site_eventos
      WHERE evento='purchase'
        AND (criado_em AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = ${hojeBr}`);

  // FONTE B — pedidos pagos do site (faturamento real)
  const b = await db.query(
    `SELECT status, COUNT(*)::int n, COALESCE(SUM(total_amount),0)::float valor
       FROM orders
      WHERE source='ecommerce'
        AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = ${hojeBr}
      GROUP BY status ORDER BY n DESC`);

  console.log('══ FONTE A — eventos purchase do funil (o que a tela mostra) ══');
  console.log('  ', JSON.stringify(a.rows[0]));
  console.log('\n══ FONTE B — pedidos do site HOJE, por status ══');
  let pagos = 0, valPagos = 0;
  const PAGO = ['paid','shipped','separating','delivered','completed'];
  for (const r of b.rows) {
    console.log('  ', String(r.status).padEnd(18), r.n, 'ped', 'R$', r.valor.toFixed(2));
    if (PAGO.includes(r.status)) { pagos += r.n; valPagos += r.valor; }
  }
  console.log(`\n  >> PAGOS (${PAGO.join('/')}): ${pagos} pedidos = R$ ${valPagos.toFixed(2)}`);
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
