/**
 * DESCRIÇÃO QUE CITA COR — varredura e saneamento (06/09/2026).
 *
 * A descrição é UMA por REF e aparece em todas as variantes de cor. Herança
 * do WooCommerce (onde cada cor era um produto): textos jurando "Cor Preta"
 * na variante MARROM (caso real ref-900890) — contradição que induz troca
 * paga pela loja. A régua nova é "descrição por REF não cita cor"
 * (`backend/src/produto-ficha/descricao-cor.ts` valida o save daqui em
 * diante; este script cuida do LEGADO já gravado).
 *
 * Classes:
 *   CONTRADIZ    — o texto cita cor que a peça NÃO TEM à venda. É texto de
 *                  outra época/variante: com `--aplicar`, o campo vira NULL
 *                  (a PDP cai no fallback neutro da curadoria — honesto >
 *                  errado). Backup JSON antes, na convenção da pasta.
 *   CITA_PROPRIA — cita cor que a peça tem, mas a peça é multi-cor: o texto
 *                  contradiz as OUTRAS variantes. SÓ RELATÓRIO — o texto tem
 *                  valor, reescrever é trabalho de gente (fila da ficha já
 *                  acusa como "Descrição cita cor").
 *   SEM_PALETA   — cita cor e não achamos a paleta da peça (sem linha no
 *                  espelho nem ficha-cor). SÓ RELATÓRIO.
 *   Peça de UMA cor citando a própria cor: passa (o texto casa com a única
 *   variante que existe).
 *
 *   railway run --service Postgres node backend/scripts/fix-descricao-cita-cor.js
 *   railway run --service Postgres node backend/scripts/fix-descricao-cita-cor.js --aplicar
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const APLICAR = process.argv.includes('--aplicar');

/** Cópia do dicionário de `descricao-cor.ts` — script roda standalone. */
const GRUPOS = [
  { canonical: 'preto', variantes: ['preto', 'preta', 'pretos', 'pretas'] },
  { canonical: 'branco', variantes: ['branco', 'branca', 'brancos', 'brancas'] },
  { canonical: 'off white', variantes: ['off white', 'offwhite', 'off-white'] },
  { canonical: 'cru', variantes: ['cru'] },
  { canonical: 'bege', variantes: ['bege'] },
  { canonical: 'creme', variantes: ['creme'] },
  { canonical: 'nude', variantes: ['nude'] },
  { canonical: 'vermelho', variantes: ['vermelho', 'vermelha', 'vermelhos', 'vermelhas'] },
  { canonical: 'vinho', variantes: ['vinho', 'marsala', 'bordo'] },
  { canonical: 'rosa', variantes: ['rosa', 'pink', 'rose'] },
  { canonical: 'marinho', variantes: ['marinho'] },
  { canonical: 'azul', variantes: ['azul', 'azuis', 'royal'] },
  { canonical: 'verde', variantes: ['verde', 'verdes', 'esmeralda', 'militar', 'oliva', 'musgo'] },
  { canonical: 'amarelo', variantes: ['amarelo', 'amarela', 'mostarda'] },
  { canonical: 'laranja', variantes: ['laranja', 'terracota'] },
  { canonical: 'roxo', variantes: ['roxo', 'roxa', 'uva'] },
  { canonical: 'lilas', variantes: ['lilas', 'lavanda'] },
  { canonical: 'marrom', variantes: ['marrom', 'chocolate', 'caramelo', 'cafe'] },
  { canonical: 'cinza', variantes: ['cinza', 'grafite', 'chumbo'] },
  { canonical: 'dourado', variantes: ['dourado', 'dourada'] },
  { canonical: 'prata', variantes: ['prata', 'prateado', 'prateada'] },
];

const semAcento = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

const escapaRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function coresCitadas(texto) {
  const t = semAcento(texto);
  if (!t) return [];
  const achadas = [];
  for (const g of GRUPOS) {
    if (
      g.variantes.some((v) =>
        new RegExp(`(?<![\\w])${escapaRe(v).replace(/\s+/g, '\\s+')}(?![\\w])`).test(t),
      )
    ) {
      achadas.push(g.canonical);
    }
  }
  return achadas;
}

