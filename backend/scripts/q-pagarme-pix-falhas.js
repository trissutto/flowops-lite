// Erros de PIX (Pagar.me) do site — hoje, hora de Brasília.
const { Client } = require('pg');
(async () => {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  // descobre a tabela
  const t = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name ILIKE '%pagarme%'`);
  console.log('tabelas pagarme:', t.rows.map(r => r.table_name).join(', ') || '(nenhuma)');
  const tabela = t.rows.map(r => r.table_name).find(n => n.includes('payment')) || t.rows[0]?.table_name;
  if (!tabela) { console.log('sem tabela pagarme'); await db.end(); return; }
  const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [tabela]);
  console.log(`colunas de ${tabela}:`, cols.rows.map(r => r.column_name).join(', '));
  const has = (c) => cols.rows.some(r => r.column_name === c);
  const sel = ['id', has('sale_id') ? 'sale_id' : null, has('method') ? 'method' : null, has('status') ? 'status' : null,
    has('amount') ? 'amount' : null, has('gateway_status') ? 'gateway_status' : null,
    has('error') ? 'error' : null, has('last_error') ? 'last_error' : null, has('raw') ? 'raw' : null,
    has('raw_response') ? 'raw_response' : null, has('created_at') ? 'created_at' : null].filter(Boolean);
  const timeCol = has('created_at') ? 'created_at' : (has('createdAt') ? '"createdAt"' : null);
  const q = `SELECT ${sel.map(c => c === 'sale_id' ? 'sale_id' : c).join(', ')} FROM ${tabela}
             ${timeCol ? `WHERE ${timeCol} > NOW() - INTERVAL '2 days'` : ''}
             ORDER BY ${timeCol || 'id'} DESC LIMIT 40`;
  const r = await db.query(q);
  console.log(`\n${r.rows.length} pagamentos (2d):`);
  for (const row of r.rows) {
    const s = JSON.stringify(row);
    console.log('  ', s.length > 600 ? s.slice(0, 600) + '…' : s);
  }
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
