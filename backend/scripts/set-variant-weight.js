/**
 * Define o peso da variante A/B (quantos % da lista recebem a variante).
 * Sem peso o Mautic pode mandar tudo pro pai e o teste não acontece.
 * Uso: railway run --service flowops-lite node backend/scripts/set-variant-weight.js <idVariante> <peso>
 */
const https = require('https');
function api(method, path, body) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');
  const data = body ? JSON.stringify(body) : null;
  return new Promise((res, rej) => {
    const r = https.request(`${base}/api${path}`, {
      method,
      headers: {
        Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (rs) => {
      let d = ''; rs.on('data', (c) => (d += c));
      rs.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${rs.statusCode}: ${d.slice(0, 200)}`)); } });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
(async () => {
  const id = process.argv[2], peso = process.argv[3] || '50', pai = process.argv[4];
  // ⚠️ O PATCH do Mautic SUBSTITUI: mandar só `variantSettings` apaga o
  // `variantParent` e desfaz o A/B. Os dois têm que ir na mesma requisição.
  const body = { variantSettings: { weight: peso, winnerCriteria: 'email.openrate', totalWeight: '100' } };
  if (pai) body.variantParent = Number(pai);
  const r = await api('PATCH', `/emails/${id}/edit`, body);
  const e = r.email || {};
  console.log(`e-mail ${id}: variantParent=${e.variantParent?.id ?? '—'} · variantSettings=${JSON.stringify(e.variantSettings || {})}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
