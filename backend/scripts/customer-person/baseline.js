/* Read-only baseline. Prints aggregate values only; never emits PII. */
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL ausente');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '120s'");
    const { rows } = await client.query(`
      SELECT json_build_object(
        'capturedAt', now(),
        'customers', (SELECT count(*) FROM customers),
        'orders', (SELECT count(*) FROM orders),
        'pdvSales', (SELECT count(*) FROM pdv_sales),
        'pdvSalesTotal', (SELECT coalesce(sum(total), 0)::text FROM pdv_sales WHERE status = 'finalized' AND NOT is_training),
        'crediarioParcelas', (SELECT count(*) FROM crediario_parcelas),
        'crediarioParcelasPagas', (SELECT count(*) FROM crediario_parcelas WHERE pago AND NOT cancelado),
        'crediarioValorCompra', (SELECT coalesce(sum(valor_compra), 0)::text FROM crediario_parcelas WHERE NOT cancelado),
        'crediarioValorPagoInformado', (SELECT coalesce(sum(valor_pago), 0)::text FROM crediario_parcelas WHERE pago AND NOT cancelado),
        'crediarioValorPagoEfetivo', (SELECT coalesce(sum(coalesce(valor_pago, valor_parcela)), 0)::text FROM crediario_parcelas WHERE pago AND NOT cancelado),
        'crediarioAberto', (SELECT coalesce(sum(valor_parcela), 0)::text FROM crediario_parcelas WHERE NOT pago AND NOT cancelado),
        'crediarioBaixas', (SELECT count(*) FROM crediario_baixas),
        'crediarioBaixasTotal', (SELECT coalesce(sum(total_pago), 0)::text FROM crediario_baixas WHERE status = 'paid'),
        'marcados', (SELECT count(*) FROM marcados),
        'marcadosAtivos', (SELECT count(*) FROM marcados WHERE status = 'ativo'),
        'marcadosAtivosTotal', (SELECT coalesce(sum(valor_total), 0)::text FROM marcados WHERE status = 'ativo'),
        'marcadosComVenda', (SELECT count(*) FROM marcados WHERE sale_id IS NOT NULL)
      ) AS baseline
    `);
    console.log(JSON.stringify(rows[0].baseline, null, 2));
    await client.query('ROLLBACK');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
