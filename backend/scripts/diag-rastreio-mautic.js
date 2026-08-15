/**
 * O e-mail chegou e o rastreio é que está cego? Compara o HTML COMO SAIU
 * (julho x agosto) e testa o endpoint de rastreio do Mautic.
 *
 * Duas coisas passam por mkt.lurds.com.br: o pixel de abertura e o redirect de
 * clique. Se os links do nosso e-mail NÃO foram reescritos pro Mautic, o clique
 * vai direto pro site — a cliente compra e o Mautic não vê nada.
 *
 * Rodar da RAIZ:
 *   railway run --service flowops-lite node backend/scripts/diag-rastreio-mautic.js
 */
const https = require('https');

function api(path) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');
  return new Promise((res, rej) => {
    https.get(`${base}/api${path}`, { headers: { Authorization: auth, Accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${r.statusCode}: ${d.slice(0, 150)}`)); } });
    }).on('error', rej);
  });
}

/** GET cru (sem auth) — pra medir o endpoint público de rastreio. */
function cru(url) {
  return new Promise((res) => {
    const req = https.get(url, { timeout: 15000 }, (r) => {
      let n = 0; r.on('data', (c) => (n += c.length));
      r.on('end', () => res({ status: r.statusCode, tipo: r.headers['content-type'] || '?', bytes: n, local: r.headers.location }));
    });
    req.on('timeout', () => { req.destroy(); res({ status: 'TIMEOUT' }); });
    req.on('error', (e) => res({ status: `ERRO ${e.code || e.message}` }));
  });
}

async function main() {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');

  console.log('══ LINKS DENTRO DO E-MAIL (como está salvo) ══');
  for (const id of [126, 127, 129, 131, 132]) {
    const r = await api(`/emails/${id}`);
    const e = r.email || {};
    const html = e.customHtml || '';
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const paraMautic = hrefs.filter((h) => h.includes('mkt.lurds') || h.includes('/r/') || h.includes('{trackable')).length;
    const tokens = [...html.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
    console.log(`\n  email ${id} (${String(e.dateAdded).slice(0, 10)}) · ${hrefs.length} links · ${paraMautic} apontando pro Mautic`);
    console.log(`    tokens do Mautic no HTML: ${tokens.length ? [...new Set(tokens)].join(', ') : '❌ NENHUM'}`);
    console.log(`    primeiros links: ${hrefs.slice(0, 3).map((h) => h.slice(0, 70)).join(' | ') || '—'}`);
  }

  console.log('\n══ ENDPOINT DE RASTREIO DO MAUTIC ══');
  const alvos = [
    ['pixel de abertura', `${base}/email/EMAILHASH.gif`],
    ['pixel (rota alternativa)', `${base}/mtracking.gif`],
    ['home do Mautic', `${base}/`],
  ];
  for (const [nome, url] of alvos) {
    const r = await cru(url);
    console.log(`  ${nome.padEnd(26)} → ${r.status} ${r.tipo ? `(${r.tipo}, ${r.bytes}B)` : ''}${r.local ? ` → ${r.local}` : ''}`);
  }

  console.log('\n══ O MAUTIC ESTÁ CONFIGURADO PRA RASTREAR? ══');
  try {
    // Se a instalação tem trackables registrados por campanha, aparece aqui.
    const t = await api('/stats/channel_url_trackables?limit=5&order[0][col]=channel_id&order[0][dir]=DESC');
    const rows = t.channel_url_trackables || [];
    console.log(`  links rastreáveis registrados (5 mais recentes):`);
    for (const r of rows) console.log(`    campanha ${r.channel_id} · url_id ${r.url_id} · hits ${r.hits} · únicos ${r.unique_hits}`);
    if (!rows.length) console.log('    (nenhum)');
  } catch (e) { console.log(`  erro: ${e.message}`); }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
