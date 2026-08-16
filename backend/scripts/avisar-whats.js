/**
 * Manda um aviso no WhatsApp do dono pela Evolution (instância transacional).
 * Uso: railway run --service flowops-lite node backend/scripts/avisar-whats.js <numero> "<texto>"
 *
 * NUNCA usar isto pra disparo em massa — a instância `lurds-abandono` é o
 * número TRANSACIONAL (rastreio, abandono, pedido pago). Ban por broadcast
 * derruba a operação junto.
 */
const https = require('https');
const { URL } = require('url');

function post(url, apikey, body) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const r = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey, 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000,
    }, (rs) => {
      let d = ''; rs.on('data', (c) => (d += c));
      rs.on('end', () => res({ status: rs.statusCode, body: d.slice(0, 300) }));
    });
    r.on('timeout', () => { r.destroy(); res({ status: 'TIMEOUT' }); });
    r.on('error', (e) => rej(e));
    r.write(data); r.end();
  });
}

(async () => {
  const base = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
  const inst = process.env.EVOLUTION_INSTANCE;
  const key = process.env.EVOLUTION_KEY;
  if (!base || !inst || !key) { console.error('EVOLUTION_URL/INSTANCE/KEY ausentes — rode com railway run'); process.exit(2); }

  let numero = String(process.argv[2] || '').replace(/\D/g, '');
  if (!numero.startsWith('55')) numero = `55${numero}`;
  const texto = process.argv[3];
  if (!numero || !texto) { console.error('uso: <numero> "<texto>"'); process.exit(2); }

  const r = await post(`${base}/message/sendText/${inst}`, key, { number: numero, text: texto });
  console.log(`Evolution ${inst} → ${numero}: HTTP ${r.status}`);
  console.log(r.body);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
