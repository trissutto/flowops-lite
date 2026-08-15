/**
 * SINAL REAL da campanha do VLM-222 — do NOSSO banco (site_eventos + orders),
 * não da abertura furada do Mautic. Tráfego no vestido + uso do cupom
 * VESTIDO139 (que só existe no e-mail = atribuição limpa).
 *   railway run --service Postgres node backend/scripts/diag-campanha-vlm222.js
 */
const { Client } = require('pg');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('══ TRÁFEGO NO VESTIDO (ref-vlm-222) — por hora, últimas 4h ══');
  const trafego = await db.query(
    `SELECT to_char(date_trunc('hour', criado_em AT TIME ZONE 'America/Sao_Paulo'),'DD/MM HH24"h"') AS hora,
            COUNT(DISTINCT session_id)::int AS sessoes, COUNT(*)::int AS eventos
       FROM site_eventos
      WHERE (path ILIKE '%vlm-222%' OR path ILIKE '%vlm222%' OR dados::text ILIKE '%VLM-222%')
        AND criado_em > NOW() - INTERVAL '4 hours'
      GROUP BY 1 ORDER BY 1`,
  );
  for (const r of trafego.rows) console.log(`  ${r.hora}  ${String(r.sessoes).padStart(4)} sessões · ${r.eventos} eventos`);
  if (!trafego.rows.length) console.log('  (nenhum tráfego no vestido nas últimas 4h)');

  console.log('\n══ CUPOM VESTIDO139 — atribuição limpa (só veio do e-mail) ══');
  const cup = await db.query(
    `SELECT evento, COUNT(*)::int AS n, COUNT(DISTINCT session_id)::int AS sessoes
       FROM site_eventos
      WHERE dados::text ILIKE '%VESTIDO139%' AND criado_em > NOW() - INTERVAL '6 hours'
      GROUP BY evento ORDER BY n DESC`,
  );
  if (!cup.rows.length) console.log('  (ninguém aplicou VESTIDO139 ainda)');
  for (const r of cup.rows) console.log(`  ${r.evento.padEnd(18)} ${r.n} eventos · ${r.sessoes} sessões`);

  console.log('\n══ ADD_TO_CART do vestido (últimas 4h) ══');
  const cart = await db.query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT session_id)::int AS sessoes
       FROM site_eventos WHERE evento='add_to_cart'
        AND (dados::text ILIKE '%VLM-222%' OR dados::text ILIKE '%vlm-222%')
        AND criado_em > NOW() - INTERVAL '4 hours'`,
  );
  console.log(`  ${cart.rows[0].n} add-to-cart · ${cart.rows[0].sessoes} sessões`);

  console.log('\n══ PEDIDOS com o cupom VESTIDO139 (hoje) ══');
  const ped = await db.query(
    `SELECT wc_order_number, customer_name, status, total_amount,
            (created_at AT TIME ZONE 'America/Sao_Paulo') AS criado
       FROM orders
      WHERE source='ecommerce' AND created_at::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
        AND (checkout_info ILIKE '%VESTIDO139%')
      ORDER BY created_at`,
  );
  if (!ped.rows.length) console.log('  (nenhum pedido com VESTIDO139 ainda)');
  for (const p of ped.rows) console.log(`  ${p.wc_order_number} · ${p.customer_name} · ${p.status} · R$${p.total_amount} · ${p.criado.toISOString().slice(11,16)}`);

  console.log('\n══ AGORA NO SITE (últimos 5 min) ══');
  const agora = await db.query(
    `SELECT COUNT(DISTINCT session_id)::int AS pessoas,
            COUNT(DISTINCT session_id) FILTER (WHERE path ILIKE '%vlm-222%')::int AS no_vestido
       FROM site_eventos WHERE criado_em > NOW() - INTERVAL '5 minutes'`,
  );
  console.log(`  ${agora.rows[0].pessoas} pessoas · ${agora.rows[0].no_vestido} no vestido`);

  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
