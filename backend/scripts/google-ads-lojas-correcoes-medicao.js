/**
 * CORREÇÕES DE MEDIÇÃO NA CONTA LOJAS FÍSICAS (956-499-8046) — Google Ads API v25.
 *
 * Auditoria de 14/09/2026 (docs/auditorias/2026-09-14-ecossistema-google.md). Três defeitos
 * objetivos, todos reversíveis:
 *
 *  A) `[GA4] ... purchase` (880806912) e `Compra [OK]` (6502913908) estavam PRINCIPAIS e na coluna
 *     "Conversões" desta conta. O site carrega a tag `AW-878832356` desta conta junto com a do
 *     e-commerce, então a mesma venda do site podia ser creditada nas DUAS contas. Passam a
 *     secundárias (continuam visíveis em "todas as conversões", nada é apagado).
 *
 *  B) O modelo de rastreamento da CONTA era
 *       {lpurl}?utm_source={_origem}&utm_medium={_midia}&utm_campaign={_campanha}&utm_content={_conteudo}
 *     e NENHUMA campanha define `_midia`/`_campanha`/`_conteudo` (só 7 definem `_origem`). Resultado
 *     medido: o clique chega em lurds.com.br com `utm_source=&utm_medium=` VAZIOS — o GA4 classifica
 *     a sessão como "Unassigned" (71 sessões hoje, +610%) e o Flow não casa a sessão da página da
 *     loja com campanha nenhuma (sem `utm_id`). Vira o MESMO modelo que a conta ECOMM já usa:
 *       {lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={_campanha}&utm_id={campaignid}
 *     com `_campanha` definido campanha a campanha (slug do nome), porque ValueTrack não tem nome.
 *
 *  C) 7 PMax tinham modelo PRÓPRIO (o mesmo texto quebrado) — modelo de campanha substitui o da
 *     conta INTEIRO. Zerado, para herdarem o da conta.
 *
 * Mudar modelo de rastreamento NÃO reenvia anúncio para análise (só URL final faz isso) e não
 * reinicia aprendizado. Não retroage: pedido/sessão antigos ficam como estão.
 *
 * Como rodar (PowerShell, pasta do repo linkada ao Railway):
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-correcoes-medicao.js
 *   Remove-Item Env:VALIDAR; railway run --service flowops-lite node backend/scripts/google-ads-lojas-correcoes-medicao.js
 *
 * Rollback: $env:DESFAZER="1" restaura o modelo antigo na conta e nas 7 campanhas e volta as duas
 * ações a principais (os valores antigos estão fixados abaixo, lidos pela API em 14/09/2026).
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const DESFAZER = process.env.DESFAZER === '1';

const ACOES_COMPRA = ['880806912', '6502913908'];
const TEMPLATE_ANTIGO = '{lpurl}?utm_source={_origem}&utm_medium={_midia}&utm_campaign={_campanha}&utm_content={_conteudo}';
const TEMPLATE_NOVO = '{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={_campanha}&utm_id={campaignid}';
const CAMPANHAS_COM_TEMPLATE_PROPRIO = ['21282832526', '21282934223', '21282934442', '21282981806', '21286767799', '21286793977', '21286899838'];

async function token() {
  const b = new URLSearchParams({
    client_id: (process.env.GOOGLE_ADS_CLIENT_ID || '').trim(),
    client_secret: (process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim(),
    refresh_token: (process.env.GOOGLE_ADS_REFRESH_TOKEN || '').trim(),
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth falhou');
  return j.access_token;
}
function headers(a) {
  const h = { Authorization: `Bearer ${a}`, 'developer-token': (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim(), 'Content-Type': 'application/json' };
  const mcc = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim().replace(/\D/g, '');
  if (mcc) h['login-customer-id'] = mcc;
  return h;
}
function erroLegivel(t) {
  try { const j = JSON.parse(t); return (j.error?.details?.[0]?.errors || []).map((e) => `${JSON.stringify(e.errorCode)} ${e.message}`).join(' | ') || j.error?.message || t; }
  catch { return t; }
}
async function search(a, gaql) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:search`, { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) });
  const t = await r.text(); if (!r.ok) throw new Error(erroLegivel(t)); return JSON.parse(t).results || [];
}
async function mutate(a, recurso, operations, extra = {}) {
  // CustomerService é a exceção da API: `customers/{id}:mutate` com UMA `operation`, não `operations`.
  const url = recurso === 'customers'
    ? `https://googleads.googleapis.com/${V}/customers/${CONTA}:mutate`
    : `https://googleads.googleapis.com/${V}/customers/${CONTA}/${recurso}:mutate`;
  const body = recurso === 'customers' ? { operation: operations[0], validateOnly: VALIDAR } : { operations, validateOnly: VALIDAR, ...extra };
  const r = await fetch(url, { method: 'POST', headers: headers(a), body: JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(erroLegivel(t)); return JSON.parse(t);
}
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\[Petter\]|\[Pette|Petter|\d{2}\.\d{2}\.\d{2}/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 60);

(async () => {
  const a = await token();
  console.log(VALIDAR ? '== MODO VALIDAÇÃO (nada é gravado) ==' : DESFAZER ? '== DESFAZER ==' : '== APLICANDO ==');

  // A) ações de compra → secundárias (ou de volta a principais no DESFAZER)
  const acoes = await search(a, `SELECT conversion_action.id, conversion_action.name, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric FROM conversion_action WHERE conversion_action.id IN (${ACOES_COMPRA.join(',')})`);
  for (const r of acoes) console.log(`  antes: ${r.conversionAction.id} ${r.conversionAction.name} primary=${!!r.conversionAction.primaryForGoal} inConv=${!!r.conversionAction.includeInConversionsMetric}`);
  const resA = await mutate(a, 'conversionActions', ACOES_COMPRA.map((id) => ({
    update: { resourceName: `customers/${CONTA}/conversionActions/${id}`, primaryForGoal: DESFAZER }, updateMask: 'primary_for_goal',
  })));
  console.log('A) ações de compra →', DESFAZER ? 'PRINCIPAIS' : 'SECUNDÁRIAS', JSON.stringify(resA).slice(0, 200));

  // B) modelo de rastreamento da conta + custom param _campanha por campanha
  const cu = await search(a, `SELECT customer.tracking_url_template FROM customer`);
  console.log('  modelo da conta antes:', cu[0]?.customer?.trackingUrlTemplate);
  const resB = await mutate(a, 'customers', [{ update: { resourceName: `customers/${CONTA}`, trackingUrlTemplate: DESFAZER ? TEMPLATE_ANTIGO : TEMPLATE_NOVO }, updateMask: 'tracking_url_template' }]);
  console.log('B) modelo da conta →', DESFAZER ? TEMPLATE_ANTIGO : TEMPLATE_NOVO, JSON.stringify(resB).slice(0, 120));

  const camps = await search(a, `SELECT campaign.id, campaign.name, campaign.url_custom_parameters, campaign.tracking_url_template FROM campaign WHERE campaign.status != 'REMOVED'`);
  const ops = [];
  for (const r of camps) {
    const c = r.campaign;
    const params = (c.urlCustomParameters || []).filter((p) => p.key !== 'campanha');
    if (!DESFAZER) params.push({ key: 'campanha', value: slug(c.name) });
    const op = { update: { resourceName: `customers/${CONTA}/campaigns/${c.id}`, urlCustomParameters: params }, updateMask: 'url_custom_parameters' };
    if (CAMPANHAS_COM_TEMPLATE_PROPRIO.includes(String(c.id))) {
      // Limpar um campo na API = listá-lo no updateMask SEM valor no update ('' dá TOO_SHORT).
      if (DESFAZER) op.update.trackingUrlTemplate = TEMPLATE_ANTIGO;
      op.updateMask += ',tracking_url_template';
    }
    ops.push(op);
    console.log(`  ${c.id} ${c.name.slice(0, 40).padEnd(41)} _campanha=${DESFAZER ? '(remove)' : slug(c.name)}${CAMPANHAS_COM_TEMPLATE_PROPRIO.includes(String(c.id)) ? (DESFAZER ? ' +template antigo' : ' +template zerado') : ''}`);
  }
  // O mutate da conta (B) segura um lock por alguns segundos: sem esperar, TODA operação de C
  // volta CONCURRENT_MODIFICATION (aconteceu na 1ª aplicação, 14/09).
  let resC, erros;
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    if (!VALIDAR) await new Promise((r) => setTimeout(r, 10000));
    resC = await mutate(a, 'campaigns', ops, { partialFailure: true });
    erros = resC.partialFailureError?.details?.[0]?.errors || [];
    if (!erros.some((e) => e.errorCode?.databaseError === 'CONCURRENT_MODIFICATION')) break;
    console.log(`   tentativa ${tentativa}: CONCURRENT_MODIFICATION, esperando...`);
  }
  console.log(`C) ${ops.length} campanhas: ${(resC.results || []).filter((x) => x && x.resourceName).length} ok, ${erros.length} erro(s)`);
  for (const e of erros) console.log('   ERRO', JSON.stringify(e.errorCode), e.message, JSON.stringify(e.location?.fieldPathElements));

  if (!VALIDAR) {
    // conferência depois de escrever — não é formalidade
    const dep = await search(a, `SELECT customer.tracking_url_template FROM customer`);
    const ac = await search(a, `SELECT conversion_action.id, conversion_action.primary_for_goal, conversion_action.include_in_conversions_metric FROM conversion_action WHERE conversion_action.id IN (${ACOES_COMPRA.join(',')})`);
    const tp = (await search(a, `SELECT campaign.id, campaign.tracking_url_template FROM campaign WHERE campaign.status = 'ENABLED'`)).filter((r) => r.campaign.trackingUrlTemplate);
    console.log('CONFERÊNCIA: modelo da conta =', dep[0]?.customer?.trackingUrlTemplate, '| ações:', ac.map((r) => `${r.conversionAction.id}:primary=${!!r.conversionAction.primaryForGoal}`).join(' '), '| campanhas ENABLED com template próprio:', tp.length);
  }
})().catch((e) => { console.error('FALHA', e.message); process.exit(1); });
