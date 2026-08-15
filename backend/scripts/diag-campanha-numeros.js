/**
 * NÚMEROS EXATOS de cada campanha: enviados, abertos, cliques (total e únicos).
 * Conta pelo `total` da API (não por amostra) e cruza 3 fontes:
 *   · /emails/{id}        → sentCount / readCount que o Mautic mostra na tela
 *   · /stats/email_stats  → uma linha por envio (a verdade do disparo)
 *   · /stats/channel_url_trackables → cliques por link da campanha
 *
 * Rodar da RAIZ:
 *   railway run --service flowops-lite node backend/scripts/diag-campanha-numeros.js
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
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${r.statusCode} em ${path.slice(0, 60)}: ${d.slice(0, 150)}`)); } });
    }).on('error', rej);
  });
}

/** Varre TODAS as páginas de uma tabela de stats (não amostra). */
async function todasAsLinhas(tabela, filtros, passo = 1000, teto = 60000) {
  const where = filtros.map((f, i) => `where[${i}][col]=${f.col}&where[${i}][expr]=${f.expr}&where[${i}][val]=${encodeURIComponent(f.val)}`).join('&');
  const linhas = [];
  for (let start = 0; start < teto; start += passo) {
    const r = await api(`/stats/${tabela}?limit=${passo}&start=${start}&${where}`);
    const lote = r[tabela] || r.stats || [];
    linhas.push(...lote);
    if (lote.length < passo) break;
  }
  return linhas;
}

const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');

async function main() {
  const data = await api('/emails?orderBy=dateAdded&orderByDir=DESC&limit=15');
  const emails = Object.values(data.emails || {}).filter((e) => Number(e.sentCount || 0) > 0);
  emails.sort((a, b) => Number(a.id) - Number(b.id));

  // Cliques: uma linha por link rastreado, com hits e unique_hits por campanha.
  const cliquesPorEmail = {};
  try {
    const trk = await todasAsLinhas('channel_url_trackables', [{ col: 'channel', expr: 'eq', val: 'email' }], 1000, 20000);
    for (const t of trk) {
      const k = String(t.channel_id);
      cliquesPorEmail[k] = cliquesPorEmail[k] || { hits: 0, unicos: 0 };
      cliquesPorEmail[k].hits += Number(t.hits || 0);
      cliquesPorEmail[k].unicos += Number(t.unique_hits || 0);
    }
  } catch (e) {
    console.log(`(cliques indisponíveis: ${e.message})\n`);
  }

  const linhas = [];
  for (const e of emails) {
    const id = Number(e.id);
    const envios = await todasAsLinhas('email_stats', [{ col: 'email_id', expr: 'eq', val: id }]);
    const abertos = envios.filter((r) => Number(r.is_read)).length;
    const falhou = envios.filter((r) => Number(r.is_failed)).length;
    const c = cliquesPorEmail[String(id)] || { hits: 0, unicos: 0 };
    linhas.push({
      id,
      quando: String(e.dateAdded || '').slice(0, 10),
      assunto: String(e.subject || e.name || '').slice(0, 44),
      lista: (e.lists || []).map((l) => l.name).join(', ') || '—',
      sentCount: Number(e.sentCount || 0),
      envios: envios.length,
      abertos,
      falhou,
      cliques: c.hits,
      cliquesUnicos: c.unicos,
    });
  }

  console.log('╔══ NÚMEROS EXATOS POR CAMPANHA ══╗\n');
  const cab = ['id', 'data', 'assunto', 'enviados', 'abertos', '% abert', 'cliques', '% cliq', 'falhou'];
  console.log(cab.join(' | '));
  console.log('-'.repeat(110));
  for (const l of linhas) {
    const pa = l.envios ? ((l.abertos / l.envios) * 100).toFixed(2) : '0.00';
    const pc = l.envios ? ((l.cliquesUnicos / l.envios) * 100).toFixed(2) : '0.00';
    console.log([l.id, l.quando, l.assunto.padEnd(44), fmt(l.envios), fmt(l.abertos), `${pa}%`, fmt(l.cliquesUnicos), `${pc}%`, fmt(l.falhou)].join(' | '));
    if (l.envios !== l.sentCount) console.log(`     ⚠ o Mautic mostra sentCount=${fmt(l.sentCount)} mas há ${fmt(l.envios)} linhas de envio`);
    console.log(`     público: ${l.lista}`);
  }

  const corte = new Date('2026-08-01');
  const grupo = (filtro) => linhas.filter(filtro).reduce((a, l) => ({
    envios: a.envios + l.envios, abertos: a.abertos + l.abertos, cliques: a.cliques + l.cliquesUnicos,
  }), { envios: 0, abertos: 0, cliques: 0 });
  const antigas = grupo((l) => new Date(l.quando) < corte);
  const nossas = grupo((l) => new Date(l.quando) >= corte);

  console.log('\n╔══ TOTAIS ══╗');
  for (const [nome, g] of [['JULHO (prestador)', antigas], ['AGOSTO (pela nossa tela)', nossas]]) {
    const pa = g.envios ? ((g.abertos / g.envios) * 100).toFixed(2) : '0.00';
    const pc = g.envios ? ((g.cliques / g.envios) * 100).toFixed(2) : '0.00';
    console.log(`  ${nome}: ${fmt(g.envios)} enviados · ${fmt(g.abertos)} abertos (${pa}%) · ${fmt(g.cliques)} cliques (${pc}%)`);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
