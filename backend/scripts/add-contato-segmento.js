/**
 * Põe um e-mail dentro de um segmento (cria o contato se não existir).
 * Uso: railway run --service flowops-lite node backend/scripts/add-contato-segmento.js <segmentoId> <email> [email2 ...]
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
  const seg = process.argv[2];
  const emails = process.argv.slice(3);
  if (!seg || !emails.length) { console.error('uso: <segmentoId> <email> [email2 ...]'); process.exit(2); }

  for (const email of emails) {
    const alvo = email.trim().toLowerCase();
    const busca = await api('GET', `/contacts?search=${encodeURIComponent(alvo)}&limit=1`);
    let id = Object.keys(busca.contacts || {})[0];
    if (!id) {
      const novo = await api('POST', '/contacts/new', { email: alvo, tags: ['teste-interno'] });
      id = novo?.contact?.id;
      if (!id) { console.log(`  ❌ ${alvo}: não criou (${JSON.stringify(novo).slice(0, 120)})`); continue; }
      console.log(`  contato criado: ${alvo} (id ${id})`);
    } else {
      console.log(`  contato já existia: ${alvo} (id ${id})`);
    }
    const r = await api('POST', `/segments/${seg}/contact/${id}/add`, {});
    console.log(`    → segmento ${seg}: ${r?.success ? 'OK' : JSON.stringify(r).slice(0, 120)}`);
  }
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
