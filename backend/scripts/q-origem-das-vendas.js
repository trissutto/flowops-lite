/**
 * DE ONDE VEIO CADA VENDA. Lê a atribuição que o pedido já grava
 * (utm_source/medium/campaign) e mostra pedido a pedido + o resumo por origem.
 *
 * Uso: railway run --service Postgres node backend/scripts/q-origem-das-vendas.js [dias]
 */
const { Client } = require('pg');

const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const PAGO_NAO = `('cancelled','failed','pending','payment_failed')`;

async function main() {
  const dias = Number(process.argv[2] || 1);
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  console.log(`══ ORIGEM DAS VENDAS · últimos ${dias} dia(s) · ${agora} ══\n`);

  const { rows } = await db.query(`
    SELECT wc_order_number, total_amount, status, created_at, customer_name,
           utm_source, utm_medium, utm_campaign
      FROM orders
     WHERE created_at >= NOW() - ($1 || ' days')::interval
       AND source = 'ecommerce'
     ORDER BY created_at DESC`, [String(dias)]);

  for (const p of rows) {
    const hora = new Date(p.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const pago = !['cancelled', 'failed', 'pending', 'payment_failed'].includes(String(p.status));
    const origem = p.utm_source
      ? `${p.utm_source}${p.utm_medium ? '/' + p.utm_medium : ''}${p.utm_campaign ? ' · ' + p.utm_campaign : ''}`
      : '❓ SEM ATRIBUIÇÃO';
    console.log(`  ${hora} · ${String(p.wc_order_number ?? '—').padEnd(11)} · ${brl(p.total_amount).padStart(11)} · ${pago ? 'PAGO ' : p.status.padEnd(5)} · ${origem}`);
  }
  if (!rows.length) console.log('  (nenhum pedido no período)');

  const resumo = await db.query(`
    SELECT COALESCE(utm_source, '(sem atribuição)') AS origem,
           COUNT(*) AS pedidos,
           COUNT(*) FILTER (WHERE status NOT IN ${PAGO_NAO}) AS pagos,
           COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ${PAGO_NAO}), 0) AS receita
      FROM orders
     WHERE created_at >= NOW() - ($1 || ' days')::interval AND source = 'ecommerce'
     GROUP BY 1 ORDER BY receita DESC`, [String(dias)]);

  console.log('\n══ RESUMO POR ORIGEM ══');
  for (const r of resumo.rows) {
    console.log(`  ${String(r.origem).padEnd(24)} ${String(r.pagos).padStart(3)} vendas · ${brl(r.receita).padStart(12)}  (${r.pedidos} pedidos)`);
  }

  await db.end();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
