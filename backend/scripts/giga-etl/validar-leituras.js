/**
 * Valida as consultas NOVAS de leitura direto no Postgres, antes de qualquer
 * deploy — pega erro de nome de coluna, aspas e tipo na hora, em vez de no
 * meio do bipe da loja.
 *
 * Uso: railway run --service Postgres -- node scripts/giga-etl/validar-leituras.js
 */

const { Client } = require('pg');

const CONSULTAS = [
  {
    nome: 'resolveSkuInfo',
    sql: `SELECT p.codigo, p.ref, p.cor, p.tamanho,
                 COALESCE(NULLIF(TRIM(p."descricaoCompleta"),''), p."descricaoPdv") AS descricao
            FROM wincred_produtos p
           WHERE COALESCE(NULLIF(LTRIM(TRIM(p.codigo),'0'),''),'0') = $1
           LIMIT 1`,
    params: ['1'],
  },
  {
    nome: 'getProductPricesBySkus',
    sql: `SELECT COALESCE(NULLIF(LTRIM(TRIM(p.codigo),'0'),''),'0') AS nucleo,
                 p."vendaUn"::text AS preco
            FROM wincred_produtos p
           WHERE COALESCE(NULLIF(LTRIM(TRIM(p.codigo),'0'),''),'0') = ANY($1::text[])
           LIMIT 5`,
    params: [['1', '2']],
  },
  {
    nome: 'getStockByRefCorTamInStore',
    sql: `SELECT p.codigo, COALESCE(SUM(e.estoque),0)::text AS qtd
            FROM wincred_produtos p
            JOIN wincred_estoque e ON e.codigo = p.codigo AND e.loja = ANY($4::text[])
           WHERE UPPER(TRIM(COALESCE(p.ref,''))) = UPPER(TRIM($1))
             AND UPPER(TRIM(COALESCE(p.cor,''))) = UPPER(TRIM($2))
             AND UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($3))
           GROUP BY p.codigo`,
    params: ['X', 'Y', 'Z', ['01']],
  },
  {
    nome: 'findCodigoByRefCorTam (nivel 1)',
    sql: `SELECT p.codigo FROM wincred_produtos p
            LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
           WHERE UPPER(TRIM(COALESCE(p.ref,''))) = UPPER(TRIM($1))
             AND UPPER(TRIM(COALESCE(p.cor,''))) = UPPER(TRIM($2))
             AND UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($3))
           GROUP BY p.codigo
           ORDER BY COALESCE(SUM(e.estoque),0) DESC, p.codigo DESC LIMIT 1`,
    params: ['X', 'Y', 'Z'],
  },
  {
    nome: 'findCodigoByRefCorTam (nivel 4 - regex)',
    sql: `SELECT p.codigo FROM wincred_produtos p
            LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
           WHERE COALESCE(p.ref,'') ~ $1
             AND UPPER(TRIM(COALESCE(p.tamanho,''))) = UPPER(TRIM($2))
             AND (REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','') = $3
                  OR REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','') LIKE '%'||$3||'%'
                  OR $3 LIKE '%'||REPLACE(REPLACE(UPPER(COALESCE(p.cor,'')),' ',''),'-','')||'%')
           GROUP BY p.codigo
           ORDER BY COALESCE(SUM(e.estoque),0) DESC, p.codigo DESC LIMIT 1`,
    params: ['^900881[- ]?[A-Z]+$', 'M', 'OFFWHITE'],
  },
  {
    nome: 'batchFindCodigosByRefCorTam',
    sql: `SELECT COALESCE(p.ref,'') AS ref, COALESCE(p.cor,'') AS cor,
                 COALESCE(p.tamanho,'') AS tamanho, p.codigo,
                 COALESCE((SELECT SUM(e.estoque) FROM wincred_estoque e WHERE e.codigo = p.codigo),0)::text AS total_est
            FROM wincred_produtos p
           WHERE COALESCE(NULLIF(LTRIM(UPPER(TRIM(COALESCE(p.ref,''))),'0'),''),'0') = ANY($1::text[])
           LIMIT 5`,
    params: [['12467']],
  },
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL });
  await c.connect();

  let ok = 0;
  const falhas = [];
  for (const q of CONSULTAS) {
    try {
      const r = await c.query(q.sql, q.params);
      console.log(`  OK   ${q.nome.padEnd(38)} (${r.rowCount} linha(s))`);
      ok++;
    } catch (e) {
      console.log(`  ERRO ${q.nome.padEnd(38)} ${e.message}`);
      falhas.push(`${q.nome}: ${e.message}`);
    }
  }

  console.log('');
  console.log(`${ok}/${CONSULTAS.length} consultas validas.`);
  if (falhas.length) {
    console.log('CORRIJA ANTES DE DEPLOYAR:');
    for (const f of falhas) console.log(`  - ${f}`);
  }
  await c.end();
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => {
  console.log('ERRO:', e.message);
  process.exit(1);
});
