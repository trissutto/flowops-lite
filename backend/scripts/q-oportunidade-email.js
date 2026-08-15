/**
 * Onde o e-mail teria dinheiro pra pegar: carrinho abandonado com dono
 * identificado, cliente que não compra há muito tempo, e o tamanho do funil.
 *
 * Uso: railway run --service Postgres node backend/scripts/q-oportunidade-email.js
 */
const { Client } = require('pg');
const brl = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;

  console.log('══ FUNIL DO SITE (últimos 7 dias) ══');
  const funil = await q(`
    SELECT evento, COUNT(DISTINCT session_id) AS pessoas, COUNT(*) AS eventos
      FROM site_eventos WHERE criado_em >= NOW() - interval '7 days'
     GROUP BY evento ORDER BY pessoas DESC LIMIT 12`);
  for (const f of funil) console.log(`  ${String(f.evento).padEnd(26)} ${String(f.pessoas).padStart(6)} pessoas · ${f.eventos} eventos`);

  console.log('\n══ PEDIDO QUE NÃO VIROU VENDA (7 dias) ══');
  const perdidos = await q(`
    SELECT status, COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS valor
      FROM orders
     WHERE source='ecommerce' AND created_at >= NOW() - interval '7 days'
       AND status IN ('cancelled','failed','pending','payment_failed')
     GROUP BY status ORDER BY valor DESC`);
  for (const p of perdidos) console.log(`  ${String(p.status).padEnd(16)} ${String(p.n).padStart(3)} · ${brl(p.valor)}`);
  if (!perdidos.length) console.log('  (nenhum)');

  console.log('\n══ QUEM JÁ COMPROU NO SITE E TEM E-MAIL ══');
  const base = await q(`
    SELECT COUNT(DISTINCT customer_email) AS clientes,
           COUNT(DISTINCT customer_email) FILTER (WHERE created_at >= NOW() - interval '90 days') AS ativos_90d
      FROM orders
     WHERE source='ecommerce' AND customer_email IS NOT NULL AND customer_email <> ''
       AND status NOT IN ('cancelled','failed','pending','payment_failed')`);
  console.log(`  clientes com e-mail: ${base[0].clientes} · compraram nos últimos 90 dias: ${base[0].ativos_90d}`);

  console.log('\n══ TICKET MÉDIO (base pra projetar) ══');
  const t = await q(`
    SELECT COUNT(*) AS n, COALESCE(AVG(total_amount),0) AS ticket
      FROM orders WHERE source='ecommerce' AND created_at >= NOW() - interval '30 days'
        AND status NOT IN ('cancelled','failed','pending','payment_failed')`);
  console.log(`  ${t[0].n} vendas em 30 dias · ticket médio ${brl(t[0].ticket)}`);

  await db.end();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
