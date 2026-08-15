/**
 * VLM-222 × VLM222EST — devolve o estampado pra REF dele (15/08/2026).
 *
 * O QUE ESTAVA ERRADO
 * A REF `VLM222EST` (vestido ESTAMPADO, R$ 199,90, 129 peças) tem no ERP uma
 * descrição que diz `"... PLUS SIZE VLM-222 ESTAMPA MARINHO 46 MARRIE"` — com
 * o hífen. Quem leu a REF pelo TEXTO gravou as fotos dela sob `VLM-222`, que é
 * a peça LISA de R$ 139,90. As cores "ESTAMPA MARINHO" e "ESTAMPA VINHO"
 * viraram cores publicadas da ficha da lisa, a galeria chega ordenada por cor,
 * e "ESTAMPA" abre o alfabeto: a vitrine anunciava o estampado no preço da
 * lisa, numa página onde ele nem estava à venda.
 *
 * O QUE ESTE SCRIPT FAZ
 *   1. Move as fotos ESTAMPA MARINHO/VINHO de `VLM-222` pra `VLM222EST`.
 *   2. Tira essas cores da ficha da lisa e cria a ficha do estampado.
 *   3. Publica `VLM222EST` como card próprio, a R$ 199,90 (`grupoRefManual`
 *      pra nenhuma varredura de REF-BASE reagrupar as duas de novo).
 *   4. Junta a VINHO no card da lisa: as 33 peças dela moram na REF `VLM222`
 *      SEM hífen, que é outra família — `grupoRef` faz a ponte.
 *
 * ⚠️ Cor SEM FOTO fica `nao_publicar` de propósito (regra do dono, 13/08):
 *    bolinha sem foto mostra a peça da cor vizinha. O script lista quais são.
 *
 *   railway run --service Postgres node backend/scripts/corrigir-vlm222-estampado.js
 *   railway run --service Postgres node backend/scripts/corrigir-vlm222-estampado.js --apply
 */
const { Client } = require('pg');

const LISA = 'VLM-222';
const EST = 'VLM222EST';
const VINHO_REF = 'VLM222';
const MARCA = 'MARRIE';
const CORES_EST = ['ESTAMPA MARINHO', 'ESTAMPA VINHO', 'ESTAMPA PRETO'];

const APPLY = process.argv.includes('--apply');
const log = (s = '') => console.log(s);

