/**
 * Quantos telefones dá pra alcançar de verdade — e quantos são celular
 * (WhatsApp só existe em celular: DDD + 9 dígitos).
 *
 * Uso: railway run --service Postgres node backend/scripts/q-base-whatsapp.js
 */
const { Client } = require('pg');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const q = async (sql) => (await db.query(sql)).rows;

  // Normaliza: só dígitos, tira +55, e exige 11 dígitos com o 9 na frente.
  const CEL = `regexp_replace(COALESCE(NULLIF(%COL%, ''), ''), '\\D', '', 'g')`;

  const tabelas = [
    ['customers', 'phone'],
    ['orders', 'customer_phone'],
    ['site_lead', 'telefone'],
  ];

  console.log('══ BASE DE TELEFONE (nosso Postgres) ══');
  const todos = new Set();
  for (const [tab, col] of tabelas) {
    try {
      const rows = await q(`
        SELECT DISTINCT regexp_replace(${col}, '\\D', '', 'g') AS tel
          FROM ${tab} WHERE ${col} IS NOT NULL AND ${col} <> ''`);
      const cels = rows
        .map((r) => String(r.tel).replace(/^55/, ''))
        .filter((t) => t.length === 11 && t[2] === '9');
      cels.forEach((c) => todos.add(c));
      console.log(`  ${tab.padEnd(12)} ${String(rows.length).padStart(7)} telefones · ${String(cels.length).padStart(7)} celulares válidos`);
    } catch (e) {
      console.log(`  ${tab.padEnd(12)} (não existe ou sem coluna: ${String(e.message).slice(0, 45)})`);
    }
  }
  console.log(`\n  CELULARES ÚNICOS ALCANÇÁVEIS: ${todos.size}`);

  await db.end();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
