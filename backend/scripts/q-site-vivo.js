/**
 * O site_eventos está gravando AGORA? Serve pra saber se um número parado é
 * "ninguém entrou" ou "a medição travou".
 * Uso: railway run --service Postgres node backend/scripts/q-site-vivo.js
 */
const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const r = await db.query(`
    SELECT COUNT(*) FILTER (WHERE criado_em >= NOW() - interval '10 minutes') AS ult10,
           COUNT(*) FILTER (WHERE criado_em >= NOW() - interval '60 minutes') AS ult60,
           MAX(criado_em) AS ultimo
      FROM site_eventos`);
  const { ult10, ult60, ultimo } = r.rows[0];
  console.log(`site_eventos: ${ult10} eventos nos últimos 10min · ${ult60} na última hora`);
  console.log(`último evento: ${ultimo ? new Date(ultimo).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—'}`);
  const p = await db.query(`
    SELECT path, COUNT(DISTINCT session_id) AS pessoas
      FROM site_eventos WHERE criado_em >= NOW() - interval '60 minutes'
     GROUP BY path ORDER BY pessoas DESC LIMIT 8`);
  console.log('\npáginas mais vistas na última hora:');
  for (const x of p.rows) console.log(`  ${String(x.pessoas).padStart(4)} · ${String(x.path).slice(0, 70)}`);
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
