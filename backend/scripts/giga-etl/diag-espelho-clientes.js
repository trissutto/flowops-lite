/**
 * O espelho `giga_clientes` é mantido, ou está congelado?
 *
 * Antes de apontar o `customer-info` do PDV pra ele, tem que valer a pena: o
 * ganho é tirar até 9 consultas em cascata de cima do MySQL, mas se o espelho
 * estiver parado, a troca é "PDV lento" por "PDV mentindo" — e mentir sobre a
 * ficha do cliente é pior. Foi exatamente esse tipo de descuido que travou a
 * ficha do CRM em "Carregando..." antes.
 *
 * Compara contagem e amostra contra o Giga ao vivo. Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-espelho-clientes.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  // A tabela existe? Com que nome?
  const t = await pg.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 'giga_%' ORDER BY 1`,
  );
  console.log('--- ESPELHOS giga_* NO POSTGRES ---');
  for (const r of t.rows) console.log('  ' + r.table_name);

  const temClientes = t.rows.some((r) => r.table_name === 'giga_clientes');
  if (!temClientes) {
    console.log('');
    console.log('>> giga_clientes NAO EXISTE. Migrar customer-info pra ele e impossivel hoje.');
    await pg.end();
    return;
  }

  const cols = await pg.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='giga_clientes' ORDER BY ordinal_position`,
  );
  console.log('');
  console.log('--- COLUNAS de giga_clientes ---');
  console.log('  ' + cols.rows.map((c) => c.column_name).join(', '));

  const temSynced = cols.rows.some((c) => c.column_name === 'synced_at');
  const nPg = await pg.query('SELECT COUNT(*)::int AS n FROM giga_clientes');
  console.log('');
  console.log('--- VOLUME E IDADE ---');
  console.log(`  linhas no Postgres: ${nPg.rows[0].n.toLocaleString('pt-BR')}`);

  if (temSynced) {
    const d = await pg.query(
      `SELECT CASE
                WHEN synced_at > NOW() - INTERVAL '2 hours' THEN 'a. ate 2h'
                WHEN synced_at > NOW() - INTERVAL '2 days'  THEN 'b. 2h-2d'
                WHEN synced_at > NOW() - INTERVAL '15 days' THEN 'c. 2d-15d'
                ELSE 'd. mais de 15 dias' END AS faixa,
              COUNT(*)::int AS n
         FROM giga_clientes GROUP BY 1 ORDER BY 1`,
    );
    for (const r of d.rows) console.log(`  ${r.faixa}: ${r.n.toLocaleString('pt-BR')}`);
  } else {
    console.log('  (sem coluna synced_at — nao da pra medir idade por linha)');
  }

  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const [mr] = await my.query('SELECT COUNT(*) AS n FROM clientes');
  const nMy = Number(mr[0].n);
  console.log(`  linhas no Giga:     ${nMy.toLocaleString('pt-BR')}`);
  const falta = nMy - nPg.rows[0].n;
  console.log(`  diferenca:          ${falta.toLocaleString('pt-BR')} (${((falta / (nMy || 1)) * 100).toFixed(2)}%)`);

  // O veredito depende do DESENHO da migracao, nao so do numero:
  //
  //   COM recuo obrigatorio pro Giga em quem nao achar, cliente ausente do
  //   espelho so volta ao caminho de hoje — a migracao e ganho puro, e a
  //   cobertura diz que fracao fica rapida, nao o que quebra.
  //
  //   SEM recuo, cada ausente vira "cadastro nao encontrado" no meio da
  //   venda. Ai qualquer buraco e inaceitavel. Foi assim que a ficha do CRM
  //   travou em "Carregando..." — a lista mostrava um cliente que a ficha
  //   negava.
  const pctCobertura = 100 - Math.abs(falta / (nMy || 1)) * 100;
  console.log('');
  console.log(`>> Cobertura: ${pctCobertura.toFixed(2)}%`);
  console.log('   COM recuo pro Giga no miss: seguro — essa fracao fica rapida,');
  console.log('   o resto se comporta como hoje. O recuo e OBRIGATORIO, nao opcional.');
  if (pctCobertura < 99) {
    console.log(`   ATENCAO: ${Math.abs(falta)} clientes fora do espelho. Sem o recuo,`);
    console.log('   seriam "cadastro nao encontrado" no meio da venda.');
  }

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
