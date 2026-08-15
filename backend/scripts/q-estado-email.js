/** Estado de e-mails do Mautic: publicação, agendamento, variante, público. */
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
  for (const id of process.argv.slice(2)) {
    const e = (await api(`/emails/${id}`)).email || {};
    console.log(`\n  e-mail ${id}: "${String(e.subject).slice(0, 55)}"`);
    console.log(`    publicado ${e.isPublished} · publishUp: ${e.publishUp ?? '—'} · publishDown: ${e.publishDown ?? '—'}`);
    console.log(`    listas: ${(e.lists || []).map((l) => `${l.name}(${l.id})`).join(', ') || '—'}`);
    console.log(`    variantParent: ${e.variantParent?.id ?? '—'} · variantSettings: ${JSON.stringify(e.variantSettings || {})}`);
    console.log(`    enviados ${e.sentCount} · abertos ${e.readCount} · html ${(e.customHtml || '').length}B · texto ${(e.plainText || '').length}B`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
