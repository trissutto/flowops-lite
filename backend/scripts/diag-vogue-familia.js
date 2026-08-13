/**
 * DIAGNÓSTICO — a família VOGUE espalhada pelo catálogo.
 *
 * A REF sem dígito escapa do agrupamento automático (`GrupoRefService.raiz`
 * devolve null de propósito — "GRAVATA" e "GRAVATA LISA" não podem virar
 * família por texto). VOGUE é exatamente esse caso: as cores viraram sufixo
 * de letra ("VOGUE P", "VOGUEM"…) e cada uma é um card no site.
 *
 * Este script só LÊ: mostra cada variação nas 5 tabelas que enxergam REF
 * (site_produto, wincred_produtos, produto_ficha, product_photos, product)
 * pra decidir a unificação com o mapa completo na mão.
 *
 *   railway run --service Postgres node backend/scripts/diag-vogue-familia.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Sem DATABASE_PUBLIC_URL/DATABASE_URL no ambiente');
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // "VOGUE" em qualquer posição inicial, com ou sem espaço/hífen depois.
  const LIKE = 'VOGUE%';

  console.log('══════════ site_produto (catálogo do site) ══════════');
  const site = await db.query(
    `SELECT ref, nome, categoria, subcategoria, publicado, grupo_ref, grupo_ref_manual,
            origem_conteudo, descricao_curta IS NOT NULL AS tem_desc_curta,
            descricao_completa IS NOT NULL AS tem_desc_completa
       FROM site_produto
      WHERE UPPER(TRIM(ref)) LIKE $1
      ORDER BY ref`,
    [LIKE],
  );
  for (const r of site.rows) {
    console.log(
      `  ${r.ref.padEnd(12)} | ${String(r.nome).slice(0, 45).padEnd(45)} | cat=${r.categoria || '—'}` +
      ` | pub=${r.publicado} | grupo=${r.grupo_ref || '—'}${r.grupo_ref_manual ? ' (manual)' : ''}` +
      ` | origem=${r.origem_conteudo}`,
    );
  }
  console.log(`  → ${site.rows.length} cadastros no site`);

  console.log('\n══════════ wincred_produtos (espelho ERP — cor/tamanho/estoque) ══════════');
  const win = await db.query(
    `SELECT UPPER(TRIM(ref)) AS ref, COUNT(*) AS codigos,
            COUNT(DISTINCT UPPER(TRIM(cor))) AS cores,
            STRING_AGG(DISTINCT UPPER(TRIM(cor)), ', ') AS lista_cores,
            SUM(COALESCE(estoque,0)) AS estoque,
            MIN("vendaUn")::float8 AS preco_min, MAX("vendaUn")::float8 AS preco_max,
            STRING_AGG(DISTINCT marca, ', ') AS marcas,
            MIN("descricaoPdv") AS desc_exemplo
       FROM wincred_produtos
      WHERE UPPER(TRIM(ref)) LIKE $1
      GROUP BY UPPER(TRIM(ref))
      ORDER BY 1`,
    [LIKE],
  );
  for (const r of win.rows) {
    console.log(
      `  ${r.ref.padEnd(12)} | ${r.codigos} códigos | ${r.cores} cores (${String(r.lista_cores).slice(0, 60)})` +
      ` | estoque=${r.estoque} | R$ ${r.preco_min}–${r.preco_max} | marca=${r.marcas || '—'}`,
    );
    console.log(`               desc: ${r.desc_exemplo}`);
  }
  console.log(`  → ${win.rows.length} REFs distintas no espelho`);

  console.log('\n══════════ produto_ficha ══════════');
  const ficha = await db.query(
    `SELECT ref, marca, nome_curto, descricao IS NOT NULL AS tem_descricao
       FROM produto_ficha WHERE UPPER(TRIM(ref)) LIKE $1 ORDER BY ref`,
    [LIKE],
  );
  for (const r of ficha.rows) {
    console.log(`  ${String(r.ref).padEnd(12)} | marca=${r.marca} | nomeCurto=${r.nome_curto || '—'} | desc=${r.tem_descricao}`);
  }
  console.log(`  → ${ficha.rows.length} fichas`);

  console.log('\n══════════ product_photos ══════════');
  const fotos = await db.query(
    `SELECT UPPER(TRIM(ref)) AS ref, COUNT(*) AS fotos,
            STRING_AGG(DISTINCT COALESCE(cor,'(sem cor)'), ', ') AS cores
       FROM product_photos WHERE UPPER(TRIM(ref)) LIKE $1
      GROUP BY UPPER(TRIM(ref)) ORDER BY 1`,
    [LIKE],
  );
  for (const r of fotos.rows) {
    console.log(`  ${r.ref.padEnd(12)} | ${r.fotos} fotos | cores: ${r.cores}`);
  }
  console.log(`  → ${fotos.rows.length} REFs com foto`);

  console.log('\n══════════ product (tabela nativa) ══════════');
  const nat = await db.query(
    `SELECT UPPER(TRIM(ref)) AS ref, COUNT(*) AS codigos, SUM(COALESCE(estoque,0)) AS estoque
       FROM product WHERE UPPER(TRIM(ref)) LIKE $1
      GROUP BY UPPER(TRIM(ref)) ORDER BY 1`,
    [LIKE],
  );
  for (const r of nat.rows) {
    console.log(`  ${r.ref.padEnd(12)} | ${r.codigos} códigos | estoque=${r.estoque}`);
  }
  console.log(`  → ${nat.rows.length} REFs na nativa`);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
