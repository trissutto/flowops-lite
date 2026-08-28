/** O deploy do escudo chegou? A tabela checkout_bloqueios existe + ritmo atual. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const t = await db.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='checkout_bloqueios') tabela`,
  );
  console.log('tabela checkout_bloqueios existe:', t.rows[0].tabela);
  if (t.rows[0].tabela) {
    const b = await db.query(`SELECT COUNT(*)::int bloqueios FROM checkout_bloqueios`);
    console.log('bloqueios registrados:', b.rows[0].bloqueios);
  }
  const pf = await db.query(
    `SELECT COUNT(*)::int novos_failed_30min FROM orders
      WHERE status='payment_failed' AND created_at > NOW() - INTERVAL '30 minutes'`,
  );
  console.log('payment_failed novos (30min):', pf.rows[0].novos_failed_30min);
  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
