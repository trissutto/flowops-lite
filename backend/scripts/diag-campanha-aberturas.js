/**
 * Por que a campanha marcou 0 abertura? Olha entrega, bounce, DNC e o pixel de tracking.
 * Rodar da RAIZ:
 *   railway run --service flowops-lite node backend/scripts/diag-campanha-aberturas.js
 */
const https = require('https');

function api(path) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const user = process.env.MAUTIC_USER, pass = process.env.MAUTIC_PASS;
  if (!base || !user || !pass) { console.error('MAUTIC_BASE/USER/PASS ausentes — rode com railway run --service flowops-lite'); process.exit(2); }
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  return new Promise((res, rej) => {
    https.get(`${base}/api${path}`, { headers: { Authorization: auth, Accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${r.statusCode} em ${path}: ${d.slice(0, 200)}`)); } });
    }).on('error', rej);
  });
}

async function main() {
  const data = await api('/emails?orderBy=dateAdded&orderByDir=DESC&limit=12');
  const emails = Object.values(data.emails || {});

  console.log('══ E-MAILS RECENTES ══');
  for (const e of emails) {
    const sent = Number(e.sentCount || 0);
    if (!sent) continue;
    console.log(`\n  id ${e.id} · "${String(e.subject || e.name).slice(0, 60)}"`);
    console.log(`    criado ${e.dateAdded} · enviados ${sent} · aberturas ${e.readCount || 0} · listas: ${(e.lists || []).map((l) => `${l.name}(${l.id})`).join(', ') || '—'}`);
    const html = e.customHtml || '';
    const pixel = /\/email\/[^"']*\.gif|mtracking\.gif|trackingPixel|\{tracking_pixel\}/i.test(html);
    const unsub = /unsubscribe_url|\{unsubscribe/i.test(html);
    const shortcode = /:[a-z_]+:/.test(String(e.subject || ''));
    console.log(`    pixel de abertura: ${pixel ? 'SIM' : '❌ NÃO'} · link de descadastro: ${unsub ? 'sim' : '❌ não'} · assunto com shortcode :emoji:: ${shortcode ? '🚩 SIM' : 'não'}`);
    console.log(`    html: ${html.length} bytes · plainText: ${(e.plainText || '').length} bytes`);
  }

  // Estatísticas cruas de envio (email_stats): é aqui que aparece bounce/aberto de verdade
  for (const table of ['email_stats']) {
    try {
      const st = await api(`/stats/${table}?limit=400&order[0][col]=id&order[0][dir]=DESC`);
      const rows = st[table] || st.stats || [];
      if (!rows.length) { console.log(`\n(${table}: sem linhas retornadas)`); continue; }
      const agg = {};
      for (const r of rows) {
        const k = r.email_id ?? 'sem-email';
        agg[k] = agg[k] || { n: 0, abertos: 0, falhou: 0, retry: 0 };
        agg[k].n++;
        if (Number(r.is_read)) agg[k].abertos++;
        if (Number(r.is_failed)) agg[k].falhou++;
        if (Number(r.retry_count)) agg[k].retry++;
      }
      console.log(`\n══ ENVIOS CRUS (${table}, últimas ${rows.length} linhas) ══`);
      for (const [k, v] of Object.entries(agg)) {
        console.log(`  email ${k}: ${v.n} envios · abertos ${v.abertos} · FALHOU ${v.falhou} · retry ${v.retry}`);
      }
    } catch (e) {
      console.log(`\n(${table} indisponível: ${e.message})`);
    }
  }

  // Contatos que não recebem mais (bounce/unsubscribe)
  try {
    const dnc = await api('/contacts?search=email_bounced&limit=1');
    console.log(`\nbounce marcados na base: ${dnc.total ?? '?'}`);
  } catch (e) { /* opcional */ }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
