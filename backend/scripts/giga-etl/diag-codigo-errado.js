/**
 * O código bipado devolve a peça errada. É dado trocado ou busca errada?
 *
 * Caso: digitaram 11186885 (etiqueta de uma CALCINHA) na Consultar e apareceu
 * "BLUSA FEMININA MANGA LONGA PLUS SIZE 207030 MARRIE".
 *
 * Três explicações possíveis, e cada uma exige ação diferente:
 *   a) o CODIGO 11186885 é mesmo a blusa nos dois bancos → a etiqueta física
 *      está errada / foi reaproveitada;
 *   b) é a calcinha no Giga e a blusa no espelho → o espelho está torto;
 *   c) é a calcinha nos dois → a BUSCA está resolvendo errado (tratou como REF,
 *      casou parcial, ou padding de zero).
 *
 * Só faz SELECT.
 *
 * Uso (da RAIZ do repo):
 *   railway run --service Postgres -- node backend/scripts/giga-etl/diag-codigo-errado.js [codigo]
 */

const path = require('path');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..', '..'), '.env'), override: false });

const COD = String(process.argv[2] || '11186885').replace(/\D/g, '');

(async () => {
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST, port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER, password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });
  const pg = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await pg.connect();

  console.log(`Codigo consultado: ${COD}`);

  console.log('');
  console.log('--- NO GIGA (produtos) ---');
  const [g] = await my.query(
    `SELECT CODIGO, REF, COR, TAMANHO, DESCRICAOCOMPLETA, VENDAUN, DATAALT
       FROM produtos WHERE CAST(CODIGO AS UNSIGNED) = ? LIMIT 3`,
    [Number(COD)],
  );
  if (!g.length) console.log('  (nao existe)');
  for (const r of g) {
    console.log(`  codigo=${r.CODIGO} ref=${r.REF} ${r.COR}/${r.TAMANHO}`);
    console.log(`    ${r.DESCRICAOCOMPLETA}`);
    console.log(`    R$ ${r.VENDAUN} · alterado em ${String(r.DATAALT).slice(0, 15)}`);
  }

  console.log('');
  console.log('--- NO ESPELHO DO FLOW (wincred_produtos) ---');
  const f = await pg.query(
    `SELECT codigo, ref, cor, tamanho, "descricaoCompleta", "vendaUn", "dataAlt"
       FROM wincred_produtos
      WHERE COALESCE(NULLIF(LTRIM(TRIM(codigo),'0'),''),'0') = $1 LIMIT 3`,
    [String(Number(COD))],
  );
  if (!f.rows.length) console.log('  (nao existe)');
  for (const r of f.rows) {
    console.log(`  codigo=${r.codigo} ref=${r.ref} ${r.cor}/${r.tamanho}`);
    console.log(`    ${r.descricaoCompleta}`);
    console.log(`    R$ ${r.vendaUn} · alterado em ${String(r.dataAlt).slice(0, 15)}`);
  }

  // A busca pode ter tratado o numero como REF. Existe REF assim?
  console.log('');
  console.log('--- ALGUEM TEM ESSE NUMERO COMO *REF*? ---');
  const porRef = await pg.query(
    `SELECT ref, COUNT(*)::int AS n,
            (ARRAY_AGG("descricaoCompleta"))[1] AS exemplo
       FROM wincred_produtos WHERE ref = $1 GROUP BY 1`,
    [COD],
  );
  if (!porRef.rows.length) console.log('  (ninguem — entao nao foi confundido com REF exata)');
  for (const r of porRef.rows) console.log(`  ref=${r.ref} · ${r.n} peca(s) · ${r.exemplo}`);

  // E casamento PARCIAL? (o que explicaria cair numa peca sem relacao)
  const parcial = await pg.query(
    `SELECT codigo, ref, "descricaoCompleta" FROM wincred_produtos
      WHERE codigo LIKE '%' || $1 || '%' OR ref LIKE '%' || $1 || '%' LIMIT 5`,
    [COD],
  );
  console.log('');
  console.log('--- CASAMENTO PARCIAL (codigo ou ref CONTENDO o numero) ---');
  for (const r of parcial.rows) {
    console.log(`  codigo=${r.codigo} ref=${r.ref} · ${String(r.descricaoCompleta).slice(0, 50)}`);
  }

  // A REF que apareceu na tela — o que ela e?
  console.log('');
  console.log('--- A REF 207030 QUE APARECEU NA TELA ---');
  const ref = await pg.query(
    `SELECT codigo, cor, tamanho, "descricaoCompleta" FROM wincred_produtos
      WHERE ref = '207030' ORDER BY codigo LIMIT 6`,
  );
  for (const r of ref.rows) {
    console.log(`  codigo=${r.codigo} ${r.cor}/${r.tamanho} · ${String(r.descricaoCompleta).slice(0, 46)}`);
  }

  await my.end();
  await pg.end();
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
