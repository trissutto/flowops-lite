const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  await db.connect();
  const r = await db.query(`SELECT LEFT(id,8) id, nome, status, total, enviados, falhas, to_char(criado_em AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo','HH24:MI') criado FROM whatsapp_campaigns ORDER BY criado_em DESC LIMIT 5`);
  r.rows.forEach(x=>console.log(`  ${x.criado} | ${x.status.padEnd(9)} | ${x.enviados}/${x.total} enviados${x.falhas?` · ${x.falhas} falhas`:''} | ${x.nome}`));
  await db.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
