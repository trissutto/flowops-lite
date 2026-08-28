/**
 * Valida em PRODUÇÃO as queries novas dos consertos de 29/08 (Giga→espelho):
 * estoque por loja, matriz loja×ano, sobra por SKU, busca por descrição,
 * vendas por REF, expandir código→REF.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const t = async (nome, sql, params = []) => {
    const t0 = Date.now();
    try {
      const r = await db.query(sql, params);
      console.log(`✔ ${nome}: ${r.rows.length} linha(s) em ${Date.now() - t0}ms`);
      console.table(r.rows.slice(0, 6));
    } catch (e) {
      console.log(`✘ ${nome}: ${e.message}`);
    }
  };

  await t('estoque por loja (sem filtro)',
    `SELECT CASE WHEN e.loja ~ '^[0-9]$' THEN '0' || e.loja ELSE e.loja END AS loja, SUM(e.estoque)::float AS pecas
       FROM giga_estoque e WHERE e.estoque > 0 GROUP BY 1 ORDER BY 1`);

  await t('estoque por loja (plus size)',
    `SELECT CASE WHEN e.loja ~ '^[0-9]$' THEN '0' || e.loja ELSE e.loja END AS loja, SUM(e.estoque)::float AS pecas
       FROM giga_estoque e
       JOIN wincred_produtos p ON ltrim(p.codigo,'0') = ltrim(e.codigo,'0')
      WHERE e.estoque > 0 AND (COALESCE(p."plusSize",0) > 0 OR UPPER(COALESCE(p."descricaoCompleta",'')) LIKE '%PLUS SIZE%')
      GROUP BY 1 ORDER BY 1`);

  await t('matriz loja × ano (3 primeiras)',
    `SELECT CASE WHEN e.loja ~ '^[0-9]$' THEN '0' || e.loja ELSE e.loja END AS loja,
            CASE WHEN p."dataAlt" IS NULL THEN 'sem_data' WHEN p."dataAlt" < '2021-01-01' THEN 'pre2020'
                 ELSE EXTRACT(YEAR FROM p."dataAlt")::int::text END AS ano,
            SUM(e.estoque)::float AS pecas
       FROM giga_estoque e JOIN wincred_produtos p ON ltrim(p.codigo,'0') = ltrim(e.codigo,'0')
      WHERE e.estoque > 0 GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 12`);

  await t('sobra por SKU (BLUSA, minQty 2)',
    `SELECT TRIM(p.ref) AS ref, MAX(COALESCE(p."descricaoCompleta", p."descricaoPdv", '')) AS descricao,
            COUNT(DISTINCT p.codigo)::int AS variantes, SUM(e.estoque)::float AS estoque_total
       FROM giga_estoque e JOIN wincred_produtos p ON ltrim(p.codigo,'0') = ltrim(e.codigo,'0')
      WHERE e.estoque >= 2 AND TRIM(COALESCE(p.ref,'')) <> ''
        AND UPPER(COALESCE(p."descricaoCompleta",'')) LIKE '%BLUSA%'
      GROUP BY TRIM(p.ref) ORDER BY estoque_total DESC LIMIT 5`);

  await t('busca descrição agrupada (VESTIDO LONGO)',
    `SELECT TRIM(ref) AS "REF", MAX(COALESCE("descricaoCompleta",'')) AS "DESCRICAOCOMPLETA", COUNT(*)::int AS "VARIANT_COUNT"
       FROM wincred_produtos
      WHERE UPPER(COALESCE("descricaoCompleta",'')) LIKE '%VESTIDO%' AND UPPER(COALESCE("descricaoCompleta",'')) LIKE '%LONGO%'
        AND TRIM(COALESCE(ref,'')) <> ''
      GROUP BY TRIM(ref) ORDER BY "VARIANT_COUNT" DESC LIMIT 5`);

  await t('REFs por data (ago/2026)',
    `SELECT TRIM(p.ref) AS ref, COUNT(*)::int vc, MAX(p."dataAlt") dc
       FROM wincred_produtos p
      WHERE p."dataAlt" >= '2026-08-01'::date AND p."dataAlt" < '2026-08-29'::date AND TRIM(COALESCE(p.ref,'')) <> ''
      GROUP BY 1 ORDER BY MAX(p."dataAlt") DESC LIMIT 5`);

  await t('vendas por REF (BMM-100, 180d)',
    `SELECT CASE WHEN c.loja ~ '^[0-9]$' THEN '0' || c.loja ELSE c.loja END AS loja,
            SUM(c.quantidade)::float qty, SUM(c.valor_total)::float valor
       FROM giga_caixa_mov c JOIN wincred_produtos p ON ltrim(p.codigo,'0') = ltrim(c.codigo,'0')
      WHERE UPPER(TRIM(p.ref)) = 'BMM-100' AND c.data >= CURRENT_DATE - 180
        AND (c.marcado IS NULL OR c.marcado <> 'SIM')
      GROUP BY 1 ORDER BY qty DESC LIMIT 8`);

  await t('expandir código→REF (ltrim + ean)',
    `SELECT TRIM(ref) AS ref FROM wincred_produtos
      WHERE ltrim(codigo,'0') = ltrim((SELECT codigo FROM wincred_produtos WHERE COALESCE(ref,'') <> '' LIMIT 1),'0') LIMIT 1`);

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
