/**
 * Quantas PESSOAS diferentes existem num conjunto de segmentos? Somar as
 * contagens engana — os segmentos se sobrepõem muito. Baixa os contatos de
 * cada um e cruza por e-mail (minúsculo, sem espaço).
 *
 * Também acha e-mail REPETIDO em contatos diferentes, que é o caso em que a
 * mesma pessoa receberia duas cópias (o Mautic deduplica por contato, não por
 * endereço).
 *
 * Uso: railway run --service flowops-lite node backend/scripts/q-sobreposicao-segmentos.js <alias1> <alias2> ...
 */
const https = require('https');

function api(path) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');
  return new Promise((res, rej) => {
    https.get(`${base}/api${path}`, { headers: { Authorization: auth, Accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${r.statusCode}: ${d.slice(0, 120)}`)); } });
    }).on('error', rej);
  });
}

async function contatosDoSegmento(alias) {
  const porEmail = new Map(); // email -> qtd de contatos com esse endereço
  let semEmail = 0, total = 0;
  for (let start = 0; start < 300000; start += 1000) {
    const r = await api(`/contacts?search=${encodeURIComponent('segment:' + alias)}&limit=1000&start=${start}&minimal=true`);
    const lote = Object.values(r.contacts || {});
    for (const c of lote) {
      total++;
      const e = String(c.fields?.core?.email?.value ?? c.fields?.email ?? '').trim().toLowerCase();
      if (!e) { semEmail++; continue; }
      porEmail.set(e, (porEmail.get(e) || 0) + 1);
    }
    process.stdout.write(`\r  ${alias}: ${total} lidos...`);
    if (lote.length < 1000) break;
  }
  process.stdout.write('\r');
  return { porEmail, semEmail, total };
}

async function main() {
  const aliases = process.argv.slice(2);
  if (!aliases.length) { console.error('passe os aliases dos segmentos'); process.exit(2); }

  const uniao = new Map();
  const porSegmento = [];
  for (const a of aliases) {
    const r = await contatosDoSegmento(a);
    porSegmento.push({ alias: a, ...r });
    console.log(`  ${a.padEnd(38)} ${String(r.total).padStart(7)} contatos · ${String(r.porEmail.size).padStart(7)} e-mails únicos · ${r.semEmail} sem e-mail`);
    for (const [e, n] of r.porEmail) uniao.set(e, (uniao.get(e) || 0) + n);
  }

  const duplicados = [...uniao.values()].filter((n) => n > 1).length;
  console.log('\n══ RESULTADO ══');
  console.log(`  soma bruta dos segmentos : ${porSegmento.reduce((s, r) => s + r.total, 0)}`);
  console.log(`  PESSOAS DIFERENTES       : ${uniao.size}  ← é isso que vai receber`);
  console.log(`  endereços em mais de um contato/segmento: ${duplicados}`);
  console.log(`  economia por sobreposição: ${porSegmento.reduce((s, r) => s + r.total, 0) - uniao.size}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
