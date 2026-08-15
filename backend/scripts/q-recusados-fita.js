// Fita completa dos 3 recusados, com hora de BRASÍLIA (não UTC).
const { Client } = require('pg');
const SIDS = ['736f18b6', '18674beb', '0893fb6d'];
(async () => {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  for (const sid of SIDS) {
    const r = await db.query(
      `SELECT evento, path, valor, dados,
              to_char(criado_em AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI:SS') hora_br
         FROM site_eventos
        WHERE session_id LIKE $1 AND criado_em > NOW() - INTERVAL '3 days'
        ORDER BY criado_em`, [sid + '%']);
    console.log(`\n═══ sessão ${sid} (${r.rows.length} eventos) — hora Brasília ═══`);
    for (const e of r.rows) {
      const d = typeof e.dados === 'string' ? e.dados : JSON.stringify(e.dados || {});
      console.log(`  ${e.hora_br}  ${String(e.evento).padEnd(24)} ${e.path || ''} ${e.valor ? '$' + e.valor : ''} ${d !== '{}' ? d : ''}`);
    }
  }
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
