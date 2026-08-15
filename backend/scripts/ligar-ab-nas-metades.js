/**
 * Aponta o e-mail A pra metade A e cria o e-mail B apontando pra metade B.
 *
 * O B nasce NOVO (e não reaproveita o 138) porque aquele ficou preso como
 * variante do 137 e a API do Mautic não desfaz esse vínculo — variante herda o
 * público do pai e o teste sairia torto.
 *
 * Uso: railway run --service flowops-lite node backend/scripts/ligar-ab-nas-metades.js <idEmailA> <segA> <segB>
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

const ASSUNTO_B = 'Achei a blusa que resolve o dia a dia (e veste do 46 ao 60)';

(async () => {
  const [idA, segA, segB] = process.argv.slice(2);
  if (!idA || !segA || !segB) { console.error('uso: <idEmailA> <segA> <segB>'); process.exit(2); }

  // A: só troca o público pra metade A.
  const a = await api('PATCH', `/emails/${idA}/edit`, { lists: [Number(segA)] });
  console.log(`  A (e-mail ${idA}): "${a.email?.subject}"`);
  console.log(`     listas → ${(a.email?.lists || []).map((l) => `${l.name}(${l.id})`).join(', ')}`);

  // B: nasce do HTML do A, trocando assunto e o utm_content de a→b.
  const html = String(a.email?.customHtml || '').replace(/utm_content=assunto-a/g, 'utm_content=assunto-b');
  const texto = String(a.email?.plainText || '').replace(/utm_content=assunto-a/g, 'utm_content=assunto-b');
  const htmlB = html.replace(/<h1([^>]*)>[^<]*<\/h1>/, `<h1$1>${ASSUNTO_B}</h1>`);

  const b = await api('POST', '/emails/new', {
    name: `[FlowOps] BMM-100 B — ${ASSUNTO_B}`.slice(0, 120),
    subject: ASSUNTO_B,
    customHtml: htmlB,
    plainText: texto.replace(/^.*\n/, `${ASSUNTO_B}\n`),
    emailType: 'list',
    lists: [Number(segB)],
    isPublished: true,
  });
  console.log(`\n  B (e-mail ${b.email?.id}): "${b.email?.subject}"`);
  console.log(`     listas → ${(b.email?.lists || []).map((l) => `${l.name}(${l.id})`).join(', ')}`);
  console.log(`     utm_content=assunto-b: ${String(b.email?.customHtml || '').includes('assunto-b') ? 'OK' : '❌'}`);

  console.log(`\n  pra disparar:  A=${idA}  B=${b.email?.id}`);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
