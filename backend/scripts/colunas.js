/**
 * Lista as colunas REAIS de uma tabela do Postgres.
 *
 * Existe porque o Prisma cria coluna com o nome do CAMPO quando não há @map —
 * e campo camelCase vira coluna camelCase ENTRE ASPAS no Postgres, não
 * snake_case. Escrever SQL cru chutando o nome gera "column does not exist"
 * no meio de uma migração, que é o pior momento pra descobrir isso.
 *
 * Uso: railway run --service Postgres -- node scripts/colunas.js wincred_produtos
 */

const { Client } = require('pg');

(async () => {
  const tabela = process.argv[2] || 'wincred_produtos';
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();
  const r = await c.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = $1 ORDER BY ordinal_position`,
    [tabela],
  );
  console.log(`Tabela ${tabela} — ${r.rows.length} colunas:`);
  for (const x of r.rows) console.log(`  ${x.column_name}  (${x.data_type})`);
  await c.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
