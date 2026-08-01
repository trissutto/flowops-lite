/**
 * Qual coluna de preço o Giga usa hoje — e o ÷100 está certo ou errado?
 *
 * `getProductPricesBySkus` escolhe a primeira coluna que existir, nesta ordem:
 *   PRECOVENDA, PRECO_VENDA, PRECO, VENDA, VENDAUN
 * e DIVIDE POR 100 se a escolhida for VENDAUN, com o comentário "VENDAUN é em
 * centavos".
 *
 * Isso decide se dá pra ligar GIGA_LEITURA_FLOW: o espelho não divide, então
 * se o Giga estiver dividindo o preço muda 100× ao virar a flag.
 *
 * O teste: comparar, para as MESMAS peças, o valor da coluna escolhida no Giga
 * com o `vendaUn` do espelho — que a documentação afirma estar em reais. Se
 * forem iguais, o ÷100 está sobrando e hoje o preço sai 100× menor.
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/medir-coluna-preco.js
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const CANDIDATAS = ['PRECOVENDA', 'PRECO_VENDA', 'PRECO', 'VENDA', 'VENDAUN'];
const brl = (n) => 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  const [cols] = await my.query('SHOW COLUMNS FROM `produtos`');
  const existentes = cols.map((c) => String(c.Field).toUpperCase());
  console.log('--- CANDIDATAS A COLUNA DE PRECO ---');
  for (const c of CANDIDATAS) {
    console.log(`  ${c.padEnd(12)} ${existentes.includes(c) ? 'EXISTE' : '—'}`);
  }
  const escolhida = CANDIDATAS.find((c) => existentes.includes(c));
  console.log('');
  console.log(`  >> pickCol escolhe: ${escolhida || '(nenhuma!)'}`);
  const divide = String(escolhida || '').toUpperCase() === 'VENDAUN';
  console.log(`  >> divide por 100:  ${divide ? 'SIM' : 'nao'}`);

  if (!escolhida) { await my.end(); return; }

  // Compara com o espelho, que a documentacao diz estar em REAIS.
  const [amostra] = await my.query(
    `SELECT CODIGO, \`${escolhida}\` AS preco FROM \`produtos\`
      WHERE \`${escolhida}\` > 0 ORDER BY CODIGO DESC LIMIT 12`,
  );
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  console.log('');
  console.log('--- MESMAS PECAS: GIGA x ESPELHO ---');
  console.log('  codigo        coluna Giga   apos ÷100    espelho vendaUn');
  let batemSemDividir = 0, batemDividindo = 0, comparados = 0;
  for (const r of amostra) {
    const cod = String(r.CODIGO).replace(/^0+/, '') || '0';
    const q = await pg.query(
      `SELECT "vendaUn"::float AS v FROM wincred_produtos
        WHERE COALESCE(NULLIF(LTRIM(TRIM(codigo),'0'),''),'0') = $1 LIMIT 1`,
      [cod],
    );
    if (!q.rows.length) continue;
    comparados++;
    const bruto = Number(r.preco);
    const dividido = bruto / 100;
    const esp = Number(q.rows[0].v);
    if (Math.abs(bruto - esp) < 0.01) batemSemDividir++;
    if (Math.abs(dividido - esp) < 0.01) batemDividindo++;
    console.log(
      `  ${cod.padEnd(12)} ${brl(bruto).padStart(12)} ${brl(dividido).padStart(12)} ${brl(esp).padStart(16)}`,
    );
  }

  console.log('');
  console.log('=========================================');
  console.log(`  comparados: ${comparados}`);
  console.log(`  batem SEM dividir: ${batemSemDividir}   batem DIVIDINDO: ${batemDividindo}`);
  console.log('');
  if (!divide) {
    console.log('VEREDITO: a coluna escolhida NAO e VENDAUN, entao o ÷100 nem roda.');
    console.log('Ligar GIGA_LEITURA_FLOW nao muda a escala do preco — e seguro');
    console.log('por este lado.');
  } else if (batemSemDividir > batemDividindo) {
    console.log('VEREDITO: o ÷100 esta SOBRANDO. O valor cru do Giga ja bate com');
    console.log('o espelho, entao HOJE o preco sai 100x MENOR do que deveria.');
    console.log('Ligar a flag CORRIGE — mas e mudanca de valor financeiro, e o');
    console.log('acerto intercompany vai mudar de patamar. Avisar quem confere.');
  } else {
    console.log('VEREDITO: o ÷100 esta CERTO — o valor cru e centavo mesmo.');
    console.log('NAO ligar a flag sem antes fazer o espelho dividir tambem,');
    console.log('senao o preco sai 100x MAIOR.');
  }

  await pg.end();
  await my.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
