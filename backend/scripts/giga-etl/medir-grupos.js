/**
 * Cabe uma faixa reservada pro Flow em grupos/subgrupos?
 *
 * Hoje `inserirGrupo`/`inserirSubgrupo` fazem MAX(CODIGO)+1 FOR UPDATE direto
 * no Giga — é a última coisa que impede cadastrar produto com categoria nova
 * quando o Giga está fora. Pro Flow numerar, precisa de faixa própria que:
 *   1. caiba no tipo da coluna;
 *   2. fique longe do que o Giga já usou;
 *   3. caiba TAMBÉM em `produtos.GRUPO`/`SUBGRUPO`, que é quem referencia —
 *      adiantaria pouco o código caber em `grupos` e estourar no produto.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-grupos.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const TETOS = {
  tinyint: [127, 255],
  smallint: [32767, 65535],
  mediumint: [8388607, 16777215],
  int: [2147483647, 4294967295],
};

const tetoDe = (tipo) => {
  const base = tipo.toLowerCase().split('(')[0].trim();
  const uns = /unsigned/i.test(tipo);
  return TETOS[base] ? TETOS[base][uns ? 1 : 0] : null;
};

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  const limites = [];

  for (const [tabela, col] of [['grupos', 'CODIGO'], ['subgrupos', 'CODIGO']]) {
    const [cols] = await my.query(`SHOW COLUMNS FROM \`${tabela}\``);
    const c = cols.find((x) => String(x.Field).toUpperCase() === col);
    const [[m]] = await my.query(
      `SELECT COUNT(*) AS n, MAX(CAST(\`${col}\` AS UNSIGNED)) AS mx FROM \`${tabela}\``,
    );
    const teto = c ? tetoDe(String(c.Type)) : null;
    console.log('');
    console.log(`=== ${tabela}.${col} ===`);
    console.log(`  tipo:   ${c ? c.Type : '(nao achou)'}`);
    console.log(`  teto:   ${teto ? nf(teto) : '?'}`);
    console.log(`  linhas: ${nf(m.n)}   maior codigo: ${nf(m.mx)}`);
    if (teto) limites.push({ onde: `${tabela}.${col}`, teto, usado: Number(m.mx) });
  }

  // Quem REFERENCIA o grupo — o gargalo real pode estar aqui.
  const [pcols] = await my.query('SHOW COLUMNS FROM `produtos`');
  for (const nome of ['GRUPO', 'SUBGRUPO']) {
    const c = pcols.find((x) => String(x.Field).toUpperCase() === nome);
    if (!c) continue;
    const teto = tetoDe(String(c.Type));
    console.log('');
    console.log(`=== produtos.${nome} (referencia) ===`);
    console.log(`  tipo: ${c.Type}   teto: ${teto ? nf(teto) : '?'}`);
    if (teto) limites.push({ onde: `produtos.${nome}`, teto, usado: 0 });
  }

  // O teto REAL é o menor de todos — a corrente arrebenta no elo mais fraco.
  const menor = limites.reduce((a, b) => (b.teto < a.teto ? b : a), limites[0]);
  const maiorUsado = Math.max(...limites.map((l) => l.usado));

  console.log('');
  console.log('=========================================');
  console.log(`Elo mais fraco: ${menor.onde} (teto ${nf(menor.teto)})`);
  console.log(`Maior codigo em uso: ${nf(maiorUsado)}`);

  // Faixa sugerida: bem acima do uso, bem abaixo do teto. Redonda pra ficar
  // obvio na tela que aquele codigo nasceu no Flow.
  const candidatas = [9000, 5000, 1000, 500];
  const escolhida = candidatas.find((c) => c > maiorUsado * 2 && c < menor.teto * 0.9);
  if (escolhida) {
    console.log(`>> Faixa sugerida pro Flow: a partir de ${nf(escolhida)}`);
    console.log(`   (${nf(escolhida - maiorUsado)} acima do uso atual, ${nf(menor.teto - escolhida)} de folga ate o teto)`);
  } else {
    console.log('>> Nenhuma faixa redonda serve — decidir manualmente.');
  }

  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
