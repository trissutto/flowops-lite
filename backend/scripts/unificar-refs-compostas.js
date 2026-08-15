/**
 * UNIFICAÇÃO DE REFs COMPOSTAS — 900892M, 900892PR, 900892VD → 900892.
 *
 * No cadastro legado a COR virou sufixo no campo REFERENCIA ("900892M" =
 * marinho), mas a DESCRICAOCOMPLETA ficou com a raiz ("VESTIDO ... 900892
 * MARINHO 54"). Essa divergência é o que esconde cor no PDV e racha a família
 * em produtos diferentes.
 *
 * VALIDAÇÃO PELA DESCRIÇÃO (dica do dono, 14/08): só entra na lista a REF cuja
 * DESCRICAOCOMPLETA contém a RAIZ como palavra inteira. Se a descrição carrega
 * a própria REF composta ("8709RIU" na descrição = outro produto de verdade),
 * a peça é PULADA — a alteração de sufixo foi feita SÓ no campo REFERENCIA.
 *
 * ⚠️ POR QUE O SCRIPT ESCREVE NO GIGA: o full sync de produtos (3h da manhã)
 * APAGA wincred_produtos e regrava a partir do Giga. Corrigir só o Postgres
 * evapora de madrugada. O UPDATE vai no campo REF do Giga (origem do sync,
 * com DATAALT=NOW() pro incremental replicar) + espelho/nativa na hora.
 *
 * O que MAIS acompanha a REF (mesma receita da VOGUE):
 *   fotos  — product_photos da REF composta movem pra raiz (sem colisão
 *            ref+cor+ordem; colisão é listada e fica pra resolver na tela)
 *   ficha  — produto_ficha renomeia pra raiz se a raiz não tem ficha da mesma
 *            marca; duplicidade é listada e NENHUMA ficha é apagada
 *   site   — site_produto renomeia pra raiz SÓ se a raiz não tem cadastro
 *            (senão o card vira órfão sem variação); slug é preservado (URL
 *            não muda). Raiz já cadastrada → linha composta vira sobra
 *            inofensiva (o card agrupa por grupo_ref) e é só listada.
 *
 *   # FILTRO pra revisar (não grava nada)
 *   railway run --service Postgres -- node backend/scripts/unificar-refs-compostas.js
 *   # só algumas famílias
 *   railway run --service Postgres -- node backend/scripts/unificar-refs-compostas.js --so=900892,900895
 *   # EXECUTAR (backup automático antes)
 *   railway run --service Postgres -- node backend/scripts/unificar-refs-compostas.js --aplicar
 */
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');
const { Client } = require('pg');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(path.resolve(__dirname, '..'), '.env'), override: false });

const APLICAR = process.argv.includes('--aplicar');
const soArg = process.argv.find((a) => a.startsWith('--so='));
const SO = soArg ? soArg.slice(5).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;

/** Regra única da REF-BASE (common/ref-base.ts): corta tudo depois do último dígito. */
const refBaseOf = (ref) => {
  const up = String(ref ?? '').trim().toUpperCase();
  const semSufixo = up.replace(/[^0-9]+$/, '');
  return semSufixo || up;
};

