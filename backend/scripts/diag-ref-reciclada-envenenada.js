/**
 * VARREDURA — REFs publicadas cujo NOME veio da família errada (REF reciclada).
 *
 * Reproduz a regra `familiaDe`/`familiaPublicada` do loja-catalog: pra cada
 * site_produto publicado, separa as linhas da wincred_produtos por família e
 * confere se a família que o NOME publicado escolhe é a que tem estoque.
 * Suspeita = nome aponta pra família SEM estoque enquanto outra família da
 * mesma REF TEM estoque (o card mostra preço/grade de uma peça e foto de outra).
 *
 *   railway run --service Postgres node backend/scripts/diag-ref-reciclada-envenenada.js
 */
const { Client } = require('pg');

const IGNORAR = new Set(['feminina', 'feminino', 'plus', 'size', 'plussize', 'moda', 'plus-size']);

function familiaDe(desc) {
  const palavras = String(desc || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  return palavras.find((w) => w.length >= 4 && !/\d/.test(w) && !IGNORAR.has(w)) || '_outros';
}

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const site = await db.query(
    `SELECT ref, nome, categoria, subcategoria, origem_conteudo, editado_por
       FROM site_produto WHERE publicado = true`,
  );
  console.log(`site_produto publicadas: ${site.rows.length}`);

  const linhas = await db.query(
    `SELECT UPPER(TRIM(p.ref)) AS ref,
            NULLIF(TRIM(p."descricaoCompleta"), '') AS descricao,
            NULLIF(TRIM(p.marca), '') AS marca,
            COALESCE(p."vendaUn", 0)::float8 AS preco,
            p."dataAlt" AS dataalt,
            COALESCE(e.total, 0)::int AS estoque
       FROM wincred_produtos p
       LEFT JOIN (SELECT codigo, SUM(COALESCE(estoque,0)) AS total FROM wincred_estoque GROUP BY codigo) e
         ON e.codigo = p.codigo
      WHERE p.ref IS NOT NULL AND TRIM(p.ref) <> ''
        AND UPPER(TRIM(p.ref)) IN (${site.rows.map((_, i) => `$${i + 1}`).join(',')})
        AND UPPER(COALESCE(p."descricaoCompleta", '')) NOT LIKE '%MASCULIN%'
        AND UPPER(COALESCE(p."descricaoCompleta", '')) NOT LIKE '%INFANTIL%'
        AND UPPER(COALESCE(p."nomeGrupo", '')) NOT LIKE '%MASCULIN%'
        AND UPPER(COALESCE(p."nomeGrupo", '')) NOT LIKE '%INFANTIL%'`,
    site.rows.map((r) => String(r.ref).toUpperCase()),
  );

  const porRef = new Map();
  for (const l of linhas.rows) {
    if (!porRef.has(l.ref)) porRef.set(l.ref, []);
    porRef.get(l.ref).push(l);
  }

  let multi = 0;
  const suspeitas = [];
  for (const s of site.rows) {
    const ref = String(s.ref).toUpperCase();
    const ls = porRef.get(ref) || [];
    const fams = new Map();
    for (const l of ls) {
      const f = familiaDe(l.descricao);
      if (!fams.has(f)) fams.set(f, { linhas: 0, estoque: 0, exemplo: l.descricao, marca: l.marca, preco: l.preco, dataalt: l.dataalt });
      const agg = fams.get(f);
      agg.linhas++;
      agg.estoque += l.estoque;
      if (l.dataalt && (!agg.dataalt || l.dataalt > agg.dataalt)) { agg.dataalt = l.dataalt; agg.exemplo = l.descricao; agg.marca = l.marca; agg.preco = l.preco; }
    }
    if (fams.size < 2) continue;
    multi++;

    const famNome = familiaDe(s.nome);
    const escolhida = fams.get(famNome);
    const comEstoque = [...fams.entries()].filter(([f, a]) => a.estoque > 0);
    const melhor = comEstoque.sort((a, b) => b[1].estoque - a[1].estoque)[0];

    // Suspeita: o nome escolhe uma família sem estoque (ou inexistente) e
    // OUTRA família tem estoque — o card mistura peças.
    if ((!escolhida || escolhida.estoque === 0) && melhor && melhor[0] !== famNome) {
      suspeitas.push({
        ref,
        nome: s.nome,
        origem: s.origem_conteudo,
        por: s.editado_por,
        cat: `${s.categoria || '-'}/${s.subcategoria || '-'}`,
        famNome,
        estoqueNome: escolhida ? escolhida.estoque : null,
        famCerta: melhor[0],
        exemploCerto: melhor[1].exemplo,
        marcaCerta: melhor[1].marca,
        precoCerto: melhor[1].preco,
        estoqueCerto: melhor[1].estoque,
      });
    }
  }

  console.log(`REFs publicadas com 2+ famílias no ERP: ${multi}`);
  console.log(`SUSPEITAS (nome aponta família sem estoque, outra tem): ${suspeitas.length}\n`);
  for (const s of suspeitas) {
    console.log(`── ${s.ref} [origem=${s.origem} por=${s.por || '-'}] cat=${s.cat}`);
    console.log(`   nome atual : "${s.nome}" (família "${s.famNome}", estoque ${s.estoqueNome ?? 'INEXISTENTE'})`);
    console.log(`   peça viva  : "${s.exemploCerto}" [${s.marcaCerta || 'SEM MARCA'}] R$${s.precoCerto} estoque=${s.estoqueCerto}\n`);
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
