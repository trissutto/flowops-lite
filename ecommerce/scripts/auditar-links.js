/**
 * AUDITORIA DE LINKS MORTOS do e-commerce.
 *
 * Extrai todo href/redirect interno do código e compara com as rotas que
 * existem de fato em app/. Achei 3 links 404 por acidente hoje; isto responde
 * quantos são no total.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = process.argv[2];
const APP = path.join(RAIZ, 'src', 'app');
const SRC = path.join(RAIZ, 'src');

/* ── 1) rotas que existem ─────────────────────────────────────────────── */
const rotas = new Set(['/']);
(function varrer(dir, url) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name === 'api') continue;
    const nome = e.name;
    // (grupo) não vira segmento de URL
    const seg = /^\(.+\)$/.test(nome) ? '' : `/${nome}`;
    const novo = url + seg;
    const cheio = path.join(dir, nome);
    if (fs.existsSync(path.join(cheio, 'page.tsx')) || fs.existsSync(path.join(cheio, 'page.ts'))) {
      rotas.add(novo || '/');
    }
    varrer(cheio, novo);
  }
})(APP, '');

/* ── 2) redirects do next.config ──────────────────────────────────────── */
const cfg = fs.readFileSync(path.join(RAIZ, 'next.config.ts'), 'utf8');
const redirecionadas = new Set();
for (const m of cfg.matchAll(/source:\s*['"`]([^'"`]+)['"`]/g)) redirecionadas.add(m[1]);

/* ── 3) hrefs usados no código ────────────────────────────────────────── */
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

/* ── 4) casa href com rota (respeitando [param]) ──────────────────────── */
const existe = (href) => {
  if (rotas.has(href) || redirecionadas.has(href)) return true;
  const partes = href.split('/').filter(Boolean);
  for (const r of rotas) {
    const rp = r.split('/').filter(Boolean);
    if (rp.length !== partes.length) continue;
    if (rp.every((s, i) => /^\[.+\]$/.test(s) || s === partes[i])) return true;
  }
  // redirect com :param ou wildcard
  for (const r of redirecionadas) {
    const rp = r.split('/').filter(Boolean);
    if (rp.some((s) => s.startsWith(':') || s.includes('*'))) {
      if (rp.length <= partes.length && rp.every((s, i) => s.startsWith(':') || s.includes('*') || s === partes[i])) return true;
    }
  }
  return false;
};

const mortos = [...usos.entries()].filter(([h]) => !existe(h)).sort();

console.log(`ROTAS EXISTENTES (${rotas.size}):`);
console.log([...rotas].sort().join('  '));
console.log();
console.log(`REDIRECTS (${redirecionadas.size}): ${[...redirecionadas].sort().join('  ')}`);
console.log();
console.log(`\n🔴 LINKS QUE APONTAM PRO VAZIO: ${mortos.length}\n`);
for (const [h, arquivos] of mortos) {
  console.log(`${h.padEnd(38)} ← ${[...arquivos].join(', ')}`);
}
