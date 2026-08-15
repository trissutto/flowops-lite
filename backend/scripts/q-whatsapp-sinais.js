// O que o NOSSO banco sabe sobre interação de WhatsApp / telefones de cliente.
const { Client } = require('pg');
(async () => {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // tabelas que cheiram a whatsapp/chat/conversa
  const t = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public'
        AND (table_name ILIKE '%whats%' OR table_name ILIKE '%chat%' OR table_name ILIKE '%conversa%'
             OR table_name ILIKE '%mensagem%' OR table_name ILIKE '%evolution%' OR table_name ILIKE '%lead%')
      ORDER BY table_name`);
  console.log('tabelas relacionadas:', t.rows.map(r => r.table_name).join(', ') || '(nenhuma)');

  // sinais de whatsapp no site_eventos e site_store_clicks
  const ev = await db.query(
    `SELECT COUNT(*)::int n, COUNT(DISTINCT session_id)::int pessoas
       FROM site_eventos WHERE evento ILIKE '%whats%'`).catch(e => ({ rows: [{ n: 'erro', pessoas: e.message }] }));
  console.log('\nsite_eventos whatsapp:', JSON.stringify(ev.rows[0]));

  const sc = await db.query(
    `SELECT COUNT(*)::int cliques FROM site_store_clicks WHERE tipo ILIKE '%whats%' OR canal ILIKE '%whats%'`)
    .catch(async () => {
      const c = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='site_store_clicks'`);
      return { rows: [{ cliques: '(cols: ' + c.rows.map(r => r.column_name).join(',') + ')' }] };
    });
  console.log('site_store_clicks whatsapp:', JSON.stringify(sc.rows[0]));

  // base de clientes com telefone (universo pra cruzar)
  const cust = await db.query(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE customer_phone IS NOT NULL AND LENGTH(regexp_replace(customer_phone,'\\D','','g'))>=10)::int com_tel
       FROM orders WHERE source='ecommerce'`).catch(e => ({ rows: [{ total: 'erro', com_tel: e.message }] }));
  console.log('\npedidos ecommerce com telefone:', JSON.stringify(cust.rows[0]));

  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
