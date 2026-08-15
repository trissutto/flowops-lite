/**
 * DIAGNÓSTICO — 900895 MARINHO: o marinho existe como 900892M. Conferir estoque.
 *
 *   railway run --service Postgres node backend/scripts/diag-900895-marinho.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('════════ estoque da 900892M (VESTIDO MARINHO JOIN CURVES) ════════');
  const r = await db.query(
    `SELECT p.codigo, p.tamanho, e.loja, e.estoque
       FROM wincred_produtos p
       JOIN wincred_estoque e ON e.codigo = p.codigo
      WHERE p.ref = '900892M' AND e.estoque <> 0
      ORDER BY p.tamanho, e.loja`,
  );
  for (const x of r.rows) {
    console.log(`  cod=${String(x.codigo).padEnd(8)} tam=${String(x.tamanho).padEnd(4)} loja=${String(x.loja).padEnd(4)} qtd=${x.estoque}`);
  }
  console.log(`  total: ${r.rows.length} linhas com estoque`);

  console.log('\n════════ estoque das irmãs 900895 / 900895A ════════');
  const r2 = await db.query(
    `SELECT p.ref, p.codigo, p.tamanho, e.loja, e.estoque
       FROM wincred_produtos p
       JOIN wincred_estoque e ON e.codigo = p.codigo
      WHERE p.ref IN ('900895', '900895A') AND e.estoque <> 0
      ORDER BY p.ref, p.tamanho, e.loja`,
  );
  for (const x of r2.rows) {
    console.log(`  ref=${String(x.ref).padEnd(9)} cod=${String(x.codigo).padEnd(8)} tam=${String(x.tamanho).padEnd(4)} loja=${String(x.loja).padEnd(4)} qtd=${x.estoque}`);
  }
  console.log(`  total: ${r2.rows.length} linhas com estoque`);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
