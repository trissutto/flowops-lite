/**
 * BACKFILL — conserta os cards batizados pelo produto ERRADO da REF reciclada.
 *
 * O bug (13/08): `auto-publicar` batizava o `site_produto` com uma linha
 * SEM ORDER BY da wincred_produtos. Em REF reciclada (a 10990 é biquíni
 * IT CURVES atual E camiseta infantil de 2012), o card nascia com nome da
 * peça morta — e o catálogo, que confia no nome publicado pra escolher a
 * família (`familiaPublicada`), montava a PDP com preço e grade da peça
 * morta e foto da viva. Caso relatado pelo dono: PDP do biquíni anunciada
 * como "Camiseta (o) Manga Curta Alenice" a R$ 23,90 tam 04-08.
 *
 * O que faz, SÓ nos cards com editado_por='auto-publicar' (nome de máquina —
 * nome vindo do WooCommerce ou digitado por gente não é tocado):
 *   1. acha a linha VIVA da REF (estoque > 0 primeiro, depois cadastro mais
 *      recente; nunca masculino/infantil — o mesmo ORDER BY do fix no código);
 *   2. se a FAMÍLIA do nome atual ≠ família da linha viva, regrava o nome
 *      (limpo, via `limparNomeVitrine` do dist) e ZERA categoria/subcategoria
 *      (elas foram derivadas do nome errado; com o nome certo a peça volta
 *      pra fila de classificação em vez de aparecer no menu errado);
 *   3. se a ficha da REF está amarrada na marca do produto morto e não há
 *      conflito, move a ficha pra marca viva (bolinha/descrição voltam a
 *      abrir na PDP pela marca certa).
 *
 * Uso (rodar da pasta raiz do repo, que tem o link do Railway):
 *   railway run --service Postgres node backend/scripts/fix-ref-reciclada-nome.js            (só mostra)
 *   railway run --service Postgres node backend/scripts/fix-ref-reciclada-nome.js --executar (grava + backup)
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { limparNomeVitrine } = require(path.join(__dirname, '..', 'dist', 'loja-catalog', 'nome-vitrine'));

const EXECUTAR = process.argv.includes('--executar');

// Mesma regra de `familiaDe` do loja-catalog.service — a 1ª palavra
// significativa da descrição identifica o PRODUTO dentro da REF.
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

  const cards = await db.query(
    `SELECT ref, nome, categoria, subcategoria FROM site_produto WHERE editado_por = 'auto-publicar'`,
  );
  console.log(`cards batizados pelo auto-publicar: ${cards.rows.length} (modo: ${EXECUTAR ? 'EXECUTAR' : 'simulação'})\n`);

  const backup = [];
  let corrigidos = 0;
  let fichasMovidas = 0;

  for (const card of cards.rows) {
    const ref = String(card.ref).toUpperCase();
    const { rows: linhas } = await db.query(
      `SELECT NULLIF(TRIM(p."descricaoCompleta"), '') AS descricao,
              NULLIF(TRIM(p.cor), '')                 AS cor,
              NULLIF(TRIM(p.marca), '')               AS marca,
              COALESCE(e.total, 0)::int               AS estoque
         FROM wincred_produtos p
         LEFT JOIN (SELECT codigo, SUM(COALESCE(estoque, 0)) AS total
                      FROM wincred_estoque GROUP BY codigo) e ON e.codigo = p.codigo
        WHERE (UPPER(TRIM(p.ref)) = $1 OR UPPER(TRIM(p.ref)) LIKE $1 || ' %')
          AND UPPER(COALESCE(p."descricaoCompleta", '')) NOT LIKE '%MASCULIN%'
          AND UPPER(COALESCE(p."descricaoCompleta", '')) NOT LIKE '%INFANTIL%'
          AND UPPER(COALESCE(p."nomeGrupo", '')) NOT LIKE '%MASCULIN%'
          AND UPPER(COALESCE(p."nomeGrupo", '')) NOT LIKE '%INFANTIL%'
        ORDER BY (COALESCE(e.total, 0) > 0) DESC, p."dataAlt" DESC NULLS LAST
        LIMIT 60`,
      [ref],
    );
    const viva = linhas[0];
    if (!viva || !viva.descricao) continue;

    const famAtual = familiaDe(card.nome);
    const famViva = familiaDe(viva.descricao);
    if (famAtual === famViva) continue; // nome já é do produto certo

    const coresDaViva = [...new Set(
      linhas
        .filter((l) => !viva.marca || !l.marca || l.marca === viva.marca)
        .map((l) => l.cor)
        .filter(Boolean),
    )];
    const nomeNovo = (limparNomeVitrine(viva.descricao, ref, coresDaViva, viva.marca) || ref).slice(0, 160);

    console.log(`── ${ref}`);
    console.log(`   nome : "${card.nome}" → "${nomeNovo}"`);
    console.log(`   cat  : ${card.categoria || '-'}/${card.subcategoria || '-'} → (sem categoria, volta pra fila)`);

    // Ficha amarrada na marca do produto morto?
    const { rows: fichas } = await db.query(
      `SELECT id, marca FROM produto_ficha WHERE ref = $1`, [ref],
    );
    const marcaViva = viva.marca ? viva.marca.toUpperCase() : null;
    let moverFicha = null;
    if (marcaViva && fichas.length === 1 && fichas[0].marca.toUpperCase() !== marcaViva) {
      moverFicha = fichas[0];
      console.log(`   ficha: marca "${moverFicha.marca}" → "${marcaViva}"`);
    } else if (marcaViva && fichas.length > 1) {
      console.log(`   ficha: ${fichas.length} fichas na REF (${fichas.map((f) => f.marca).join(', ')}) — não mexo, conferir à mão`);
    }

    backup.push({ ref, antes: { nome: card.nome, categoria: card.categoria, subcategoria: card.subcategoria, fichaMarca: moverFicha?.marca ?? null } });

    if (EXECUTAR) {
      await db.query(
        `UPDATE site_produto SET nome = $2, categoria = NULL, subcategoria = NULL,
                editado_por = 'fix-ref-reciclada', editado_em = NOW(), updated_at = NOW()
          WHERE ref = $1`,
        [card.ref, nomeNovo],
      );
      if (moverFicha) {
        await db.query(`UPDATE produto_ficha SET marca = $2, updated_at = NOW() WHERE id = $1`, [moverFicha.id, marcaViva]);
        fichasMovidas++;
      }
    }
    corrigidos++;
    console.log('');
  }

  if (EXECUTAR && backup.length) {
    const arq = path.join(__dirname, `fix-ref-reciclada-backup-antes-${Date.now()}.json`);
    fs.writeFileSync(arq, JSON.stringify(backup, null, 2));
    console.log(`backup em ${arq}`);
  }
  console.log(`\n${EXECUTAR ? 'CORRIGIDOS' : 'a corrigir'}: ${corrigidos} card(s), ${fichasMovidas} ficha(s) de marca movida`);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
