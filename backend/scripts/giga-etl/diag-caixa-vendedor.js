/**
 * Como o Giga guarda a VENDEDORA na tabela `caixa`?
 *
 * Necessário pra cruzar venda por vendedora entre Wincred e Flow no relatório
 * da contabilidade.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-caixa-vendedor.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  const [c] = await my.query('SHOW COLUMNS FROM `caixa`');
  console.log('--- COLUNAS DE caixa ---');
  console.log('  ' + c.map((x) => x.Field).join(', '));

  const vend = c.filter((x) => /vend|func|oper/i.test(String(x.Field)));
  console.log('');
  console.log('--- CANDIDATAS A VENDEDORA ---');
  for (const v of vend) console.log(`  ${v.Field}  ${v.Type}`);

  const [f] = await my.query('SHOW COLUMNS FROM `funcionarios`');
  console.log('');
  console.log('--- COLUNAS DE funcionarios ---');
  console.log('  ' + f.map((x) => x.Field).join(', '));

  // Amostra: como vem preenchido em julho?
  if (vend.length) {
    const col = 'VENDEDOR';
    const [amostra] = await my.query(
      `SELECT \`${col}\` AS v, COUNT(*) AS n FROM \`caixa\`
        WHERE DATA >= '2026-07-01' AND DATA < '2026-08-01'
        GROUP BY 1 ORDER BY n DESC LIMIT 8`,
    );
    console.log('');
    console.log(`--- VALORES DE ${col} EM JULHO ---`);
    for (const r of amostra) console.log(`  ${String(r.v === null ? '(null)' : r.v).padEnd(12)} ${r.n} linha(s)`);
  }

  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
