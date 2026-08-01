/**
 * Faixa reservada pro Flow em `fornecedores`, e o formato real das colunas.
 *
 * Mesma disciplina de grupos/subgrupos: antes de escolher a faixa, medir o que
 * o Giga já usa, o teto do tipo e — o que costuma ser o elo fraco — o tipo da
 * coluna que REFERENCIA o fornecedor em `produtos`.
 *
 * Também lista os campos com tamanho real, porque a tela de cadastro precisa
 * validar antes de gravar: CNPJ truncado no meio vira fornecedor duplicado.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-fornecedores.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const TETOS = { tinyint: 127, smallint: 32767, mediumint: 8388607, int: 2147483647, bigint: 9223372036854775807 };
const tetoDe = (tipo) => {
  const base = String(tipo).toLowerCase().split('(')[0].trim();
  const t = TETOS[base];
  return t ? (/unsigned/i.test(tipo) ? t * 2 + 1 : t) : null;
};

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  console.log('--- COLUNAS DE `fornecedores` ---');
  const [cols] = await my.query('SHOW COLUMNS FROM `fornecedores`');
  for (const c of cols) {
    console.log(`  ${String(c.Field).padEnd(16)} ${String(c.Type).padEnd(16)} ${c.Null === 'YES' ? 'aceita NULL' : 'NOT NULL'}${c.Key ? '  [' + c.Key + ']' : ''}`);
  }

  const codCol = cols.find((c) => String(c.Field).toUpperCase() === 'CODIGO');
  const [[m]] = await my.query(
    'SELECT COUNT(*) AS n, MAX(CAST(`CODIGO` AS UNSIGNED)) AS mx FROM `fornecedores`',
  );
  const teto = codCol ? tetoDe(codCol.Type) : null;
  console.log('');
  console.log('--- NUMERACAO ---');
  console.log(`  fornecedores cadastrados: ${nf(m.n)}`);
  console.log(`  maior CODIGO em uso:      ${nf(m.mx)}`);
  console.log(`  tipo/teto:                ${codCol ? codCol.Type : '?'} / ${teto ? nf(teto) : '?'}`);

  // Elo fraco: quem referencia o fornecedor.
  const [pcols] = await my.query('SHOW COLUMNS FROM `produtos`');
  const ref = pcols.find((c) => /^(codfornecedor|fornecedor)$/i.test(String(c.Field)));
  if (ref) {
    const tRef = tetoDe(ref.Type);
    console.log(`  produtos.${ref.Field}: ${ref.Type} / teto ${tRef ? nf(tRef) : 'texto'}`);
    if (tRef && teto) {
      const menor = Math.min(tRef, teto);
      console.log(`  >> teto REAL da faixa: ${nf(menor)} (o menor dos dois)`);
      const cand = [90000, 9000, 5000].find((c) => c > Number(m.mx) * 2 && c < menor * 0.9);
      console.log(cand
        ? `  >> faixa sugerida: a partir de ${nf(cand)} (${nf(cand - Number(m.mx))} acima do uso)`
        : '  >> nenhuma faixa redonda cabe — decidir manualmente');
    }
  }

  // Duplicidade de CNPJ hoje: se ja existe, a tela nao pode barrar por unicidade.
  const [[dup]] = await my.query(
    "SELECT COUNT(*) AS n FROM (SELECT CNPJ FROM `fornecedores` WHERE COALESCE(CNPJ,'') <> '' GROUP BY CNPJ HAVING COUNT(*) > 1) t",
  );
  const [[semCnpj]] = await my.query(
    "SELECT COUNT(*) AS n FROM `fornecedores` WHERE COALESCE(CNPJ,'') = ''",
  );
  console.log('');
  console.log('--- QUALIDADE DO CADASTRO ATUAL ---');
  console.log(`  CNPJs repetidos: ${nf(dup.n)}   sem CNPJ: ${nf(semCnpj.n)}`);
  if (Number(dup.n) || Number(semCnpj.n)) {
    console.log('  >> a tela NAO pode exigir CNPJ unico nem obrigatorio:');
    console.log('     o cadastro atual ja viola as duas regras e travaria a edicao.');
  }

  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
