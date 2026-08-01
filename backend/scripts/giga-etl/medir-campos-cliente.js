/**
 * O que a ficha de cliente do Giga tem, e o que o Flow já cobre?
 *
 * O PDV manda "cadastre no Wincred antes de fazer crediário" — num Wincred que
 * ninguém usa mais. Antes de construir o cadastro no Flow, saber exatamente
 * quais campos existem, quais são realmente PREENCHIDOS e quais já têm lugar
 * no Postgres.
 *
 * Campo que existe mas está vazio em 95% das fichas não precisa ir pra tela.
 * Campo usado de verdade e sem lugar no Flow é o que define o trabalho.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-campos-cliente.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  const [cols] = await my.query('SHOW COLUMNS FROM `clientes`');
  const [[tot]] = await my.query('SELECT COUNT(*) AS n FROM `clientes`');
  console.log(`fichas no Giga: ${nf(tot.n)} · colunas: ${cols.length}`);

  // O que o espelho do Flow ja tem.
  const espelho = await pg.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'giga_clientes'`,
  );
  const noFlow = new Set(espelho.rows.map((r) => String(r.column_name).toLowerCase().replace(/_/g, '')));

  console.log('');
  console.log('--- CAMPOS, POR QUANTO SAO USADOS ---');
  console.log('  preenchido  campo               tipo                no espelho?');

  const linhas = [];
  for (const c of cols) {
    const nome = String(c.Field);
    let preenchidos = 0;
    try {
      const [[r]] = await my.query(
        `SELECT COUNT(*) AS n FROM \`clientes\`
          WHERE \`${nome}\` IS NOT NULL AND TRIM(\`${nome}\`) <> '' AND TRIM(\`${nome}\`) <> '0'`,
      );
      preenchidos = Number(r.n);
    } catch { preenchidos = -1; }
    const pct = Number(tot.n) ? (preenchidos / Number(tot.n)) * 100 : 0;
    linhas.push({ nome, tipo: String(c.Type), pct, temNoFlow: noFlow.has(nome.toLowerCase().replace(/_/g, '')) });
  }

  linhas.sort((a, b) => b.pct - a.pct);
  for (const l of linhas) {
    const barra = l.pct >= 50 ? '#####' : l.pct >= 10 ? '##   ' : l.pct >= 1 ? '#    ' : '     ';
    console.log(
      `  ${String(l.pct.toFixed(1) + '%').padStart(7)} ${barra} ${l.nome.padEnd(20)} ${l.tipo.padEnd(18)} ${l.temNoFlow ? 'sim' : 'NAO'}`,
    );
  }

  const usados = linhas.filter((l) => l.pct >= 1);
  const faltando = usados.filter((l) => !l.temNoFlow);
  console.log('');
  console.log('=========================================');
  console.log(`  campos realmente usados (>=1% das fichas): ${usados.length} de ${linhas.length}`);
  console.log(`  desses, SEM lugar no espelho do Flow: ${faltando.length}`);
  if (faltando.length) {
    console.log('    ' + faltando.map((f) => f.nome).join(', '));
  }

  // A numeracao: o CODIGO do cliente e por LOJA (o mesmo numero se repete).
  const [[m]] = await my.query(
    'SELECT COUNT(DISTINCT LOJA) AS lojas, MAX(CAST(CODIGO AS UNSIGNED)) AS maxcod FROM `clientes`',
  );
  console.log('');
  console.log('--- NUMERACAO ---');
  console.log(`  lojas distintas: ${m.lojas} · maior CODIGO: ${nf(m.maxcod)}`);
  console.log('  (o CODIGO se repete entre lojas — a chave e LOJA+CODIGO)');

  await pg.end();
  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
