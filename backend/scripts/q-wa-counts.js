const { Client } = require('pg');
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });
  await db.connect();
  for (const tb of ['whatsapp_leads','live_manychat_subscribers','site_lead','site_chats']) {
    try {
      const c = await db.query(`SELECT COUNT(*)::int n FROM ${tb}`);
      const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`,[tb]);
      console.log(`${tb}: ${c.rows[0].n} linhas | cols: ${cols.rows.map(r=>r.column_name).join(',')}`);
    } catch(e){ console.log(`${tb}: erro ${e.message}`); }
  }
  // universo de telefones na base mestra de clientes (loja fisica + site)
  for (const tb of ['customers','Customer']) {
    try { const c = await db.query(`SELECT COUNT(*)::int n FROM "${tb}"`); console.log(`${tb}: ${c.rows[0].n} clientes`); } catch(e){}
  }
  await db.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