async function main() {
  const db = new Client({
    connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  log(APPLY ? '\n>>> APLICANDO <<<\n' : '\n>>> SIMULAÇÃO (rode com --apply pra valer) <<<\n');
  await db.query('BEGIN');

  try {
    // ── 0) Retrato de antes, pra conferir depois ──────────────────────────
    const estoque = await db.query(
      `SELECT p.ref, p.cor, COALESCE(SUM(e.estoque), 0)::int AS estoque, MIN(p."vendaUn")::float AS preco
         FROM wincred_produtos p
         LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
        WHERE p.ref IN ($1, $2, $3)
        GROUP BY p.ref, p.cor ORDER BY p.ref, p.cor`,
      [LISA, EST, VINHO_REF],
    );
    log('── estoque no ERP ──');
    for (const r of estoque.rows) {
      log(`  ${r.ref.padEnd(10)} [${String(r.cor).padEnd(16)}] ${String(r.estoque).padStart(4)} peças · R$ ${r.preco.toFixed(2)}`);
    }

    const comFoto = await db.query(
      `SELECT DISTINCT UPPER(TRIM(cor)) AS cor FROM product_photos WHERE ref IN ($1, $2) AND cor IS NOT NULL`,
      [LISA, EST],
    );
    const temFoto = new Set(comFoto.rows.map((r) => r.cor));

    // ── 1) As fotos do estampado voltam pra REF dele ──────────────────────
    const mov = await db.query(
      `UPDATE product_photos SET ref = $1, updated_at = NOW()
        WHERE ref = $2 AND UPPER(TRIM(cor)) = ANY($3::text[])
        RETURNING cor, ordem`,
      [EST, LISA, CORES_EST],
    );
    log(`\n1) fotos movidas ${LISA} → ${EST}: ${mov.rowCount}`);
    for (const r of mov.rows) log(`     [${r.cor}] #${r.ordem}`);

    // ── 2) As cores de estampa saem da ficha da lisa e viram ficha própria ─
    const fichaEst = await db.query(
      `INSERT INTO produto_ficha (id, ref, marca, nome_curto, atualizado_por, created_at, updated_at)
            VALUES (gen_random_uuid(), $1, $2, $3, 'corrigir-vlm222-estampado', NOW(), NOW())
       ON CONFLICT (ref, marca) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
      [EST, MARCA, 'Vestido Longo Manga Curta Estampado'],
    );
    const fichaEstId = fichaEst.rows[0].id;

    const apagadas = await db.query(
      `DELETE FROM produto_ficha_cor c USING produto_ficha f
        WHERE c.ficha_id = f.id AND f.ref = $1 AND UPPER(TRIM(c.cor)) = ANY($2::text[])
        RETURNING c.cor`,
      [LISA, CORES_EST],
    );
    log(`\n2) cores de estampa tiradas da ficha da lisa: ${apagadas.rowCount}`);
    for (const r of apagadas.rows) log(`     [${r.cor}]`);

    // Sem foto = `nao_publicar`. A ESTAMPA PRETO tem 31 peças e nenhuma foto:
    // publicá-la faria a bolinha dela abrir a galeria de outra estampa.
    log(`\n   ficha do estampado (${EST}):`);
    for (const cor of CORES_EST) {
      const publicavel = temFoto.has(cor);
      await db.query(
        `INSERT INTO produto_ficha_cor (id, ficha_id, cor, status_publicacao, created_at, updated_at)
              VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
         ON CONFLICT (ficha_id, cor) DO UPDATE SET status_publicacao = $3, updated_at = NOW()`,
        [fichaEstId, cor, publicavel ? 'publicado' : 'nao_publicar'],
      );
      log(`     [${cor.padEnd(16)}] ${publicavel ? 'publicado' : 'nao_publicar — SEM FOTO'}`);
    }

    // ── 3) O estampado vira card próprio, no preço dele ───────────────────
    // `publicado_em` = data do cadastro no ERP, não hoje: "NOVO" é selo de
    // peça nova, e carimbar a data de hoje mentiria na aba Novidades.
    const nascimento = await db.query(
      `SELECT MIN("dataAlt") AS dt FROM wincred_produtos WHERE ref = $1`, [EST],
    );
    const card = await db.query(
      `INSERT INTO site_produto (ref, slug, nome, categoria, subcategoria, publicado, publicado_em,
                                 origem_conteudo, grupo_ref, grupo_ref_manual, editado_por, editado_em,
                                 synced_at, updated_at)
            VALUES ($1, $2, $3, 'vestidos', 'vestido-manga-curta', true, $4,
                    'flow', NULL, true, 'corrigir-vlm222-estampado', NOW(), NOW(), NOW())
       ON CONFLICT (ref) DO UPDATE
             SET publicado = true, grupo_ref = NULL, grupo_ref_manual = true, updated_at = NOW()
         RETURNING ref, slug, publicado`,
      [EST, 'ref-vlm222est', 'VESTIDO LONGO MANGA CURTA PLUS SIZE ESTAMPADO VLM222EST MARRIE',
       nascimento.rows[0].dt],
    );
    log(`\n3) card do estampado: ref=${card.rows[0].ref} slug=${card.rows[0].slug} publicado=${card.rows[0].publicado}`);
    log(`     preço: R$ 199,90 (o do ERP — sem promo, ao contrário da lisa)`);

    // ── 4) A VINHO da lisa mora numa REF sem hífen — grupoRef faz a ponte ──
    const nascimentoVinho = await db.query(
      `SELECT MIN("dataAlt") AS dt FROM wincred_produtos WHERE ref = $1`, [VINHO_REF],
    );
    const vinho = await db.query(
      `INSERT INTO site_produto (ref, slug, nome, categoria, subcategoria, publicado, publicado_em,
                                 origem_conteudo, grupo_ref, grupo_ref_manual, editado_por, editado_em,
                                 synced_at, updated_at)
            VALUES ($1, $2, $3, 'vestidos', 'vestido-manga-curta', true, $5,
                    'flow', $4, true, 'corrigir-vlm222-estampado', NOW(), NOW(), NOW())
       ON CONFLICT (ref) DO UPDATE
             SET publicado = true, grupo_ref = $4, grupo_ref_manual = true, updated_at = NOW()
         RETURNING ref, grupo_ref`,
      [VINHO_REF, 'ref-vlm222', 'VESTIDO LONGO MANGA CURTA PLUS SIZE VLM-222 VINHO 46 MARRIE', LISA,
       nascimentoVinho.rows[0].dt],
    );
    log(`\n4) ponte da VINHO: ref=${vinho.rows[0].ref} entra no card ${vinho.rows[0].grupo_ref}`);

    // ── 5) O que ficou de fora, e por quê ─────────────────────────────────
    const semFoto = await db.query(
      `SELECT p.ref, p.cor, COALESCE(SUM(e.estoque), 0)::int AS estoque
         FROM wincred_produtos p
         LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
        WHERE p.ref IN ($1, $2, $3)
          AND UPPER(TRIM(p.cor)) NOT IN (SELECT DISTINCT UPPER(TRIM(cor)) FROM product_photos
                                          WHERE ref IN ($1, $2, $3) AND cor IS NOT NULL)
        GROUP BY p.ref, p.cor HAVING COALESCE(SUM(e.estoque), 0) >= 10
        ORDER BY 3 DESC`,
      [LISA, EST, VINHO_REF],
    );
    log('\n5) PARADO ESPERANDO FOTO (não publicado — bolinha sem foto mostra a cor errada):');
    let travadas = 0;
    for (const r of semFoto.rows) {
      travadas += r.estoque;
      log(`     ${r.ref.padEnd(10)} [${String(r.cor).padEnd(16)}] ${String(r.estoque).padStart(4)} peças`);
    }
    log(`     total travado: ${travadas} peças`);

    if (APPLY) {
      await db.query('COMMIT');
      log('\n✓ aplicado. O catálogo tem cache de 60s — a vitrine reflete em até 1 min.');
    } else {
      await db.query('ROLLBACK');
      log('\n(simulação — nada foi gravado. Rode com --apply.)');
    }
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
