/**
 * Valida no Postgres de PRODUÇÃO a query nova do snapshot da tela de
 * Classificação (que trocou o Giga morto pelo espelho wincred_produtos).
 * Só leitura. Confere: total de REFs, VLM-222 presente, fornecedores, tempo.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const SQL = `SELECT UPPER(TRIM(p.ref)) AS ref,
        MAX(COALESCE(p."descricaoCompleta", p."descricaoPdv", '')) AS descricao,
        LEFT(STRING_AGG(DISTINCT UPPER(COALESCE(p."descricaoCompleta", p."descricaoPdv", '')), ' '), 8000) AS busca,
        MAX(COALESCE(p.marca, ''))       AS marca,
        MAX(COALESCE(p.fornecedor, ''))  AS fornecedor,
        MAX(COALESCE(p."nomeGrupo", '')) AS categoria,
        MAX(CASE WHEN p."plusSize" IN (1, 2) THEN 1 ELSE 0 END) AS plus_size
   FROM wincred_produtos p
  WHERE p.ref IS NOT NULL AND TRIM(p.ref) <> ''
  GROUP BY UPPER(TRIM(p.ref))

 UNION ALL

 SELECT '#' || TRIM(p.codigo)                                    AS ref,
        COALESCE(p."descricaoCompleta", p."descricaoPdv", '')    AS descricao,
        UPPER(COALESCE(p."descricaoCompleta", p."descricaoPdv", '')) AS busca,
        COALESCE(p.marca, '')       AS marca,
        COALESCE(p.fornecedor, '')  AS fornecedor,
        COALESCE(p."nomeGrupo", '') AS categoria,
        CASE WHEN p."plusSize" IN (1, 2) THEN 1 ELSE 0 END AS plus_size
   FROM wincred_produtos p
  WHERE (p.ref IS NULL OR TRIM(p.ref) = '')
    AND p.codigo IS NOT NULL AND TRIM(p.codigo) <> ''`;

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const t0 = Date.now();
  const r = await db.query(SQL);
  const ms = Date.now() - t0;
  const comRef = r.rows.filter((x) => !x.ref.startsWith('#')).length;
  const semRef = r.rows.length - comRef;
  console.log(`total linhas: ${r.rows.length} (${comRef} REFs + ${semRef} #codigo) em ${ms}ms`);

  const vlm = r.rows.filter((x) => x.ref.includes('VLM-222') || x.ref.includes('VLM222'));
  console.log('VLM-222 no resultado:', vlm.map((x) => ({ ref: x.ref, desc: x.descricao.slice(0, 50), plus: x.plus_size })));

  const bmm = r.rows.find((x) => x.ref === 'BMM-100');
  console.log('BMM-100:', bmm ? { desc: bmm.descricao.slice(0, 50), marca: bmm.marca, cat: bmm.categoria } : 'NÃO ACHOU');

  const f = await db.query(`SELECT cnpj, fantasia, "razaoSocial" FROM wincred_fornecedores LIMIT 3`);
  console.log('fornecedores (3):', f.rows.map((x) => `${x.cnpj} → ${x.fantasia || x.razaoSocial}`));
  const fCount = await db.query(`SELECT COUNT(*)::int n FROM wincred_fornecedores`);
  console.log('fornecedores total:', fCount.rows[0].n);

  const plus = r.rows.filter((x) => Number(x.plus_size) === 1).length;
  console.log(`plus size: ${plus} REFs`);

  await db.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
