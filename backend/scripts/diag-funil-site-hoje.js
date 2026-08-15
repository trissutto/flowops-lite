/**
 * FUNIL DO SITE HOJE — sessões → produto → sacola → checkout → pedido pago.
 * Tudo do NOSSO dado: site_eventos (eventos do navegador, com e sem aceite)
 * e orders (source='loja' = e-commerce novo, faixa 950M).
 *
 *   railway run --service Postgres node backend/scripts/diag-funil-site-hoje.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const HOJE = `criado_em >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;

  console.log('══════ EVENTOS DE HOJE (site_eventos) ══════');
  const eventos = await db.query(
    `SELECT evento, COUNT(*)::int AS n, COUNT(DISTINCT session_id)::int AS sessoes
       FROM site_eventos WHERE ${HOJE}
      GROUP BY evento ORDER BY n DESC`,
  );
  for (const e of eventos.rows) {
    console.log(`  ${e.evento.padEnd(22)} ${String(e.n).padStart(6)} eventos | ${String(e.sessoes).padStart(5)} sessões`);
  }

  console.log('\n══════ FUNIL POR SESSÃO (hoje) ══════');
  const funil = await db.query(
    `SELECT
       COUNT(DISTINCT session_id)::int AS sessoes,
       COUNT(DISTINCT session_id) FILTER (WHERE evento = 'view_item')::int      AS viram_produto,
       COUNT(DISTINCT session_id) FILTER (WHERE evento = 'add_to_cart')::int    AS puseram_sacola,
       COUNT(DISTINCT session_id) FILTER (WHERE evento = 'begin_checkout')::int AS comecaram_checkout,
       COUNT(DISTINCT session_id) FILTER (WHERE evento = 'search')::int         AS buscaram
     FROM site_eventos WHERE ${HOJE} AND session_id IS NOT NULL`,
  );
  const f = funil.rows[0];
  console.log(`  sessões: ${f.sessoes} → viram produto: ${f.viram_produto} → sacola: ${f.puseram_sacola} → checkout: ${f.comecaram_checkout} (busca: ${f.buscaram})`);

  console.log('\n══════ ÚLTIMA HORA ══════');
  const hora = await db.query(
    `SELECT COUNT(DISTINCT session_id)::int AS sessoes,
            COUNT(DISTINCT session_id) FILTER (WHERE evento = 'add_to_cart')::int AS sacolas
       FROM site_eventos WHERE criado_em > NOW() - INTERVAL '60 minutes'`,
  );
  console.log(`  sessões: ${hora.rows[0].sessoes} | sacolas: ${hora.rows[0].sacolas}`);

  console.log('\n══════ PEDIDOS DE HOJE (orders) ══════');
  const pedidos = await db.query(
    `SELECT source, status,
            COUNT(*)::int AS n,
            COALESCE(SUM(total_amount),0)::float8 AS total,
            COUNT(*) FILTER (WHERE paid_at IS NOT NULL)::int AS pagos
       FROM orders
      WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
      GROUP BY source, status ORDER BY source, status`,
  );
  if (!pedidos.rows.length) console.log('  (nenhum pedido hoje)');
  for (const p of pedidos.rows) {
    console.log(`  ${String(p.source).padEnd(6)} ${String(p.status).padEnd(16)} ${String(p.n).padStart(3)} pedidos | R$ ${p.total.toFixed(2).padStart(9)} | pagos: ${p.pagos}`);
  }

  console.log('\n══════ PEDIDOS DO SITE NOVO (source=ecommerce) — últimos 7 dias ══════');
  const semana = await db.query(
    `SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
            COUNT(*)::int AS n, COALESCE(SUM(total_amount),0)::float8 AS total,
            COUNT(*) FILTER (WHERE paid_at IS NOT NULL)::int AS pagos,
            COUNT(*) FILTER (WHERE status = 'awaiting_payment')::int AS aguardando
       FROM orders
      WHERE source = 'ecommerce' AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY 1 ORDER BY 1`,
  );
  for (const d of semana.rows) {
    console.log(`  ${d.dia.toISOString().slice(0, 10)}  ${String(d.n).padStart(3)} pedidos | R$ ${d.total.toFixed(2).padStart(9)} | pagos: ${d.pagos} | aguardando: ${d.aguardando}`);
  }

  console.log('\n══════ AGUARDANDO PAGAMENTO (site novo, 7 dias) — pode ter PIX pago preso ══════');
  const presos = await db.query(
    `SELECT wc_order_number, customer_name, total_amount,
            (created_at AT TIME ZONE 'America/Sao_Paulo') AS criado
       FROM orders
      WHERE source = 'ecommerce' AND status = 'awaiting_payment'
        AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC`,
  );
  for (const p of presos.rows) {
    console.log(`  ${p.wc_order_number} | ${p.customer_name} | R$ ${p.total_amount} | ${p.criado.toISOString().slice(0, 16).replace('T', ' ')}`);
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
