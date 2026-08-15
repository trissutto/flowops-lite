/**
 * DIVIDE UM SEGMENTO AO MEIO em dois segmentos novos (teste A/B honesto).
 *
 * Por que não usar o A/B nativo do Mautic: a API não grava `variantSettings`
 * (o peso), e sem peso o Mautic pode mandar tudo pro pai — o teste não
 * aconteceria. Dividindo na mão, cada metade é uma lista de verdade e o
 * disparo é 100% previsível.
 *
 * A divisão é alternada (par/ímpar na ordem de leitura), não aleatória: dá o
 * mesmo resultado se rodar de novo e distribui contatos antigos e novos
 * igualmente entre as duas metades.
 *
 * Uso: railway run --service flowops-lite node backend/scripts/dividir-segmento-ab.js <segmentoOrigem> <nomeBase>
 */
const https = require('https');

function api(method, path, body) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const user = process.env.MAUTIC_USER, pass = process.env.MAUTIC_PASS;
  if (!base || !user || !pass) { console.error('MAUTIC_* ausente'); process.exit(2); }
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
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

async function main() {
  const origem = process.argv[2];
  const nomeBase = process.argv[3] || 'TESTE AB';
  if (!origem) { console.error('uso: <segmentoOrigem> <nomeBase>'); process.exit(2); }

  // 1. Descobre o alias do segmento de origem pra poder buscar os contatos.
  const segs = await api('GET', '/segments?limit=200');
  const seg = Object.values(segs.lists || {}).find((s) => String(s.id) === String(origem));
  if (!seg) throw new Error(`segmento ${origem} não encontrado`);
  console.log(`origem: ${seg.name} (${seg.alias})`);

  // 2. Baixa os ids, mantendo só quem TEM e-mail (contato sem endereço não
  //    recebe nada e só sujaria a contagem do teste).
  const ids = [];
  for (let start = 0; start < 300000; start += 1000) {
    const r = await api('GET', `/contacts?search=${encodeURIComponent('segment:' + seg.alias)}&limit=1000&start=${start}&minimal=true`);
    const lote = Object.values(r.contacts || {});
    for (const c of lote) {
      const email = String(c.fields?.core?.email?.value ?? '').trim();
      if (email) ids.push(Number(c.id));
    }
    process.stdout.write(`\r  lendo... ${ids.length} com e-mail`);
    if (lote.length < 1000) break;
  }
  process.stdout.write('\r');
  console.log(`  ${ids.length} contatos com e-mail`);

  // 3. Cria as duas metades.
  const metades = [];
  for (const tag of ['A', 'B']) {
    const nome = `${nomeBase} ${tag}`;
    const r = await api('POST', '/segments/new', {
      name: nome,
      alias: nome.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      description: `Metade ${tag} de "${seg.name}" para teste A/B de assunto.`,
      isPublished: true,
    });
    const id = Number(r?.list?.id);
    if (!id) throw new Error(`não criou "${nome}": ${JSON.stringify(r).slice(0, 200)}`);
    console.log(`  segmento criado: ${nome} = id ${id}`);
    metades.push({ tag, id, ids: [] });
  }

  // 4. Alterna: par vai pro A, ímpar pro B.
  ids.forEach((id, i) => metades[i % 2].ids.push(id));

  // 5. Adiciona em lote (500 por vez — chamada por contato levaria horas).
  for (const m of metades) {
    let feitos = 0;
    for (let i = 0; i < m.ids.length; i += 500) {
      const fatia = m.ids.slice(i, i + 500);
      await api('POST', `/segments/${m.id}/contacts/add`, { ids: fatia });
      feitos += fatia.length;
      process.stdout.write(`\r  ${m.tag}: ${feitos}/${m.ids.length}`);
    }
    process.stdout.write('\r');
    console.log(`  ✔ ${m.tag} (segmento ${m.id}): ${m.ids.length} contatos`);
  }

  console.log(`\n  A = segmento ${metades[0].id} (${metades[0].ids.length})`);
  console.log(`  B = segmento ${metades[1].id} (${metades[1].ids.length})`);
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
