/**
 * Dispara o teste A/B da BMM-100: e-mail A pra metade A, e-mail B pra metade B.
 * Cada pessoa recebe UMA versão só — a divisão foi feita em
 * `dividir-segmento-ab.js` (segmentos 16 e 17, 14.033 cada).
 *
 * Uso: railway run --service flowops-lite node backend/scripts/disparar-ab-bmm100.js ENVIAR
 */
const https = require('https');

const PARES = [
  { tag: 'A', emailId: 137, assunto: 'A blusa mais confortável da Linha Conforto' },
  { tag: 'B', emailId: 139, assunto: 'Achei a blusa que resolve o dia a dia' },
];

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
  const enviar = process.argv[2] === 'ENVIAR';
  console.log('══ TESTE A/B — BMM-100 ══');
  for (const p of PARES) {
    const e = (await api('GET', `/emails/${p.emailId}`)).email || {};
    const listas = (e.lists || []).map((l) => `${l.name}(${l.id})`).join(', ');
    console.log(`\n  [${p.tag}] e-mail ${p.emailId} · "${String(e.subject).slice(0, 50)}"`);
    console.log(`      público: ${listas || '—'} · já enviados: ${e.sentCount}`);
    if (!enviar) continue;
    const r = await api('POST', `/emails/${p.emailId}/send`, {});
    console.log(`      🚀 disparado · sucesso=${r?.success} · enfileirados=${r?.sentCount ?? r?.pending ?? '?'}`);
  }
  if (!enviar) console.log('\n  (nada enviado — rode com ENVIAR)');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
