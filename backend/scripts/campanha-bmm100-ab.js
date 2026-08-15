/**
 * CAMPANHA BMM-100 COM TESTE A/B DE ASSUNTO.
 *
 * Duas correções em cima da campanha de 15/08 (que abriu 17% e não converteu):
 *   1. O botão leva pra PEÇA (/produto/ref-bmm-100), não pra categoria. A
 *      cliente abria, via "R$ 69,90", clicava e caía numa vitrine onde tinha
 *      que escolher de novo.
 *   2. Dois assuntos disputando, pra medir qual puxa mais abertura — o A é o
 *      que já rodou (17%), serve de controle.
 *
 * `utm_content` separa A de B no relatório de pedidos, então dá pra saber qual
 * assunto VENDEU, não só qual abriu.
 *
 * Uso (da RAIZ):
 *   ... campanha-bmm100-ab.js                    → só mostra o que vai fazer
 *   ... campanha-bmm100-ab.js CRIAR              → cria no Mautic, não envia
 *   ... campanha-bmm100-ab.js CRIAR <ISO-date>   → cria e agenda
 */
const https = require('https');

const SEGMENTO = 8; // GERAL [ATIVO] — 26.735 e-mails únicos
const ARTE = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/email-marketing/linha-conforto-viscolycra-6990.jpg';
const LINK = 'https://www.lurdsplussize.com.br/produto/ref-bmm-100';

// A = controle (já rodou, 17% de abertura). B = curiosidade, mecanismo diferente.
const VARIANTES = [
  { tag: 'a', assunto: 'A blusa mais confortável da Linha Conforto — R$ 69,90 💛' },
  { tag: 'b', assunto: 'Achei a blusa que resolve o dia a dia (e veste do 46 ao 60)' },
];

const CORPO = `Oi! A **Viscolycra Premium** da Linha Conforto é aquela blusa que você veste no automático e sai bem: estica muito, não dá bolinha e o caimento não marca.

**R$ 69,90** · do **46 ao 60** · 6 cores

Toque macio, bem elástica, feita pro dia a dia de verdade.

Troca fácil e retirada em qualquer uma das 14 lojas.`;

