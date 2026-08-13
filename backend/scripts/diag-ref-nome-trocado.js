/**
 * DIAGNÓSTICO — refs com nome que não bate com a foto (10990, 11589).
 * Olha as 3 tabelas do catálogo + fotos pra achar de onde veio o nome errado.
 *
 *   railway run --service Postgres node backend/scripts/diag-ref-nome-trocado.js
 */
const { Client } = require('pg');

const REFS = ['10990', '11589', '19233'];

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  for (const ref of REFS) {
    console.log(`\n════════════════════ REF ${ref} ════════════════════`);

    console.log('\n── wincred_produtos (codigo/descricao que começam com a ref) ──');
    const wp = await db.query(
      `SELECT codigo, "descricaoCompleta" AS descricao, cor, tamanho, fornecedor, marca, ref,
              "vendaUn" AS venda_un, "dataAlt" AS dataalt
         FROM wincred_produtos
        WHERE ref = $1
        ORDER BY "dataAlt" DESC NULLS LAST
        LIMIT 40`,
      [ref],
    );
    for (const r of wp.rows) {
      console.log(`  ${String(r.codigo).padEnd(8)} R$${String(r.venda_un).padStart(8)} ${String(r.dataalt).slice(0, 10)} [${r.marca || r.fornecedor || 'SEM MARCA'}] cor=${r.cor} tam=${r.tamanho} ${r.descricao}`);
    }
    if (!wp.rows.length) console.log('  (nada)');

    console.log('\n── produto_ficha (ref exata) ──');
    const pf = await db.query(
      `SELECT id, ref, marca, nome_curto, ia_em, atualizado_por, updated_at
         FROM produto_ficha WHERE ref = $1`,
      [ref],
    );
    for (const r of pf.rows) {
      console.log(`  ficha ${r.id.slice(0, 8)} marca=[${r.marca}] nome_curto="${r.nome_curto}" ia_em=${r.ia_em ? String(r.ia_em).slice(0, 10) : '-'} por=${r.atualizado_por || '-'} upd=${String(r.updated_at).slice(0, 10)}`);
      const cores = await db.query(
        `SELECT cor, status_publicacao, titulo_comercial FROM produto_ficha_cor WHERE ficha_id = $1`,
        [r.id],
      );
      for (const c of cores.rows) {
        console.log(`    cor=[${c.cor}] status=${c.status_publicacao} titulo="${c.titulo_comercial || ''}"`);
      }
    }
    if (!pf.rows.length) console.log('  (nada)');

    console.log('\n── site_produto (ref ou grupo_ref) ──');
    const sp = await db.query(
      `SELECT ref, grupo_ref, nome, categoria, subcategoria, publicado, origem_conteudo, wc_id, updated_at
         FROM site_produto WHERE ref = $1 OR grupo_ref = $1`,
      [ref],
    );
    for (const r of sp.rows) {
      console.log(`  ref=${r.ref} grupo=${r.grupo_ref} pub=${r.publicado} origem=${r.origem_conteudo} wc_id=${r.wc_id || '-'} cat=${r.categoria}/${r.subcategoria} upd=${String(r.updated_at).slice(0, 10)}`);
      console.log(`    nome="${r.nome}"`);
    }
    if (!sp.rows.length) console.log('  (nada)');

    console.log('\n── product_photos (ref exata) ──');
    const ph = await db.query(
      `SELECT ref, cor, ordem, created_at, url FROM product_photos WHERE ref = $1 ORDER BY cor, ordem LIMIT 15`,
      [ref],
    );
    for (const r of ph.rows) {
      console.log(`  cor=[${r.cor || 'GERAL'}] #${r.ordem} ${String(r.created_at).slice(0, 10)} ${r.url.slice(-60)}`);
    }
    if (!ph.rows.length) console.log('  (nada)');
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
