const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const total = await db.query('SELECT COUNT(*)::int n FROM site_lead');
  const hoje = await db.query(`SELECT COUNT(*)::int n FROM site_lead WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`);
  const sem = await db.query(`SELECT COUNT(*)::int n FROM site_lead WHERE created_at > NOW() - INTERVAL '7 days'`);
  console.log('══ CADASTROS DO POPUP (site_lead) ══');
  console.log('  TOTAL:', total.rows[0].n);
  console.log('  HOJE:', hoje.rows[0].n);
  console.log('  ÚLTIMOS 7 DIAS:', sem.rows[0].n);
  console.log('\n══ POR DIA (últimos 10 dias) ══');
  const dia = await db.query(`SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date d, COUNT(*)::int n FROM site_lead WHERE created_at > NOW() - INTERVAL '10 days' GROUP BY 1 ORDER BY 1 DESC`);
  for (const r of dia.rows) console.log(`  ${r.d.toISOString().slice(0,10)}  ${r.n}`);
  console.log('\n══ ÚLTIMOS 5 CADASTROS ══');
  const u = await db.query(`SELECT nome, telefone, email, origem, (created_at AT TIME ZONE 'America/Sao_Paulo') h FROM site_lead ORDER BY created_at DESC LIMIT 5`);
  for (const r of u.rows) console.log(`  ${r.h.toISOString().slice(5,16).replace('T',' ')} · ${r.nome} · ${r.telefone} · ${r.origem||'-'}`);
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