function api(method, path, body) {
  const base = (process.env.MAUTIC_BASE || '').replace(/\/+$/, '');
  const user = process.env.MAUTIC_USER, pass = process.env.MAUTIC_PASS;
  if (!base || !user || !pass) { console.error('MAUTIC_* ausente — rode com railway run'); process.exit(2); }
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
      rs.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${rs.statusCode}: ${d.slice(0, 250)}`)); } });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

const slug = (a, d = new Date()) => `${a.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')}-${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}`;

function comUtm(url, campanha, variante) {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'email');
  u.searchParams.set('utm_medium', 'email');
  u.searchParams.set('utm_campaign', campanha);
  u.searchParams.set('utm_content', `assunto-${variante}`); // é o que separa A de B na venda
  return u.toString();
}

function montarHtml(assunto, destino) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = CORPO.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3a3630">${esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`).join('');
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:10px">
    <tr><td style="padding:0"><a href="${destino}"><img src="${ARTE}" alt="${esc(assunto)}" style="display:block;width:100%;max-width:560px;border-radius:10px 10px 0 0" /></a></td></tr>
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#b8912b">Lurd's Plus Size</p>
      <h1 style="margin:12px 0 18px;font-size:22px;color:#1a1a1a;font-weight:600">${esc(assunto)}</h1>
    </td></tr>
    <tr><td style="padding:0 28px 8px">${paras}</td></tr>
    <tr><td style="padding:8px 28px 28px">
      <a href="${destino}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:600">Ver a blusa</a>
    </td></tr>
    <tr><td style="padding:16px 28px 28px;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#999">Moda plus size do 46 ao 60 · 14 lojas físicas · troca fácil.<br>Você recebe porque se cadastrou na Lurd's.</p>
      <p style="margin:10px 0 0;font-size:12px;color:#999"><a href="{unsubscribe_url}" style="color:#777;text-decoration:underline">Não quero mais receber estes e-mails</a></p>
    </td></tr>
  </table>
</body></html>`;
}

const montarTexto = (assunto, destino) => [
  assunto, '', CORPO.replace(/\*\*(.+?)\*\*/g, '$1').trim(), '',
  `Ver a blusa: ${destino}`, '', '—',
  "Lurd's Plus Size · moda plus size do 46 ao 60 · 14 lojas físicas.",
  'Para não receber mais estes e-mails: {unsubscribe_url}',
].join('\n');

async function main() {
  const criar = process.argv.includes('CRIAR');
  // Só aceita data ISO como agendamento — senão `PARENT=137` viraria publishUp
  // e o Mautic guardaria uma data inválida na campanha.
  const agendar = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}/.test(a)) || null;
  const campanha = slug('blusa viscolycra bmm100');

  console.log('══ CAMPANHA BMM-100 (A/B de assunto) ══');
  console.log(`  público  : segmento ${SEGMENTO} (GERAL [ATIVO])`);
  console.log(`  destino  : ${LINK}  ← PEÇA, não categoria`);
  console.log(`  campanha : ${campanha}`);
  if (agendar) console.log(`  agendada : ${agendar}`);

  // PARENT=<id> reaproveita um "A" já criado e só monta o "B" em cima dele —
  // evita deixar rascunho órfão no Mautic a cada tentativa.
  const parent = (process.argv.find((a) => a.startsWith('PARENT=')) || '').split('=')[1];
  const criados = parent ? [{ tag: 'a', id: Number(parent) }] : [];
  for (const v of (parent ? VARIANTES.slice(1) : VARIANTES)) {
    const destino = comUtm(LINK, campanha, v.tag);
    console.log(`\n  [${v.tag.toUpperCase()}] "${v.assunto}"`);
    console.log(`      → ${destino}`);
    if (!criar) continue;

    const body = {
      name: `[FlowOps] BMM-100 ${v.tag.toUpperCase()} — ${v.assunto}`.slice(0, 120),
      subject: v.assunto,
      customHtml: montarHtml(v.assunto, destino),
      plainText: montarTexto(v.assunto, destino),
      emailType: 'list',
      lists: [SEGMENTO],
      isPublished: true,
    };
    if (agendar) body.publishUp = agendar;

    /**
     * A/B NATIVO: o B nasce como VARIANTE do A. Sem isso, disparar os dois
     * mandaria duas mensagens pra mesma pessoa — o Mautic é quem divide a lista
     * e escolhe qual variante cada contato recebe.
     *
     * A variante TAMBÉM precisa de `lists` — sem isso a API responde 400
     * ("Either no list was selected"), mesmo herdando o público do pai.
     */
    if (criados.length) {
      body.variantParent = criados[0].id;
      body.variantSettings = { weight: '50', winnerCriteria: 'email.openrate' };
    }

    const r = await api('POST', '/emails/new', body);
    const id = Number(r?.email?.id);
    if (!id) throw new Error(`não criou ${v.tag}: ${JSON.stringify(r).slice(0, 200)}`);
    criados.push({ tag: v.tag, id });
    console.log(`      ✔ criado no Mautic: id ${id} · texto ${(r.email.plainText || '').length}B`);
  }

  // ATUALIZAR=137,138 regrava assunto/HTML/texto de e-mails já criados, na
  // ordem A,B — sem gerar rascunho novo a cada ajuste de copy.
  const atualizar = (process.argv.find((a) => a.startsWith('ATUALIZAR=')) || '').split('=')[1];
  if (atualizar) {
    const ids = atualizar.split(',').map((s) => Number(s.trim()));
    for (let i = 0; i < VARIANTES.length && i < ids.length; i++) {
      const v = VARIANTES[i];
      const destino = comUtm(LINK, campanha, v.tag);
      const r = await api('PATCH', `/emails/${ids[i]}/edit`, {
        name: `[FlowOps] BMM-100 ${v.tag.toUpperCase()} — ${v.assunto}`.slice(0, 120),
        subject: v.assunto,
        customHtml: montarHtml(v.assunto, destino),
        plainText: montarTexto(v.assunto, destino),
      });
      const e = r.email || {};
      console.log(`\n  [${v.tag.toUpperCase()}] e-mail ${ids[i]} atualizado`);
      console.log(`      assunto: "${e.subject}"`);
      console.log(`      variantParent: ${e.variantParent?.id ?? '—'} · listas: ${(e.lists || []).map((l) => l.id).join(',') || '—'}`);
    }
    return;
  }

  if (criar) {
    console.log('\n  criados (NÃO enviados):');
    for (const c of criados) console.log(`    ${c.tag.toUpperCase()} = e-mail ${c.id}`);
    console.log('\n  pra disparar: POST /emails/<id>/send em cada um (metade da lista cada).');
  } else {
    console.log('\n  (nada criado — rode com CRIAR pra gravar no Mautic)');
  }
}
main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
