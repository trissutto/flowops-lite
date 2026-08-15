const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const now = await db.query("SELECT NOW() AS utc, NOW() AT TIME ZONE 'America/Sao_Paulo' AS sp, current_setting('TimeZone') AS tz_db");
  console.log('NOW() (deveria ser ~agora UTC):', now.rows[0].utc.toISOString());
  console.log('NOW() em SP:', now.rows[0].sp.toISOString(), '(sem tz — é o horário de parede SP)');
  console.log('TimeZone do banco:', now.rows[0].tz_db);
  console.log('Node local:', new Date().toString());
  const col = await db.query("SELECT data_type FROM information_schema.columns WHERE table_name='site_lead' AND column_name='created_at'");
  console.log('\ntipo da coluna created_at:', col.rows[0]?.data_type);
  const l = await db.query("SELECT created_at AS raw, created_at AT TIME ZONE 'America/Sao_Paulo' AS sp FROM site_lead ORDER BY created_at DESC LIMIT 1");
  console.log('último lead — raw:', l.rows[0].raw.toISOString(), '| convertido SP:', l.rows[0].sp.toISOString());
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
