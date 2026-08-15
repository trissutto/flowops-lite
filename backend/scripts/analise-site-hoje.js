/**
 * ANÁLISE GERAL DO SITE HOJE — rejeição, funil, páginas, horário, pedidos.
 * railway run --service Postgres node analise-site-hoje.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const HOJE = `criado_em >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`;

  console.log('══ 1. EVENTOS DE HOJE ══');
  const ev = await db.query(`SELECT evento, COUNT(*)::int n, COUNT(DISTINCT session_id)::int s FROM site_eventos WHERE ${HOJE} GROUP BY evento ORDER BY n DESC`);
  for (const e of ev.rows) console.log(`  ${e.evento.padEnd(20)} ${String(e.n).padStart(5)} ev | ${String(e.s).padStart(4)} sessões`);

  console.log('\n══ 2. AMOSTRA DO CAMPO dados (page_view) ══');
  const amostra = await db.query(`SELECT dados FROM site_eventos WHERE ${HOJE} AND evento='page_view' AND dados IS NOT NULL ORDER BY criado_em DESC LIMIT 5`);
  for (const a of amostra.rows) console.log('  ', JSON.stringify(a.dados).slice(0, 300));

  console.log('\n══ 3. REJEIÇÃO (sessões de 1 page_view e nada mais) ══');
  const rej = await db.query(`
    WITH s AS (
      SELECT session_id,
             COUNT(*) FILTER (WHERE evento='page_view')::int pv,
             COUNT(*) FILTER (WHERE evento<>'page_view')::int outros
        FROM site_eventos WHERE ${HOJE} AND session_id IS NOT NULL
       GROUP BY session_id)
    SELECT COUNT(*)::int sessoes,
           COUNT(*) FILTER (WHERE pv<=1 AND outros=0)::int rejeitadas,
           ROUND(AVG(pv),1) pv_medio
      FROM s`);
  const r = rej.rows[0];
  console.log(`  sessões: ${r.sessoes} | rejeitadas (1 pág, sem interação): ${r.rejeitadas} (${(100*r.rejeitadas/r.sessoes).toFixed(1)}%) | páginas/sessão: ${r.pv_medio}`);

  console.log('\n══ 4. PÁGINA DE ENTRADA (primeiro evento da sessão) ══');
  const entrada = await db.query(`
    WITH primeiro AS (
      SELECT DISTINCT ON (session_id) session_id, path
        FROM site_eventos WHERE ${HOJE} AND session_id IS NOT NULL
       ORDER BY session_id, criado_em ASC)
    SELECT COALESCE(path,'?') path, COUNT(*)::int n FROM primeiro GROUP BY 1 ORDER BY n DESC LIMIT 12`);
  for (const e of entrada.rows) console.log(`  ${String(e.n).padStart(4)}  ${e.path}`);

  console.log('\n══ 5. TOP PÁGINAS VISTAS ══');
  const pgs = await db.query(`SELECT COALESCE(path,'?') path, COUNT(*)::int n FROM site_eventos WHERE ${HOJE} AND evento='page_view' GROUP BY 1 ORDER BY n DESC LIMIT 12`);
  for (const p of pgs.rows) console.log(`  ${String(p.n).padStart(4)}  ${p.path}`);

  console.log('\n══ 6. SESSÕES POR HORA (vs campanhas 13:34 e 17:21) ══');
  const horas = await db.query(`
    SELECT EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Sao_Paulo')::int h,
           COUNT(DISTINCT session_id)::int s, COUNT(*) FILTER (WHERE evento='add_to_cart')::int atc
      FROM site_eventos WHERE ${HOJE} GROUP BY 1 ORDER BY 1`);
  for (const h of horas.rows) console.log(`  ${String(h.h).padStart(2)}h  ${'#'.repeat(Math.min(h.s,60))} ${h.s} sessões${h.atc ? ` | ${h.atc} sacola(s)` : ''}`);

  console.log('\n══ 7. FUNIL POR SESSÃO ══');
  const funil = await db.query(`
    SELECT COUNT(DISTINCT session_id)::int sessoes,
           COUNT(DISTINCT session_id) FILTER (WHERE evento='view_item')::int viram,
           COUNT(DISTINCT session_id) FILTER (WHERE evento='add_to_cart')::int sacola,
           COUNT(DISTINCT session_id) FILTER (WHERE evento='begin_checkout')::int checkout
      FROM site_eventos WHERE ${HOJE} AND session_id IS NOT NULL`);
  const f = funil.rows[0];
  console.log(`  ${f.sessoes} sessões → ${f.viram} viram peça → ${f.sacola} sacola → ${f.checkout} checkout`);

  console.log('\n══ 8. O QUE AS SESSÕES COM SACOLA FIZERAM ══');
  const sac = await db.query(`
    SELECT session_id, evento, path, valor, criado_em AT TIME ZONE 'America/Sao_Paulo' t
      FROM site_eventos
     WHERE ${HOJE} AND session_id IN (SELECT DISTINCT session_id FROM site_eventos WHERE ${HOJE} AND evento IN ('add_to_cart','begin_checkout'))
     ORDER BY session_id, criado_em`);
  let last = null;
  for (const s of sac.rows) {
    if (s.session_id !== last) { console.log(`  ── sessão ${s.session_id.slice(0, 8)}…`); last = s.session_id; }
    console.log(`     ${s.t.toISOString().slice(11, 16)} ${s.evento.padEnd(16)} ${s.valor ? 'R$' + s.valor : ''} ${(s.path || '').slice(0, 70)}`);
  }

  console.log('\n══ 9. PEDIDOS DO ECOMMERCE (7 dias) ══');
  const ped = await db.query(`
    SELECT wc_order_number, customer_name, total_amount, status, paid_at IS NOT NULL pago,
           created_at AT TIME ZONE 'America/Sao_Paulo' criado
      FROM orders WHERE source='ecommerce' AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC`);
  for (const p of ped.rows) console.log(`  ${p.wc_order_number} | ${p.customer_name} | R$ ${p.total_amount} | ${p.status}${p.pago ? ' ✅ PAGO' : ''} | ${p.criado.toISOString().slice(5, 16).replace('T', ' ')}`);

  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
