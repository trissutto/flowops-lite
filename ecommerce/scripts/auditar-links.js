#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * AUDITORIA DE LINKS MORTOS.
 *
 * Extrai todo `href` interno do código e compara com as rotas que existem de
 * fato em `src/app`. Nasceu em 06/08/2026, quando três links 404 apareceram
 * por acidente num mesmo dia — inclusive o botão de login do cabeçalho e os
 * dois links legais ao lado do "Finalizar compra". A varredura completa achou
 * 64.
 *
 * DOIS MODOS:
 *
 *   node scripts/auditar-links.js            → relatório completo
 *   node scripts/auditar-links.js --check    → falha (exit 1) se PIOROU
 *
 * O `--check` compara com `links-mortos.baseline.json`. É uma CATRACA, não uma
 * trava: os 60 que já existem não quebram o build (senão ninguém consegue
 * trabalhar), mas nenhum link novo entra. Cada vez que alguém conserta um
 * grupo, baixa a baseline — e ela nunca sobe.
 *
 * Por que catraca e não zero: exigir zero num débito de 60 faz a equipe
 * desligar a verificação no primeiro dia. Catraca é o único formato de teste
 * de dívida técnica que sobrevive à segunda semana.
 *
 * ⚠️ RODA NO `prebuild` — ou seja, NO DEPLOY DA VERCEL. Por isso o `--check`
 * é à prova de falha: se a auditoria quebrar SOZINHA (arquivo renomeado, node
 * diferente), ela AVISA e deixa passar. Só link morto novo derruba o build.
 * Auditor que impede o site de subir por causa de um bug dele mesmo é pior do
 * que auditor nenhum — some no primeiro incêndio.
 */
const fs = require('fs');
const path = require('path');

// `slice(2)`: argv[0] é o executável do node e argv[1] é este script — os dois
// contêm separador de caminho e seriam confundidos com a raiz do projeto.
const ARGS = process.argv.slice(2);
const RAIZ = ARGS.find((a) => !a.startsWith('-')) || path.join(__dirname, '..');
const CHECK = ARGS.includes('--check');
const APP = path.join(RAIZ, 'src', 'app');
const SRC = path.join(RAIZ, 'src');
const BASELINE = path.join(__dirname, 'links-mortos.baseline.json');

function levantar() {
  /* ── 1) rotas que existem ───────────────────────────────────────────── */
  const rotas = new Set(['/']);
  (function varrer(dir, url) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'api') continue;
      // (grupo) não vira segmento de URL
      const seg = /^\(.+\)$/.test(e.name) ? '' : `/${e.name}`;
      const novo = url + seg;
      const cheio = path.join(dir, e.name);
      if (['page.tsx', 'page.ts'].some((f) => fs.existsSync(path.join(cheio, f)))) {
        rotas.add(novo || '/');
      }
      varrer(cheio, novo);
    }
  })(APP, '');

  /* ── 2) redirects do next.config ────────────────────────────────────── */
  // `.ts` hoje; aceito `.js`/`.mjs` pra auditoria não morrer se renomearem.
  const arquivoCfg = ['next.config.ts', 'next.config.js', 'next.config.mjs']
    .map((f) => path.join(RAIZ, f))
    .find((f) => fs.existsSync(f));
  const redirecionadas = new Set();
  if (arquivoCfg) {
    const cfg = fs.readFileSync(arquivoCfg, 'utf8');
    for (const m of cfg.matchAll(/source:\s*['"`]([^'"`]+)['"`]/g)) redirecionadas.add(m[1]);
  }

  /* ── 3) hrefs usados no código ──────────────────────────────────────── */
  const usos = new Map(); // href -> Set(arquivo)
  (function ler(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const cheio = path.join(dir, e.name);
      if (e.isDirectory()) { ler(cheio); continue; }
      if (!/\.(tsx|ts)$/.test(e.name)) continue;
      if (cheio.includes(`${path.sep}api${path.sep}`)) continue;
      const txt = fs.readFileSync(cheio, 'utf8');
      const rel = path.relative(SRC, cheio);
      for (const m of txt.matchAll(/href[=:]\s*["'`](\/[^"'`${}\s]*)["'`]/g)) {
        const h = m[1].split('#')[0].split('?')[0].replace(/\/$/, '') || '/';
        if (!usos.has(h)) usos.set(h, new Set());
        usos.get(h).add(rel);
      }
    }
  })(SRC);

  /* ── 4) casa href com rota (respeitando [param] e :param) ───────────── */
  const casa = (alvoPartes, rota, curinga) => {
    const rp = rota.split('/').filter(Boolean);
    if (curinga) {
      if (rp.length > alvoPartes.length) return false;
    } else if (rp.length !== alvoPartes.length) return false;
    return rp.every((s, i) => (curinga && (s.startsWith(':') || s.includes('*'))) || /^\[.+\]$/.test(s) || s === alvoPartes[i]);
  };

  const existe = (href) => {
    if (rotas.has(href) || redirecionadas.has(href)) return true;
    const partes = href.split('/').filter(Boolean);
    for (const r of rotas) if (casa(partes, r, false)) return true;
    for (const r of redirecionadas) if (casa(partes, r, true)) return true;
    return false;
  };

  const mortos = [...usos.entries()].filter(([h]) => !existe(h)).map(([h, a]) => [h, [...a]]).sort();
  return { rotas, redirecionadas, mortos };
}

let rotas, redirecionadas, mortos;
try {
  ({ rotas, redirecionadas, mortos } = levantar());
} catch (e) {
  // No relatório quem roda é gente: quero o stack inteiro.
  if (!CHECK) throw e;
  // No `--check` quem roda é o deploy: falha MINHA não derruba o site.
  console.warn(`\n⚠️  A auditoria de links não conseguiu rodar: ${e.message}`);
  console.warn('   Deixando o build passar — conserte scripts/auditar-links.js.\n');
  process.exit(0);
}

/* ── 5) saída ─────────────────────────────────────────────────────────── */
if (!CHECK) {
  console.log(`ROTAS EXISTENTES (${rotas.size}):\n${[...rotas].sort().join('  ')}\n`);
  console.log(`REDIRECTS (${redirecionadas.size}): ${[...redirecionadas].sort().join('  ')}\n`);
  console.log(`\n🔴 LINKS QUE APONTAM PRO VAZIO: ${mortos.length}\n`);
  for (const [h, arquivos] of mortos) console.log(`${h.padEnd(38)} ← ${arquivos.join(', ')}`);
  process.exit(0);
}

const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { links: [] };
const conhecidos = new Set(base.links);
const novos = mortos.map(([h]) => h).filter((h) => !conhecidos.has(h));
const consertados = base.links.filter((h) => !mortos.some(([m]) => m === h));

if (novos.length) {
  console.error(`\n🔴 ${novos.length} LINK(S) NOVO(S) APONTANDO PRO VAZIO:\n`);
  for (const h of novos) {
    const arquivos = mortos.find(([m]) => m === h)[1];
    console.error(`  ${h}`);
    console.error(`     em: ${arquivos.join(', ')}`);
  }
  console.error(
    `\nCrie a rota, aponte pro endereço certo, ou — se for dívida aceita —\n` +
      `adicione em scripts/links-mortos.baseline.json explicando o porquê.\n`,
  );
  process.exit(1);
}

if (consertados.length) {
  console.log(`✅ ${consertados.length} link(s) consertado(s): ${consertados.join(', ')}`);
  console.log('   Baixe a baseline pra travar o ganho (a catraca só desce).');
}
console.log(`✅ Nenhum link morto novo. Dívida atual: ${mortos.length}.`);
