/**
 * DISPARO DA CAMPANHA "LINHA CONFORTO" (15/08/2026, autorizado pelo dono).
 *
 * Mesma montagem do EmailMarketingService do PR fix/email-campanha-entregabilidade,
 * pra não esperar o deploy: UTM no link, descadastro de 1 clique, versão texto e
 * emoji de verdade no assunto.
 *
 * Uso (da RAIZ):
 *   railway run --service flowops-lite node backend/scripts/disparar-linha-conforto.js          → só CRIA e mostra
 *   railway run --service flowops-lite node backend/scripts/disparar-linha-conforto.js ENVIAR   → cria e DISPARA
 */
const https = require('https');

const SEGMENTO = 2; // TODOS OS CLIENTES DE TODOS OS TEMPOS
const ASSUNTO = 'A camiseta que estica muito e não dá bolinha — R$ 69,90 💛';
const ARTE = 'https://pub-84da472609374e0ab161fd54571b5f38.r2.dev/email-marketing/linha-conforto-viscolycra-6990.jpg';
const LINK = 'https://www.lurdsplussize.com.br/categoria/linha-conforto';
const CORPO = `Oi! Chegou a **Linha Conforto** em Viscolycra Premium — a camiseta que estica muito, não dá bolinha e cai bem em qualquer dia.

**R$ 69,90**, do **46 ao 60**, em 6 cores.

Toque macio, bem elástica e com caimento que não marca. É a peça que você veste no automático e sai bem.

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
      rs.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(`HTTP ${rs.statusCode}: ${d.slice(0, 300)}`)); } });
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

const slugCampanha = (assunto, agora = new Date()) => {
  const base = assunto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return `${base || 'campanha'}-${String(agora.getDate()).padStart(2, '0')}${String(agora.getMonth() + 1).padStart(2, '0')}`;
};

const comUtm = (url, campanha, temArte) => {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'email');
  u.searchParams.set('utm_medium', 'email');
  u.searchParams.set('utm_campaign', campanha);
  if (temArte) u.searchParams.set('utm_content', 'arte');
  return u.toString();
};

function montarHtml(assunto, corpo, destino, arte, descadastro) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const hero = `<tr><td style="padding:0"><a href="${destino}"><img src="${arte}" alt="${esc(assunto)}" style="display:block;width:100%;max-width:560px;border-radius:10px 10px 0 0" /></a></td></tr>`;
  const paras = corpo.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3a3630">${esc(p).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#faf9f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:10px">
    ${hero}
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0;font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#b8912b">Lurd's Plus Size</p>
      <h1 style="margin:12px 0 18px;font-size:22px;color:#1a1a1a;font-weight:600">${esc(assunto)}</h1>
    </td></tr>
    <tr><td style="padding:0 28px 8px">${paras}</td></tr>
    <tr><td style="padding:8px 28px 28px">
      <a href="${destino}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:600">Comprar agora</a>
    </td></tr>
    <tr><td style="padding:16px 28px 28px;border-top:1px solid #eee">
      <p style="margin:0;font-size:12px;color:#999">Moda plus size do 46 ao 60 · 14 lojas físicas · troca fácil.<br>
      Você recebe porque se cadastrou na Lurd's.</p>
      <p style="margin:10px 0 0;font-size:12px;color:#999">
        <a href="${descadastro}" style="color:#777;text-decoration:underline">Não quero mais receber estes e-mails</a>
      </p>
    </td></tr>
  </table>
</body></html>`;
}

const montarTexto = (assunto, corpo, destino) => [
  assunto, '', corpo.replace(/\*\*(.+?)\*\*/g, '$1').trim(), '',
  `Comprar agora: ${destino}`, '', '—',
  "Lurd's Plus Size · moda plus size do 46 ao 60 · 14 lojas físicas.",
  'Para não receber mais estes e-mails: {unsubscribe_url}',
].join('\n');

async function main() {
  const vaiEnviar = process.argv[2] === 'ENVIAR';
  const campanha = slugCampanha(ASSUNTO);
  const destino = comUtm(LINK, campanha, true);
  const html = montarHtml(ASSUNTO, CORPO, destino, ARTE, '{unsubscribe_url}');
  const texto = montarTexto(ASSUNTO, CORPO, destino);

  console.log('══ CAMPANHA ══');
  console.log(`  assunto : ${ASSUNTO}`);
  console.log(`  público : segmento ${SEGMENTO}`);
  console.log(`  link    : ${destino}`);
  console.log(`  html    : ${html.length} bytes · texto: ${texto.length} bytes`);
  console.log(`  checagens: descadastro=${html.includes('{unsubscribe_url}') ? 'OK' : 'FALTA'} · shortcode no assunto=${/:[a-z_]+:/.test(ASSUNTO) ? 'TEM (ruim)' : 'não'} · utm=${destino.includes('utm_campaign=') ? 'OK' : 'FALTA'}`);

  const criado = await api('POST', '/emails/new', {
    name: `[FlowOps] ${ASSUNTO}`.slice(0, 120),
    subject: ASSUNTO,
    customHtml: html,
    plainText: texto,
    emailType: 'list',
    lists: [SEGMENTO],
    isPublished: true,
    // `headers` NÃO passa pela API do Mautic ("não deve conter campos adicionais").
    // O List-Unsubscribe fica por conta do próprio Mautic; o que garantimos aqui
    // é o link de descadastro no corpo (HTML e texto).
  });
  const id = Number(criado?.email?.id);
  if (!id) throw new Error(`Mautic não devolveu id: ${JSON.stringify(criado).slice(0, 300)}`);
  console.log(`\n  ✔ e-mail criado no Mautic: id ${id}`);
  console.log(`    plainText salvo: ${(criado.email.plainText || '').length} bytes`);
  console.log(`    headers salvos : ${JSON.stringify(criado.email.headers || {})}`);

  if (!vaiEnviar) {
    console.log('\n  (NÃO enviado — rode de novo com ENVIAR no fim pra disparar)');
    return;
  }
  const envio = await api('POST', `/emails/${id}/send`, {});
  console.log(`\n  🚀 DISPARADO · sucesso=${envio?.success} · enfileirados=${envio?.sentCount ?? envio?.pending ?? '?'}`);
  console.log(`  utm_campaign = ${campanha}`);
}
main().catch((e) => { console.error('ERRO:', e.message || e); process.exit(1); });
