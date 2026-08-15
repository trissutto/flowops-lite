/**
 * Compara envio a envio (email_stats) as campanhas ANTIGAS (jul, do prestador) com as NOSSAS (14/08).
 * Rodar da RAIZ:
 *   railway run --service flowops-lite node backend/scripts/diag-campanha-aberturas2.js
 */
const https = require('https');

function api(path) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');
  return new Promise((res, rej) => {
    https.get(`${base}/api${path}`, { headers: { Authorization: auth, Accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${r.statusCode}: ${d.slice(0, 200)}`)); } });
    }).on('error', rej);
  });
}

async function statsDe(emailId, limit = 500) {
  const q = `/stats/email_stats?limit=${limit}&where[0][col]=email_id&where[0][expr]=eq&where[0][val]=${emailId}`;
  const st = await api(q);
  return st.email_stats || st.stats || [];
}

async function main() {
  const alvos = [122, 125, 127, 129, 130, 131, 132];
  console.log('══ ENVIO A ENVIO (email_stats por campanha) ══');
  for (const id of alvos) {
    let rows;
    try { rows = await statsDe(id); } catch (e) { console.log(`  ${id}: erro ${e.message}`); continue; }
    if (!rows.length) { console.log(`\n  email ${id}: nenhuma linha`); continue; }
    const abertos = rows.filter((r) => Number(r.is_read)).length;
    const falhou = rows.filter((r) => Number(r.is_failed)).length;
    const semData = rows.filter((r) => !r.date_sent).length;
    const comHash = rows.filter((r) => r.tracking_hash).length;
    const d0 = rows[rows.length - 1]?.date_sent, d1 = rows[0]?.date_sent;
    console.log(`\n  email ${id}: ${rows.length} linhas lidas · abertos ${abertos} · falhou ${falhou} · sem date_sent ${semData} · com tracking_hash ${comHash}`);
    console.log(`    janela: ${d0} → ${d1}`);
    const amostra = rows[0] || {};
    console.log(`    colunas da amostra: ${Object.keys(amostra).join(', ')}`);
    console.log(`    amostra: is_read=${amostra.is_read} date_read=${amostra.date_read} open_count=${amostra.open_count} source=${amostra.source} list_id=${amostra.list_id} email_address=${String(amostra.email_address || '').replace(/(.{3}).*(@.*)/, '$1***$2')}`);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
