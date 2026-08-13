/**
 * UNIFICAÇÃO DA FAMÍLIA VOGUE — 13 cadastros viram UM produto no site.
 *
 * A raiz VOGUE não tem dígito, então o agrupamento automático nunca a junta
 * (`GrupoRefService.raiz` devolve null de propósito — agrupar REF de letra por
 * texto fundiria "GRAVATA" com "GRAVATA LISA"). A cor virou sufixo de letra no
 * cadastro legado: VOGUE-C é a camelo, VOGUEU a uva, "VOGUE M" a marinho…
 * Resultado no site: 7 cards da MESMA blusa lado a lado, com cor/tamanho/marca
 * colados no nome ("…VOGUE CAMELO 46 MARRIE").
 *
 * O que este script faz (decisão do dono, 13/08/2026):
 *   1. LIMPA os nomes dos 7 cadastros do site — corta cor/tamanho/marca; todos
 *      ficam "Blusa Feminina Manga Curta Plus Size Ref Vogue". Na VOGUE-PD as
 *      descrições também perdem o "Preto Dourado" grudado no Ref Vogue.
 *   2. JUNTA tudo num produto só: `grupo_ref='VOGUE'` + `grupo_ref_manual`
 *      (o sync nunca desfaz decisão manual). A vitrine agrupa por grupoRef e
 *      as cores viram bolinhas de um card único — o mecanismo já existe.
 *   3. CRIA cadastro pras 6 REFs que só existem no ERP (VOGUE-DO, "VOGUE F",
 *      VOGUELAR, "VOGUE M", "VOGUE O", VOGUEVIOL) — sem linha em site_produto
 *      o `montarCatalogo` nem carrega as variações delas, e as cores (35 pç em
 *      estoque) ficariam fora do card pra sempre.
 *   4. MOVE as 2 fotos da VOGUE-PD (cor PRETO DOURADO) pra REF VOGUE: a
 *      VOGUE-PD não tem linha no ERP (o estoque da cor vive na VOGUE mãe), e
 *      foto de REF sem linha não entra na galeria da família. Sem colisão:
 *      a VOGUE não tem foto dessa cor, e a capa (cor MARROM DOURADO, primeira
 *      no `cor asc`) não muda.
 *
 * origem_conteudo vira 'flow' em tudo que é tocado — o importador do
 * WooCommerce pula essas peças pra sempre e não desfaz a limpeza.
 *
 *   # conferir (não grava nada)
 *   railway run --service Postgres node backend/scripts/unificar-vogue.js
 *   # gravar
 *   railway run --service Postgres node backend/scripts/unificar-vogue.js --aplicar
 *
 * `--aplicar` salva o estado anterior em unificar-vogue-backup-antes.json
 * ANTES de escrever, e roda tudo numa transação.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const APLICAR = process.argv.includes('--aplicar');

/** A família inteira, explícita — nada de LIKE: se amanhã nascer um "VOGUE2"
 *  (dígito = produto DIFERENTE, regra da REF-BASE), ele não pode ser tragado. */
const REFS_SITE = ['VOGUE', 'VOGUE-C', 'VOGUE-OFF', 'VOGUE-PD', 'VOGUERQ', 'VOGUEU', 'VOGUEVI'];
const REFS_SO_ERP = ['VOGUE-DO', 'VOGUE F', 'VOGUELAR', 'VOGUE M', 'VOGUE O', 'VOGUEVIOL'];
const RAIZ = 'VOGUE';

const NOME_LIMPO = 'Blusa Feminina Manga Curta Plus Size Ref Vogue';
const EDITOR = 'unificacao-vogue';

/** "…Ref Vogue Preto Dourado…" → "…Ref Vogue…" (só quando grudado na raiz). */
const cortarSufixoNaDescricao = (texto) =>
  texto == null ? null : texto.replace(/VOGUE\s+PRETO\s+DOURADO/gi, 'Vogue');

