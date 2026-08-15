/**
 * Baixa o HTML COMO ESTÁ NO MAUTIC de um e-mail, pra ver a peça exata que saiu.
 * Uso: railway run --service flowops-lite node backend/scripts/baixar-email-html.js <id> <arquivo-de-saida>
 */
const https = require('https');
const fs = require('fs');

function api(path) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');
  return new Promise((res, rej) => {
    https.get(`${base}/api${path}`, { headers: { Authorization: auth, Accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(d.slice(0, 200))); } });
    }).on('error', rej);
  });
}

(async () => {
  const id = process.argv[2];
  const saida = process.argv[3];
  const r = await api(`/emails/${id}`);
  const e = r.email || {};
  // `{unsubscribe_url}` só vira link no envio; pra visualizar, aponta pro site.
  const html = String(e.customHtml || '').replace(/\{unsubscribe_url\}/g, 'https://www.lurdsplussize.com.br');
  fs.writeFileSync(saida, html, 'utf8');
  console.log(`assunto : ${e.subject}`);
  console.log(`enviados: ${e.sentCount} · abertos: ${e.readCount}`);
  console.log(`texto   : ${(e.plainText || '').length} bytes`);
  console.log(`salvo em: ${saida} (${html.length} bytes)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
