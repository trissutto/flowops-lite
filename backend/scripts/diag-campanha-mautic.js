/**
 * Métricas da última campanha de e-mail no Mautic (envios/aberturas/cliques).
 * Lê pela API (Basic Auth) — rodar da RAIZ (linkada ao flowops-lite):
 *   railway run --service flowops-lite node backend/scripts/diag-campanha-mautic.js ["trecho do assunto"]
 */
const https = require('https');

function api(path) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const user = process.env.MAUTIC_USER, pass = process.env.MAUTIC_PASS;
  if (!base || !user || !pass) { console.error('MAUTIC_BASE/USER/PASS ausentes — rode com railway run --service flowops-lite'); process.exit(2); }
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  return new Promise((res, rej) => {
    https.get(`${base}/api${path}`, { headers: { Authorization: auth, Accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(d.slice(0, 200))); } });
    }).on('error', rej);
  });
}

async function main() {
  const filtro = (process.argv[2] || 'Inaugura').toLowerCase();
  const data = await api('/emails?orderBy=dateAdded&orderByDir=DESC&limit=10');
  const emails = Object.values(data.emails || {});
  const alvo = emails.filter((e) => String(e.subject || e.name || '').toLowerCase().includes(filtro));
  const lista = alvo.length ? alvo : emails.slice(0, 3);

  console.log(`══ CAMPANHAS (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC) ══`);
  for (const e of lista) {
    const sent = Number(e.sentCount || 0);
    const read = Number(e.readCount || 0);
    const taxa = sent ? ((read / sent) * 100).toFixed(1) : '0';
    console.log(`\n  "${e.subject || e.name}" (id ${e.id})`);
    console.log(`    enviados: ${sent} | aberturas: ${read} (${taxa}%) | publicado: ${e.isPublished ? 'sim' : 'não'}`);
  }
  if (!lista.length) console.log('  (nenhum e-mail encontrado)');
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
