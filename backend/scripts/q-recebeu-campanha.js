/**
 * Um e-mail específico recebeu a campanha? Procura nos envios (email_stats).
 * Uso: railway run --service flowops-lite node backend/scripts/q-recebeu-campanha.js <emailId> <trecho-do-endereco>
 */
const https = require('https');
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
  const id = process.argv[2] || '135';
  const alvo = (process.argv[3] || 'trissutto').toLowerCase();
  const achados = [];
  let total = 0;
  for (let start = 0; start < 20000; start += 1000) {
    const r = await api(`/stats/email_stats?limit=1000&start=${start}&where[0][col]=email_id&where[0][expr]=eq&where[0][val]=${id}`);
    const lote = r.email_stats || [];
    total += lote.length;
    achados.push(...lote.filter((x) => String(x.email_address || '').toLowerCase().includes(alvo)));
    if (lote.length < 1000) break;
  }
  console.log(`campanha ${id}: ${total} envios registrados`);
  if (!achados.length) { console.log(`  ❌ nenhum endereço com "${alvo}" na lista — você NÃO está no segmento`); return; }
  for (const a of achados) {
    console.log(`  ✔ ${a.email_address} · enviado ${a.date_sent} · lido=${a.is_read} · falhou=${a.is_failed}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
