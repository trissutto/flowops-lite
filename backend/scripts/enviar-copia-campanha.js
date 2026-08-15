/**
 * Manda uma cópia REAL da campanha pra um endereço (o dono, pra ver como a
 * cliente vê). Cria/acha o contato no Mautic e dispara aquele e-mail só pra ele
 * — passa pelo mesmo SES e pelos mesmos tokens do envio de verdade, coisa que a
 * "prévia" (que sai pelo nosso SES) não testa.
 *
 * Uso: railway run --service flowops-lite node backend/scripts/enviar-copia-campanha.js <emailId> <destino>
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
      rs.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${rs.statusCode}: ${d.slice(0, 250)}`)); } });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

(async () => {
  const emailId = process.argv[2];
  const destino = (process.argv[3] || '').trim().toLowerCase();
  if (!emailId || !destino) { console.error('uso: <emailId> <destino>'); process.exit(2); }

  // Já existe? Não duplicar contato na base.
  const busca = await api('GET', `/contacts?search=${encodeURIComponent(destino)}&limit=1`);
  let contatoId = Object.keys(busca.contacts || {})[0];

  if (contatoId) {
    console.log(`  contato já existia: id ${contatoId}`);
  } else {
    const novo = await api('POST', '/contacts/new', { email: destino, firstname: 'Thiago', tags: ['teste-interno'] });
    contatoId = novo?.contact?.id;
    if (!contatoId) throw new Error(`não criou o contato: ${JSON.stringify(novo).slice(0, 200)}`);
    console.log(`  contato criado: id ${contatoId}`);
  }

  const r = await api('POST', `/emails/${emailId}/contact/${contatoId}/send`, {});
  console.log(`\n  ✉️  cópia de "${emailId}" enviada pra ${destino} · sucesso=${r?.success ?? JSON.stringify(r).slice(0, 120)}`);
  console.log('  (chega pelo mesmo SES e com os mesmos tokens do disparo real)');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
