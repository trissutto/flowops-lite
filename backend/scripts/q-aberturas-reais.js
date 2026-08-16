/**
 * AS ABERTURAS SÃO DE GENTE OU DE MÁQUINA?
 *
 * Apple Mail Privacy Protection e o proxy de imagem do Gmail baixam o pixel de
 * rastreio ANTES da pessoa abrir — e às vezes sem ela abrir nunca. Isso infla a
 * taxa de abertura e é a explicação clássica pra "muita abertura, nenhum
 * clique".
 *
 * Duas assinaturas de máquina:
 *   · abertura em massa nos primeiros minutos do disparo
 *   · open_count = 1 na esmagadora maioria (humano relê, robô não)
 *
 * Uso: railway run --service flowops-lite node backend/scripts/q-aberturas-reais.js <emailId>
 */
const https = require('https');

function api(path) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.MAUTIC_USER}:${process.env.MAUTIC_PASS}`).toString('base64');
  return new Promise((res, rej) => {
    https.get(`${base}/api${path}`, { headers: { Authorization: auth, Accept: 'application/json' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${r.statusCode}`)); } });
    }).on('error', rej);
  });
}

(async () => {
  const id = process.argv[2] || '135';
  const linhas = [];
  for (let start = 0; start < 40000; start += 1000) {
    const r = await api(`/stats/email_stats?limit=1000&start=${start}&where[0][col]=email_id&where[0][expr]=eq&where[0][val]=${id}`);
    const lote = r.email_stats || [];
    linhas.push(...lote);
    process.stdout.write(`\r  lendo ${linhas.length}...`);
    if (lote.length < 1000) break;
  }
  process.stdout.write('\r');

  const abertos = linhas.filter((l) => Number(l.is_read));
  const porContagem = {};
  for (const a of abertos) {
    const n = Number(a.open_count || 1);
    const faixa = n === 1 ? '1 vez' : n === 2 ? '2 vezes' : '3+ vezes';
    porContagem[faixa] = (porContagem[faixa] || 0) + 1;
  }

  console.log(`══ CAMPANHA ${id} ══`);
  console.log(`  enviados: ${linhas.length} · abertos: ${abertos.length} (${((abertos.length / linhas.length) * 100).toFixed(2)}%)`);
  console.log('\n  quantas vezes cada um abriu:');
  for (const [faixa, n] of Object.entries(porContagem).sort()) {
    console.log(`    ${faixa.padEnd(9)} ${String(n).padStart(5)} (${((n / abertos.length) * 100).toFixed(1)}%)`);
  }
  const soUma = (porContagem['1 vez'] || 0) / abertos.length;
  console.log(`\n  ${soUma > 0.9 ? '🚩' : '✅'} ${(soUma * 100).toFixed(1)}% abriram UMA vez só`);
  console.log('     acima de ~90% é assinatura de pré-carregamento automático,');
  console.log('     não de gente lendo.');
})().catch((e) => { console.error(e.message); process.exit(1); });