const tokens = (texto) => String(texto ?? '').toUpperCase().split(/\s+/).filter(Boolean);

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Sem DATABASE_PUBLIC_URL/DATABASE_URL (rodar via railway run --service Postgres)');
  const pg = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  // ── 1. Candidatas: ref composta cuja descrição confirma a raiz ─────────
  const { rows: catalogo } = await pg.query(
    `SELECT codigo, ref, cor, tamanho, marca, "descricaoCompleta" AS descricao
       FROM wincred_produtos
      WHERE ref IS NOT NULL AND TRIM(ref) <> ''`,
  );

  const confirmadas = []; // { codigo, refAntiga, raiz, cor, tamanho, descricao }
  const puladas = [];     // { refAntiga, raiz, motivo, exemplo }
  const puladasVistas = new Set();
  for (const p of catalogo) {
    const refUp = String(p.ref).trim().toUpperCase();
    const raiz = refBaseOf(refUp);
    if (raiz === refUp) continue;               // já é raiz
    if (SO && !SO.includes(raiz)) continue;
    const toks = tokens(p.descricao);
    if (toks.includes(raiz) && !toks.includes(refUp)) {
      confirmadas.push({ codigo: String(p.codigo), refAntiga: String(p.ref).trim(), raiz, cor: p.cor, tamanho: p.tamanho, descricao: p.descricao });
    } else {
      const motivo = toks.includes(refUp)
        ? 'descrição carrega a REF composta (produto próprio de verdade)'
        : 'descrição não menciona a raiz (sem confirmação)';
      const chave = `${refUp}|${motivo}`;
      if (!puladasVistas.has(chave)) {
        puladasVistas.add(chave);
        puladas.push({ refAntiga: refUp, raiz, motivo, exemplo: p.descricao });
      }
    }
  }

  if (!confirmadas.length) {
    console.log('Nenhuma REF composta confirmada pela descrição. Nada a fazer.');
    if (puladas.length) {
      console.log(`\n── PULADAS (${puladas.length} REFs) ──`);
      for (const s of puladas) console.log(`  ${s.refAntiga.padEnd(12)} → ${s.raiz.padEnd(10)} | ${s.motivo}\n${' '.repeat(17)}ex: ${s.exemplo}`);
    }
    await pg.end();
    return;
  }

  // ── 2. Agrupar por raiz pro relatório ──────────────────────────────────
  const familias = new Map(); // raiz → { refs: Map(refAntiga → {cores, n, codigos}) }
  for (const c of confirmadas) {
    if (!familias.has(c.raiz)) familias.set(c.raiz, new Map());
    const fam = familias.get(c.raiz);
    if (!fam.has(c.refAntiga)) fam.set(c.refAntiga, { cores: new Set(), n: 0, codigos: [] });
    const e = fam.get(c.refAntiga);
    e.cores.add(String(c.cor || '?').trim());
    e.n += 1;
    e.codigos.push(c.codigo);
  }

  // ── 3. O que acompanha: fotos, ficha, site ─────────────────────────────
  const refsCompostas = [...new Set(confirmadas.map((c) => c.refAntiga.toUpperCase()))];
  const raizes = [...familias.keys()];

  const { rows: fotos } = await pg.query(
    `SELECT id, UPPER(TRIM(ref)) AS ref, cor, ordem FROM product_photos WHERE UPPER(TRIM(ref)) = ANY($1)`,
    [refsCompostas],
  );
  const { rows: fotosRaiz } = await pg.query(
    `SELECT UPPER(TRIM(ref)) AS ref, UPPER(TRIM(COALESCE(cor,''))) AS cor, ordem FROM product_photos WHERE UPPER(TRIM(ref)) = ANY($1)`,
    [raizes],
  );
  const fotoRaizOcupada = new Set(fotosRaiz.map((f) => `${f.ref}|${f.cor}|${f.ordem}`));
  const fotosMover = [];
  const fotosColisao = [];
  for (const f of fotos) {
    const raiz = refBaseOf(f.ref);
    const chave = `${raiz}|${String(f.cor || '').trim().toUpperCase()}|${f.ordem}`;
    (fotoRaizOcupada.has(chave) ? fotosColisao : fotosMover).push({ ...f, raiz });
  }

  const { rows: fichas } = await pg.query(
    `SELECT id, UPPER(TRIM(ref)) AS ref, marca FROM produto_ficha WHERE UPPER(TRIM(ref)) = ANY($1)`,
    [refsCompostas],
  );
  const { rows: fichasRaiz } = await pg.query(
    `SELECT UPPER(TRIM(ref)) AS ref, marca FROM produto_ficha WHERE UPPER(TRIM(ref)) = ANY($1)`,
    [raizes],
  );
  const fichaRaizOcupada = new Set(fichasRaiz.map((f) => `${f.ref}|${String(f.marca || '').trim().toUpperCase()}`));
  const fichasRenomear = [];
  const fichasDuplicadas = [];
  for (const f of fichas) {
    const raiz = refBaseOf(f.ref);
    const chave = `${raiz}|${String(f.marca || '').trim().toUpperCase()}`;
    (fichaRaizOcupada.has(chave) ? fichasDuplicadas : fichasRenomear).push({ ...f, raiz });
  }

  const { rows: siteRows } = await pg.query(
    `SELECT ref, slug, nome, publicado FROM site_produto WHERE UPPER(TRIM(ref)) = ANY($1)`,
    [refsCompostas],
  );
  const { rows: siteRaiz } = await pg.query(
    `SELECT UPPER(TRIM(ref)) AS ref FROM site_produto WHERE UPPER(TRIM(ref)) = ANY($1)`,
    [raizes],
  );
  const siteRaizExiste = new Set(siteRaiz.map((r) => r.ref));
  const siteRenomear = [];
  const siteSobra = [];
  for (const s of siteRows) {
    const raiz = refBaseOf(s.ref);
    (siteRaizExiste.has(raiz) ? siteSobra : siteRenomear).push({ ...s, raiz });
    if (!siteRaizExiste.has(raiz)) siteRaizExiste.add(raiz); // 2 compostas pra mesma raiz vazia: só a 1ª renomeia
  }

  // ── 4. Relatório (o FILTRO pra revisar) ────────────────────────────────
  console.log(`════════ ${familias.size} famílias · ${refsCompostas.length} REFs compostas · ${confirmadas.length} peças (linhas do catálogo) ════════\n`);
  const raizesOrdenadas = [...familias.keys()].sort();
  for (const raiz of raizesOrdenadas) {
    const fam = familias.get(raiz);
    const totalPecas = [...fam.values()].reduce((s, e) => s + e.n, 0);
    console.log(`  ${raiz}  ←  ${[...fam.keys()].join(', ')}   (${totalPecas} linhas)`);
    for (const [refAntiga, e] of fam) {
      console.log(`      ${refAntiga.padEnd(12)} ${e.n} tam · cor: ${[...e.cores].join(' / ')}`);
    }
  }
  if (puladas.length) {
    console.log(`\n── PULADAS (${puladas.length} REFs — NÃO serão alteradas) ──`);
    for (const s of puladas) {
      console.log(`  ${s.refAntiga.padEnd(12)} → ${s.raiz.padEnd(10)} | ${s.motivo}`);
      console.log(`               ex: ${s.exemplo}`);
    }
  }
  console.log(`\n── ACOMPANHAM A UNIFICAÇÃO ──`);
  console.log(`  fotos:  ${fotosMover.length} movem pra raiz · ${fotosColisao.length} em colisão (ficam, listadas abaixo)`);
  for (const f of fotosColisao) console.log(`     COLISÃO foto #${f.id} ${f.ref} cor=${f.cor} ordem=${f.ordem} — raiz já tem foto nessa posição`);
  console.log(`  fichas: ${fichasRenomear.length} renomeiam pra raiz · ${fichasDuplicadas.length} duplicadas (ficam, revisar na tela)`);
  for (const f of fichasDuplicadas) console.log(`     DUPLICADA ficha ${f.ref} marca=${f.marca} — raiz já tem ficha dessa marca`);
  console.log(`  site:   ${siteRenomear.length} cadastros renomeiam (slug/URL preservados) · ${siteSobra.length} viram sobra (raiz já cadastrada)`);
  for (const s of siteSobra) console.log(`     SOBRA site ${s.ref} "${s.nome}" pub=${s.publicado} — raiz já tem cadastro`);

  if (!APLICAR) {
    console.log('\nSECO — nada gravado. Revise a lista e rode com --aplicar pra EXECUTAR.');
    if (SO) console.log(`(filtro ativo: --so=${SO.join(',')})`);
    await pg.end();
    return;
  }

  // ── 5. EXECUTAR ────────────────────────────────────────────────────────
  const my = await mysql.createConnection({
    host: process.env.ERP_HOST,
    port: Number(process.env.ERP_PORT || 3306),
    user: process.env.ERP_USER,
    password: process.env.ERP_PASSWORD,
    database: process.env.ERP_DATABASE,
  });

  const stamp = Date.now();
  const backupPath = path.join(__dirname, `unificar-refs-compostas-backup-antes-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    quando: new Date().toISOString(),
    filtro: SO,
    pecas: confirmadas,
    fotosMover, fotosColisao, fichasRenomear, fichasDuplicadas, siteRenomear, siteSobra,
  }, null, 2));
  console.log(`\nBackup salvo em ${backupPath}`);

  // 5a. GIGA primeiro (origem do sync) — REF corrigida + DATAALT pro incremental
  console.log('\nGravando no Giga (campo REF)...');
  let gigaOk = 0, gigaMiss = 0;
  for (const c of confirmadas) {
    const [r] = await my.execute(
      `UPDATE produtos SET REF = ?, DATAALT = NOW()
        WHERE CAST(CODIGO AS UNSIGNED) = CAST(? AS UNSIGNED) AND TRIM(REF) = ?`,
      [c.raiz, c.codigo, c.refAntiga],
    );
    if (r.affectedRows > 0) gigaOk += r.affectedRows; else gigaMiss += 1;
  }
  console.log(`  Giga: ${gigaOk} linhas atualizadas · ${gigaMiss} não encontradas (já corrigidas?)`);
  await my.end();

  // 5b. Postgres numa transação — espelho, nativa, fotos, ficha, site
  await pg.query('BEGIN');
  try {
    for (const [raiz, fam] of familias) {
      const codigos = [...fam.values()].flatMap((e) => e.codigos);
      await pg.query(`UPDATE wincred_produtos SET ref = $1 WHERE codigo = ANY($2)`, [raiz, codigos]);
      await pg.query(`UPDATE product SET ref = $1 WHERE codigo = ANY($2)`, [raiz, codigos]);
    }
    for (const f of fotosMover) {
      await pg.query(`UPDATE product_photos SET ref = $1 WHERE id = $2`, [f.raiz, f.id]);
    }
    for (const f of fichasRenomear) {
      await pg.query(`UPDATE produto_ficha SET ref = $1, updated_at = NOW() WHERE id = $2`, [f.raiz, f.id]);
    }
    for (const s of siteRenomear) {
      await pg.query(
        `UPDATE site_produto SET ref = $1, grupo_ref = $1, grupo_ref_manual = TRUE, updated_at = NOW() WHERE ref = $2`,
        [s.raiz, s.ref],
      );
    }
    await pg.query('COMMIT');
  } catch (e) {
    await pg.query('ROLLBACK');
    console.error('\nPOSTGRES FALHOU (rollback) — o Giga JÁ FOI atualizado; o sync (10min/3h) replica sozinho, ou rode de novo com --aplicar.');
    throw e;
  }

  // ── 6. Conferência ─────────────────────────────────────────────────────
  const { rows: restam } = await pg.query(
    `SELECT ref, COUNT(*)::int AS n FROM wincred_produtos WHERE UPPER(TRIM(ref)) = ANY($1) GROUP BY ref`,
    [refsCompostas],
  );
  console.log(`\n── DEPOIS ──`);
  console.log(`  REFs compostas restantes no espelho (deveria ser 0): ${restam.length}`);
  for (const r of restam) console.log(`     ainda existe: ${r.ref} (${r.n})`);
  for (const raiz of raizesOrdenadas) {
    const { rows } = await pg.query(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT cor)::int AS cores FROM wincred_produtos WHERE UPPER(TRIM(ref)) = $1`,
      [raiz],
    );
    console.log(`  ${raiz}: ${rows[0].n} linhas, ${rows[0].cores} cores no catálogo`);
  }
  console.log('\nFeito. O PDV/Consulta refletem na hora; o site atualiza no próximo rebuild do catálogo (cache 60s).');
  await pg.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