/** REF-base: 900887B → 900887 (a cor virava sufixo de letra no legado). */
const refBase = (ref) => String(ref || '').replace(/[A-Z]+$/i, '');

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();

  console.log(APLICAR ? '\n>>> APLICANDO <<<\n' : '\n>>> SIMULAÇÃO (rode com --aplicar pra valer) <<<\n');

  // ── Paleta real por REF: espelho do ERP + ficha-cor ──
  const paleta = new Map(); // refBase -> Set(canonicals)
  const addCor = (ref, corTexto) => {
    const b = refBase(ref);
    if (!b) return;
    if (!paleta.has(b)) paleta.set(b, new Set());
    for (const c of coresCitadas(corTexto)) paleta.get(b).add(c);
  };
  const wc = await db.query(
    'SELECT DISTINCT ref, cor FROM wincred_produtos WHERE cor IS NOT NULL AND ref IS NOT NULL',
  );
  for (const r of wc.rows) addCor(r.ref, r.cor);
  const fc = await db.query(
    'SELECT f.ref, c.cor FROM produto_ficha f JOIN produto_ficha_cor c ON c.ficha_id = f.id',
  );
  for (const r of fc.rows) addCor(r.ref, r.cor);
  console.log(`paleta montada pra ${paleta.size} REF-base\n`);

  // ── Textos ──
  const alvos = []; // {tabela, chave:{...}, campo, texto}
  const fichas = await db.query(
    'SELECT ref, marca, descricao, resumo FROM produto_ficha WHERE descricao IS NOT NULL OR resumo IS NOT NULL',
  );
  for (const f of fichas.rows) {
    if (f.descricao) alvos.push({ tabela: 'produto_ficha', chave: { ref: f.ref, marca: f.marca }, campo: 'descricao', texto: f.descricao });
    if (f.resumo) alvos.push({ tabela: 'produto_ficha', chave: { ref: f.ref, marca: f.marca }, campo: 'resumo', texto: f.resumo });
  }
  const sites = await db.query(
    'SELECT ref, descricao_completa, descricao_curta FROM site_produto WHERE descricao_completa IS NOT NULL OR descricao_curta IS NOT NULL',
  );
  for (const s of sites.rows) {
    if (s.descricao_completa) alvos.push({ tabela: 'site_produto', chave: { ref: s.ref }, campo: 'descricao_completa', texto: s.descricao_completa });
    if (s.descricao_curta) alvos.push({ tabela: 'site_produto', chave: { ref: s.ref }, campo: 'descricao_curta', texto: s.descricao_curta });
  }
  console.log(`${alvos.length} textos pra examinar (${fichas.rows.length} fichas + ${sites.rows.length} site_produto)\n`);

  // ── Classificação ──
  const porClasse = { CONTRADIZ: [], CITA_PROPRIA: [], SEM_PALETA: [] };
  for (const a of alvos) {
    const citadas = coresCitadas(a.texto);
    if (!citadas.length) continue;
    const proprias = paleta.get(refBase(a.chave.ref));
    if (!proprias || proprias.size === 0) {
      porClasse.SEM_PALETA.push({ ...a, citadas });
      continue;
    }
    const fora = citadas.filter((c) => !proprias.has(c));
    if (fora.length) {
      porClasse.CONTRADIZ.push({ ...a, citadas, fora, proprias: [...proprias] });
    } else if (proprias.size > 1) {
      porClasse.CITA_PROPRIA.push({ ...a, citadas, proprias: [...proprias] });
    }
    // uma cor só, citando a própria: passa.
  }

  for (const [classe, lista] of Object.entries(porClasse)) {
    console.log(`── ${classe}: ${lista.length} ──`);
    for (const item of lista.slice(0, 15)) {
      const trecho = item.texto.replace(/\s+/g, ' ').slice(0, 90);
      console.log(
        `  ${String(item.chave.ref).padEnd(12)} ${item.tabela}.${item.campo}` +
          ` cita=[${item.citadas.join(',')}]${item.fora ? ` FORA=[${item.fora.join(',')}]` : ''}` +
          `\n    "${trecho}…"`,
      );
    }
    if (lista.length > 15) console.log(`  … e mais ${lista.length - 15}`);
    console.log('');
  }

  // Relatório COMPLETO em arquivo, sempre — o console corta em 15 por classe
  // e decisão de --aplicar se toma olhando a lista INTEIRA, não o resumo.
  const relatorioPath = path.join(__dirname, `fix-descricao-cita-cor-relatorio-${Date.now()}.json`);
  fs.writeFileSync(relatorioPath, JSON.stringify(porClasse, null, 2));
  console.log(`Relatório completo: ${relatorioPath}`);

  if (!APLICAR) {
    console.log('Nada gravado. Revise o CONTRADIZ do relatório e rode com --aplicar.');
    await db.end();
    return;
  }

  // ── Aplicar: NULL só no CONTRADIZ, com backup antes ──
  const backupPath = path.join(__dirname, `fix-descricao-cita-cor-backup-antes-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(porClasse.CONTRADIZ, null, 2));
  console.log(`Backup salvo em ${backupPath}`);

  await db.query('BEGIN');
  let n = 0;
  for (const item of porClasse.CONTRADIZ) {
    if (item.tabela === 'produto_ficha') {
      await db.query(
        `UPDATE produto_ficha SET ${item.campo} = NULL WHERE ref = $1 AND marca = $2 AND ${item.campo} = $3`,
        [item.chave.ref, item.chave.marca, item.texto],
      );
    } else {
      await db.query(
        `UPDATE site_produto SET ${item.campo} = NULL WHERE ref = $1 AND ${item.campo} = $2`,
        [item.chave.ref, item.texto],
      );
    }
    n++;
  }
  await db.query('COMMIT');
  console.log(`\n→ ${n} campos zerados (a PDP cai no fallback neutro; a ficha-por-IA reescreve com calma).`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
