/**
 * Gera o mapa de rotas do app (Next App Router) + flag "tem atalho".
 *
 * O QUE FAZ:
 *   1. Varre os arquivos page.tsx em src/app e deriva a URL de cada tela.
 *   2. Varre TODO o código em src atrás de links internos:
 *        href="/x"  ·  href={'/x'}  ·  href:'/x' (hubs)  ·  router.push('/x')
 *   3. Marca cada rota com hasShortcut = existe algum link/atalho pra ela.
 *   4. Escreve src/app/retaguarda/mapa-urls/routes.generated.json
 *
 * RODAR:  node scripts/gen-routes-map.mjs   (a partir de frontend/)
 * Regerar sempre que criar/remover telas ou botões de atalho.
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = process.cwd();
const APP_DIR = join(ROOT, 'src', 'app');
const SRC_DIR = join(ROOT, 'src');
const OUT = join(APP_DIR, 'retaguarda', 'mapa-urls', 'routes.generated.json');

const PAGE_FILES = new Set(['page.tsx', 'page.jsx', 'page.ts', 'page.js']);
const CODE_EXT = /\.(tsx|ts|jsx|js|mjs)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// path do arquivo page.* → rota Next (remove route groups (x), mantém [param])
function fileToRoute(file) {
  const rel = relative(APP_DIR, file).split(sep);
  rel.pop(); // remove "page.tsx"
  const segs = rel.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  const route = '/' + segs.join('/');
  return route === '/' ? '/' : route.replace(/\/$/, '');
}

function normalizeTarget(t) {
  let s = t.split('?')[0].split('#')[0].trim();
  if (s.length > 1) s = s.replace(/\/$/, '');
  return s;
}

const allFiles = walk(SRC_DIR);

// ── 1. Rotas ──
const routes = [];
for (const f of allFiles) {
  const base = f.split(sep).pop();
  if (PAGE_FILES.has(base)) {
    routes.push({ route: fileToRoute(f), file: relative(ROOT, f).split(sep).join('/') });
  }
}

// ── 2. Links internos (targets) ──
const linkTargets = new Set();       // alvos exatos ("/x/y")
const linkPrefixes = new Set();      // prefixos antes de ${ } em template literals
const LINK_RES = [
  /href\s*=\s*["'`](\/[^"'`\s>${}]*)/g,          // href="/x"
  /href\s*=\s*\{\s*["'`](\/[^"'`${}]*)/g,        // href={'/x'}
  /href\s*:\s*["'`](\/[^"'`${}]*)/g,             // href: '/x'  (arrays de hub)
  /(?:router\s*\.\s*)?(?:push|replace)\(\s*["'`](\/[^"'`${}]*)/g, // push('/x')
];
// template literals com ${...}: captura o prefixo estático (ex.: /pedidos/wc/${id} → /pedidos/wc)
const TPL_RES = [
  /href\s*=\s*\{?\s*`(\/[^`${]*)\$\{/g,
  /(?:router\s*\.\s*)?(?:push|replace)\(\s*`(\/[^`${]*)\$\{/g,
];

for (const f of allFiles) {
  if (!CODE_EXT.test(f)) continue;
  if (f.endsWith('routes.generated.json')) continue;
  let txt;
  try { txt = readFileSync(f, 'utf8'); } catch { continue; }
  for (const re of LINK_RES) {
    let m;
    while ((m = re.exec(txt))) linkTargets.add(normalizeTarget(m[1]));
  }
  for (const re of TPL_RES) {
    let m;
    while ((m = re.exec(txt))) {
      let p = m[1].replace(/\/$/, '');
      if (p.length > 1) linkPrefixes.add(p);
    }
  }
}

// ── 3. Marca hasShortcut ──
function staticPrefix(route) {
  const i = route.indexOf('/[');
  return i === -1 ? route : route.slice(0, i);
}
function routeToRegex(route) {
  const pat = '^' + route.replace(/\[[^\]]+\]/g, '[^/]+').replace(/\//g, '\\/') + '$';
  return new RegExp(pat);
}

const rows = routes.map((r) => {
  const dynamic = r.route.includes('[');
  let hasShortcut = false;

  if (!dynamic) {
    if (linkTargets.has(r.route)) hasShortcut = true;
    // um link estático "mais fundo" (ex.: /x/y) também conta como atalho pra /x? não.
  } else {
    const rx = routeToRegex(r.route);
    for (const t of linkTargets) { if (rx.test(t)) { hasShortcut = true; break; } }
    if (!hasShortcut) {
      const sp = staticPrefix(r.route);
      // prefixo de template literal batendo com o prefixo estático da rota dinâmica
      for (const p of linkPrefixes) {
        if (p === sp || p.startsWith(sp + '/') || sp.startsWith(p + '/') || p === r.route.replace(/\/\[[^\]]+\]$/, '')) {
          hasShortcut = true; break;
        }
      }
    }
  }

  const section = r.route === '/' ? '(home)' : r.route.split('/')[1];
  return { route: r.route, section, dynamic, hasShortcut, file: r.file };
});

rows.sort((a, b) => a.route.localeCompare(b.route));

const payload = {
  generatedAt: new Date().toISOString(),
  total: rows.length,
  comAtalho: rows.filter((r) => r.hasShortcut).length,
  semAtalho: rows.filter((r) => !r.hasShortcut).length,
  rows,
};

writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`[gen-routes-map] ${rows.length} rotas · ${payload.comAtalho} com atalho · ${payload.semAtalho} sem atalho`);
console.log(`[gen-routes-map] escrito em ${relative(ROOT, OUT)}`);
