/**
 * Cria o cupom da campanha do VLM-222 (dono, 14/08/2026): R$ 50 fixo, que leva
 * o Vestido Viscolycra Premium de R$ 189,90 pra R$ 139,90. Aditivo — não toca
 * nos cupons existentes (BEMVINDA10 etc). Reversível: ativo=false.
 *
 *   railway run --service Postgres node backend/scripts/criar-cupom-vestido139.js
 */
const { Client } = require('pg');

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const fim = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 dias

  const r = await db.query(
    `INSERT INTO site_cupons (code, label, tipo, valor, min_subtotal, primeira_compra, categorias, inicio_em, fim_em, uso_maximo, usos, ativo, cpf, origem)
       VALUES ('VESTIDO139', 'R$ 50 off — o vestido por R$ 139,90', 'fixed', 50, 179.9, false, NULL, NOW(), $1, NULL, 0, true, NULL, 'campanha')
     ON CONFLICT (code) DO UPDATE SET
       label = EXCLUDED.label, tipo = EXCLUDED.tipo, valor = EXCLUDED.valor,
       min_subtotal = EXCLUDED.min_subtotal, fim_em = EXCLUDED.fim_em, ativo = true
     RETURNING code, tipo, valor, min_subtotal, fim_em, ativo`,
    [fim],
  );
  console.log('══ CUPOM CRIADO/ATUALIZADO ══');
  console.log(r.rows[0]);

  // Confere que os cupons antigos continuam lá
  const todos = await db.query(`SELECT code, tipo, valor, ativo FROM site_cupons ORDER BY code`);
  console.log('\n══ TODOS OS CUPONS ══');
  for (const c of todos.rows) console.log(`  ${c.code.padEnd(14)} ${c.tipo.padEnd(8)} ${c.valor} · ${c.ativo ? 'ativo' : 'inativo'}`);

  await db.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
