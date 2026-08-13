/**
 * DIAGNÓSTICO — "ESGOTADO" FALSO: produto publicado que o site mostra sem
 * estoque enquanto a rede TEM peça.
 *
 * Replica o funil do `montarCatalogo`/`montarPeca` (13/08) em cima do banco:
 *   1. famílias das REFs publicadas (grupo_ref manual OU ref-base);
 *   2. cores com estoque no espelho;
 *   3. corte "cor exige foto" (foto na família, match exato de nome de cor);
 *   4. corte `nao_publicar` da ficha (first-wins da família).
 * O que sobra é o estoque VISÍVEL; família com visível=0 e real>0 é o card
 * "Esgotado no site" com peça na arara.
 *
 *   railway run --service Postgres node backend/scripts/diag-esgotado-falso.js [REF-detalhe]
 */
const { Client } = require('pg');

const norm = (v) => String(v ?? '').trim().toUpperCase();
const refBaseOf = (ref) => {
  const up = norm(ref);
  const s = up.replace(/[^0-9]+$/, '');
  return s || up;
};

async function main() {
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const detalheRef = process.argv[2] ? norm(process.argv[2]) : null;

  const site = (await db.query(
    `SELECT ref, grupo_ref, grupo_ref_manual, publicado FROM site_produto WHERE publicado = TRUE`,
  )).rows;
  const pubPorRef = new Map(site.map((r) => [norm(r.ref), r]));
  const basesPub = new Set(site.map((r) => refBaseOf(r.ref)));

  // Variações do ERP com estoque real somado por cor (espelho + wincred_estoque)
  const linhas = (await db.query(
    `SELECT UPPER(TRIM(p.ref)) AS ref, UPPER(TRIM(p.cor)) AS cor,
            SUM(COALESCE(e.estoque, 0))::int AS estoque
       FROM wincred_produtos p
       LEFT JOIN wincred_estoque e ON e.codigo = p.codigo
      GROUP BY 1, 2`,
  )).rows;

  const fotos = (await db.query(
    `SELECT UPPER(TRIM(ref)) AS ref, UPPER(TRIM(COALESCE(cor,''))) AS cor, COUNT(*)::int AS n
       FROM product_photos GROUP BY 1, 2`,
  )).rows;
  const fotosPorRef = new Map();
  for (const f of fotos) {
    if (!fotosPorRef.has(f.ref)) fotosPorRef.set(f.ref, []);
    fotosPorRef.get(f.ref).push(f);
  }

  const fichas = (await db.query(
    `SELECT UPPER(TRIM(f.ref)) AS ref, UPPER(TRIM(c.cor)) AS cor, c.status_publicacao,
            c.created_at < '2026-08-13'::date AS antes_da_regra
       FROM produto_ficha f JOIN produto_ficha_cor c ON c.ficha_id = f.id`,
  )).rows;
  const fichaPorRefCor = new Map();
  for (const f of fichas) fichaPorRefCor.set(`${f.ref}|${f.cor}`, f);

  // ── monta as famílias a partir das publicadas ─────────────────────────────
  const chaveDe = (ref) => {
    const cad = pubPorRef.get(ref);
    if (cad?.grupo_ref_manual && !cad?.grupo_ref) return ref;
    return (cad?.grupo_ref && norm(cad.grupo_ref)) || refBaseOf(ref);
  };
  const familias = new Map(); // chave → { refs:Set, linhas:[] }
  for (const l of linhas) {
    const pub = pubPorRef.has(l.ref);
    const basePub = basesPub.has(refBaseOf(l.ref));
    if (!pub && !basePub) continue;
    const chave = pub ? chaveDe(l.ref) : refBaseOf(l.ref);
    if (!familias.has(chave)) familias.set(chave, { refs: new Set(), linhas: [] });
    const fam = familias.get(chave);
    fam.refs.add(l.ref);
    fam.linhas.push({ ...l, publicada: pub });
  }

  let esgotadoFalso = [];
  let coresSemFotoComEstoque = 0, pecasSemFoto = 0;
  let coresPresasFicha = 0, pecasPresasFicha = 0;
  const exemplosPresas = [];

  for (const [chave, fam] of familias) {
    const refsFam = new Set([chave, ...fam.refs]);
    for (const r of [...refsFam]) refsFam.add(refBaseOf(r));

    // linha entra se a REF é publicada OU (estoque>0 e cor com foto) — montarCatalogo
    const corTemFoto = (cor) => {
      for (const r of refsFam) {
        for (const f of fotosPorRef.get(r) ?? []) if (f.cor === cor) return true;
      }
      return false;
    };
    // status da ficha: first-wins percorrendo as refs da família (aprox. do escolherFicha)
    const statusDaCor = (cor) => {
      for (const r of refsFam) {
        const hit = fichaPorRefCor.get(`${r}|${cor}`);
        if (hit) return hit;
      }
      return null;
    };

    const porCor = new Map();
    for (const l of fam.linhas) {
      if (!l.cor) continue;
      if (!l.publicada && !((l.estoque || 0) > 0 && corTemFoto(l.cor))) continue;
      porCor.set(l.cor, (porCor.get(l.cor) || 0) + (l.estoque || 0));
    }

    let visivel = 0, real = 0;
    for (const [cor, est] of porCor) {
      real += Math.max(0, est);
      const temFoto = corTemFoto(cor);
      const st = statusDaCor(cor);
      const escondidaPorFicha = st?.status_publicacao === 'nao_publicar';
      if (temFoto && !escondidaPorFicha) visivel += Math.max(0, est);
      if (!temFoto && est > 0) { coresSemFotoComEstoque++; pecasSemFoto += est; }
      if (temFoto && escondidaPorFicha && est > 0) {
        coresPresasFicha++; pecasPresasFicha += est;
        if (exemplosPresas.length < 15)
          exemplosPresas.push(`${chave} · ${cor} (${est} pç${st.antes_da_regra ? ', linha pré-13/08' : ', linha de HOJE'})`);
      }
    }
    if (real > 0 && visivel === 0) esgotadoFalso.push({ chave, real, cores: porCor.size });

    if (detalheRef && (chave === detalheRef || refsFam.has(detalheRef))) {
      console.log(`\n════ DETALHE família ${chave} (refs: ${[...fam.refs].join(', ')}) ════`);
      for (const [cor, est] of [...porCor].sort()) {
        const st = statusDaCor(cor);
        console.log(
          `  ${cor.padEnd(18)} estoque=${String(est).padStart(4)} | foto=${corTemFoto(cor) ? 'SIM' : 'NÃO'} | ficha=${st ? st.status_publicacao + (st.antes_da_regra ? ' (pré-13/08)' : ' (hoje)') : '—'}`,
        );
      }
      const fotosFam = [...refsFam].flatMap((r) => (fotosPorRef.get(r) ?? []).map((f) => `${f.cor || '(sem cor)'}@${r}`));
      console.log(`  fotos da família: ${fotosFam.join(', ') || 'NENHUMA'}`);
    }
  }

  esgotadoFalso.sort((a, b) => b.real - a.real);
  console.log(`\n══════════ MEDIÇÃO DA REDE (famílias publicadas: ${familias.size}) ══════════`);
  console.log(`Cards "ESGOTADO" com peça na arara: ${esgotadoFalso.length}`);
  console.log(`  peças presas nesses cards: ${esgotadoFalso.reduce((s, f) => s + f.real, 0)}`);
  console.log(`Cores com ESTOQUE e SEM FOTO (invisíveis pela regra de hoje): ${coresSemFotoComEstoque} cores / ${pecasSemFoto} pç`);
  console.log(`Cores COM FOTO presas em nao_publicar da ficha: ${coresPresasFicha} cores / ${pecasPresasFicha} pç`);
  if (exemplosPresas.length) console.log(`  ex.: ${exemplosPresas.join(' · ')}`);
  console.log(`\nTop 20 "esgotado falso" por peças presas:`);
  for (const f of esgotadoFalso.slice(0, 20)) {
    console.log(`  ${f.chave.padEnd(14)} ${String(f.real).padStart(4)} pç em ${f.cores} cor(es)`);
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
