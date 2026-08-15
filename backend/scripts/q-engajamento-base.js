/**
 * QUEM MERECE CONTINUAR RECEBENDO. Cruza todos os envios (email_stats) e separa:
 *   · ENGAJADO  — abriu pelo menos um e-mail
 *   · FRIO      — recebeu e nunca abriu
 *
 * Mandar pra 8 mil engajados entrega melhor que pra 26 mil mortos: o provedor
 * mede a taxa de abertura pra decidir se você é remetente bom.
 *
 * Uso: railway run --service flowops-lite node backend/scripts/q-engajamento-base.js
 */
const https = require('https');
const fs = require('fs');

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

async function main() {
  const abriu = new Set();      // lead_id que abriu algo
  const recebeu = new Set();    // lead_id que recebeu algo
  const emailDoLead = new Map();
  let linhas = 0;

  // A API de stats só devolve linha COM filtro `where` — sem ele volta vazio.
  // Então varre campanha por campanha (descobre os ids pela lista de e-mails).
  const lista = await api('/emails?limit=60&orderBy=id&orderByDir=DESC');
  const ids = Object.values(lista.emails || {}).map((e) => Number(e.id)).filter(Boolean);

  for (const emailId of ids) {
    for (let start = 0; start < 60000; start += 1000) {
      const r = await api(`/stats/email_stats?limit=1000&start=${start}&where[0][col]=email_id&where[0][expr]=eq&where[0][val]=${emailId}`);
      const lote = r.email_stats || [];
      for (const s of lote) {
        linhas++;
        const id = s.lead_id;
        if (!id) continue;
        recebeu.add(id);
        if (s.email_address) emailDoLead.set(id, String(s.email_address).toLowerCase());
        if (Number(s.is_read)) abriu.add(id);
      }
      process.stdout.write(`\r  campanha ${emailId}... ${linhas} envios lidos`);
      if (lote.length < 1000) break;
    }
  }
  process.stdout.write('\r');

  const frios = [...recebeu].filter((id) => !abriu.has(id));
  console.log('══ ENGAJAMENTO DA BASE ══');
  console.log(`  linhas de envio lidas : ${linhas}`);
  console.log(`  pessoas que RECEBERAM : ${recebeu.size}`);
  console.log(`  ✅ ENGAJADAS (abriram): ${abriu.size}  (${((abriu.size / recebeu.size) * 100).toFixed(1)}%)`);
  console.log(`  ❄️  FRIAS (nunca abriram): ${frios.length}`);

  const saida = process.argv[2] || 'engajados.json';
  fs.writeFileSync(saida, JSON.stringify({
    engajados: [...abriu],
    frios,
    emails: Object.fromEntries([...abriu].map((id) => [id, emailDoLead.get(id)]).filter(([, e]) => e)),
  }, null, 0));
  console.log(`\n  ids salvos em ${saida}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