const slugDe = (ref) => `ref-${ref.toLowerCase().replace(/\s+/g, '-')}`;

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Sem DATABASE_PUBLIC_URL/DATABASE_URL no ambiente');
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  // ── Estado atual ────────────────────────────────────────────────────────
  const site = await db.query(
    `SELECT * FROM site_produto WHERE ref = ANY($1) ORDER BY ref`, [REFS_SITE],
  );
  const jaExistem = await db.query(
    `SELECT ref FROM site_produto WHERE ref = ANY($1)`, [REFS_SO_ERP],
  );
  const fotosPd = await db.query(
    `SELECT id, ref, cor, ordem, url FROM product_photos WHERE UPPER(TRIM(ref)) = 'VOGUE-PD' ORDER BY ordem`,
  );
  const fotosVogueMesmaCor = await db.query(
    `SELECT id, cor, ordem FROM product_photos
      WHERE UPPER(TRIM(ref)) = 'VOGUE' AND UPPER(TRIM(cor)) = 'PRETO DOURADO'`,
  );
  const slugsNovos = REFS_SO_ERP.map(slugDe);
  const slugOcupado = await db.query(
    `SELECT slug FROM site_produto WHERE slug = ANY($1)`, [slugsNovos],
  );

  // ── Sanidade: o mundo tem que estar como o diagnóstico viu ──────────────
  const achadas = site.rows.map((r) => r.ref);
  const faltando = REFS_SITE.filter((r) => !achadas.includes(r));
  if (faltando.length) throw new Error(`REFs esperadas sumiram do site: ${faltando.join(', ')}`);
  if (jaExistem.rows.length)
    throw new Error(`REFs "só ERP" já têm cadastro (rodar diag de novo): ${jaExistem.rows.map((r) => r.ref).join(', ')}`);
  if (slugOcupado.rows.length)
    throw new Error(`Slug novo já ocupado: ${slugOcupado.rows.map((r) => r.slug).join(', ')}`);
  if (fotosVogueMesmaCor.rows.length)
    throw new Error('VOGUE já tem foto PRETO DOURADO — mover a da VOGUE-PD colidiria em (ref, cor, ordem)');

  // ── Plano ───────────────────────────────────────────────────────────────
  console.log(`── LIMPAR + AGRUPAR (${site.rows.length} cadastros existentes) ──`);
  for (const r of site.rows) {
    console.log(`  ${r.ref.padEnd(10)} nome: "${r.nome}"`);
    console.log(`             →     "${NOME_LIMPO}" · grupo_ref=${RAIZ} (manual) · origem=flow`);
    if (r.ref === 'VOGUE-PD') {
      console.log(`             desc_curta →  "${cortarSufixoNaDescricao(r.descricao_curta)}"`);
      console.log(`             desc_completa → "${String(cortarSufixoNaDescricao(r.descricao_completa)).slice(0, 120)}…"`);
    }
  }
  console.log(`\n── CRIAR ${REFS_SO_ERP.length} cadastros pras REFs só-ERP ──`);
  for (const ref of REFS_SO_ERP) {
    console.log(`  ${ref.padEnd(10)} slug=${slugDe(ref)} · "${NOME_LIMPO}" · linha-conforto/blusas-conforto · publicado · grupo_ref=${RAIZ} (manual)`);
  }
  console.log(`\n── MOVER ${fotosPd.rows.length} fotos VOGUE-PD → VOGUE (cor mantida) ──`);
  for (const f of fotosPd.rows) console.log(`  #${f.id} cor=${f.cor} ordem=${f.ordem}`);

  if (!APLICAR) {
    console.log('\nSECO — nada gravado. Rode com --aplicar pra executar.');
    await db.end();
    return;
  }

  // ── Backup ANTES de escrever ────────────────────────────────────────────
  const backupPath = path.join(__dirname, 'unificar-vogue-backup-antes.json');
  fs.writeFileSync(backupPath, JSON.stringify({
    quando: new Date().toISOString(),
    site_produto: site.rows,
    product_photos_vogue_pd: fotosPd.rows,
  }, null, 2));
  console.log(`\nBackup salvo em ${backupPath}`);

  // ── Transação ───────────────────────────────────────────────────────────
  await db.query('BEGIN');
  try {
    for (const r of site.rows) {
      await db.query(
        `UPDATE site_produto
            SET nome = $2,
                descricao_curta = $3,
                descricao_completa = $4,
                grupo_ref = $5,
                grupo_ref_manual = TRUE,
                origem_conteudo = 'flow',
                editado_por = $6,
                editado_em = NOW(),
                updated_at = NOW()
          WHERE ref = $1`,
        [
          r.ref,
          NOME_LIMPO,
          cortarSufixoNaDescricao(r.descricao_curta),
          cortarSufixoNaDescricao(r.descricao_completa),
          RAIZ,
          EDITOR,
        ],
      );
    }

    for (const ref of REFS_SO_ERP) {
      await db.query(
        `INSERT INTO site_produto
           (ref, slug, nome, categoria, subcategoria, publicado,
            grupo_ref, grupo_ref_manual, origem_conteudo,
            editado_por, editado_em, classificado_por, classificado_em,
            synced_at, updated_at)
         VALUES ($1, $2, $3, 'linha-conforto', 'blusas-conforto', TRUE,
                 $4, TRUE, 'flow', $5::varchar, NOW(), $5::text, NOW(), NOW(), NOW())`,
        [ref, slugDe(ref), NOME_LIMPO, RAIZ, EDITOR],
      );
    }

    await db.query(
      `UPDATE product_photos SET ref = 'VOGUE' WHERE UPPER(TRIM(ref)) = 'VOGUE-PD'`,
    );

    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }

  // ── Conferência ─────────────────────────────────────────────────────────
  const depois = await db.query(
    `SELECT ref, nome, grupo_ref, grupo_ref_manual, publicado, origem_conteudo
       FROM site_produto WHERE grupo_ref = $1 ORDER BY ref`, [RAIZ],
  );
  console.log(`\n── DEPOIS: ${depois.rows.length} cadastros no grupo ${RAIZ} ──`);
  for (const r of depois.rows) {
    console.log(`  ${r.ref.padEnd(10)} | grupo=${r.grupo_ref} manual=${r.grupo_ref_manual} pub=${r.publicado} origem=${r.origem_conteudo} | ${r.nome}`);
  }
  const fotosDepois = await db.query(
    `SELECT COUNT(*)::int AS n FROM product_photos WHERE UPPER(TRIM(ref)) = 'VOGUE'`,
  );
  console.log(`  Fotos na REF VOGUE agora: ${fotosDepois.rows[0].n}`);

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
