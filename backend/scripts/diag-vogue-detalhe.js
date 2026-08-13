/**
 * DIAGNÓSTICO fase 2 — texto COMPLETO dos cadastros VOGUE no site + cores.
 * Só leitura; insumo pra decidir a limpeza dos nomes.
 *
 *   railway run --service Postgres node backend/scripts/diag-vogue-detalhe.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log('══════════ site_produto — texto completo ══════════');
  const site = await db.query(
    `SELECT ref, slug, nome, descricao_curta, descricao_completa, seo, subcategoria
       FROM site_produto WHERE UPPER(TRIM(ref)) LIKE 'VOGUE%' ORDER BY ref`,
  );
  for (const r of site.rows) {
    console.log(`\n─── ${r.ref} (sub=${r.subcategoria || '—'})`);
    console.log(`  slug: ${r.slug}`);
    console.log(`  nome: ${r.nome}`);
    console.log(`  descricao_curta: ${(r.descricao_curta || '—').slice(0, 300)}`);
    console.log(`  descricao_completa: ${(r.descricao_completa || '—').slice(0, 300)}`);
    if (r.seo) console.log(`  seo: ${JSON.stringify(r.seo).slice(0, 200)}`);
  }

  console.log('\n══════════ cores completas por REF (espelho) ══════════');
  const cores = await db.query(
    `SELECT UPPER(TRIM(ref)) AS ref, UPPER(TRIM(cor)) AS cor, COUNT(*) AS codigos
       FROM wincred_produtos WHERE UPPER(TRIM(ref)) LIKE 'VOGUE%'
      GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  let atual = '';
  for (const r of cores.rows) {
    if (r.ref !== atual) { atual = r.ref; console.log(`\n  ${r.ref}:`); }
    console.log(`    · ${r.cor} (${r.codigos} tam)`);
  }

  console.log('\n══════════ estoque real por cor (wincred_estoque) ══════════');
  const est = await db.query(
    `SELECT UPPER(TRIM(p.ref)) AS ref, UPPER(TRIM(p.cor)) AS cor,
            SUM(COALESCE(e.estoque, 0)) AS pecas
       FROM wincred_produtos p
       LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
      WHERE UPPER(TRIM(p.ref)) LIKE 'VOGUE%'
      GROUP BY 1, 2 HAVING SUM(COALESCE(e.estoque, 0)) <> 0 ORDER BY 1, 2`,
  );
  for (const r of est.rows) console.log(`  ${r.ref.padEnd(12)} ${r.cor.padEnd(16)} ${r.pecas} pç`);
  if (!est.rows.length) console.log('  (nenhuma cor com estoque ≠ 0)');

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
