/**
 * O CLIQUE CHEGA NO SITE? Segue o redirect do Mautic até o destino final e
 * confere se a UTM sobrevive ao caminho.
 *
 * Se o redirect quebrar ou perder a UTM, a cliente clica e não chega (ou chega
 * sem atribuição) — e a campanha pareceria "sem venda" mesmo vendendo.
 *
 * Uso: node backend/scripts/q-testar-link-rastreio.js "<url do link rastreado>"
 */
const https = require('https');
const { URL } = require('url');

function pegar(url, metodo = 'GET') {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: metodo,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
      timeout: 20000,
    }, (r) => {
      let n = 0; r.on('data', (c) => (n += c.length));
      r.on('end', () => res({ status: r.statusCode, local: r.headers.location, bytes: n }));
    });
    req.on('timeout', () => { req.destroy(); res({ status: 'TIMEOUT' }); });
    req.on('error', (e) => res({ status: `ERRO ${e.code || e.message}` }));
    req.end();
  });
}

(async () => {
  let url = process.argv[2];
  if (!url) { console.error('passe a URL rastreada'); process.exit(2); }

  console.log('══ SEGUINDO O CLIQUE ══');
  for (let salto = 1; salto <= 6; salto++) {
    const r = await pegar(url);
    console.log(`\n  ${salto}. ${url.slice(0, 100)}${url.length > 100 ? '…' : ''}`);
    console.log(`     → ${r.status}${r.bytes ? ` (${r.bytes}B)` : ''}`);
    if (!r.local) {
      const temUtm = url.includes('utm_source=email');
      console.log(`\n  DESTINO FINAL: ${url.slice(0, 140)}`);
      console.log(`  UTM sobreviveu? ${temUtm ? '✅ SIM' : '❌ NÃO — a venda não seria atribuída ao e-mail'}`);
      console.log(`  página carregou? ${r.status === 200 ? '✅ 200' : `❌ ${r.status}`}`);
      break;
    }
    url = r.local.startsWith('http') ? r.local : new URL(r.local, url).toString();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
