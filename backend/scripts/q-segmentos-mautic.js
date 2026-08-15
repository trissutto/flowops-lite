/** Segmentos do Mautic com contagem de hoje — pra escolher o público do disparo. */
const https = require('https');
function api(path) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');
  return new Promise((res, rej) => {
    https.get(`${base}/api${path}`, { headers: { Authorization: auth, Accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(d.slice(0, 150))); } });
    }).on('error', rej);
  });
}
(async () => {
  const data = await api('/segments?limit=200');
  const lista = Object.values(data.lists || {})
    .map((s) => ({ id: Number(s.id), nome: s.name, contatos: s.leadCount != null ? Number(s.leadCount) : null }))
    .sort((a, b) => (b.contatos ?? 0) - (a.contatos ?? 0));
  for (const s of lista) console.log(`  id ${String(s.id).padStart(3)} · ${String(s.contatos ?? '?').padStart(7)} contatos · ${s.nome}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
