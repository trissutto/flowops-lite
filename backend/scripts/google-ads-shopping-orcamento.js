/**
 * ORÇAMENTO DA [Petter][Shopping Padrão NOVIDADES] (23750068771, conta ECOMM 892-523-1246).
 *
 * Auditoria de 14/09/2026. O orçamento foi mexido 8 vezes em 7 dias por duas mãos
 * (300→450→600→800→500→600→1000→700 entre 02 e 08/09). O gasto dobrou (R$ 480 → R$ 900/dia)
 * e o retorno caiu: de 06 a 13/09 a campanha gastou R$ 6.485 e trouxe R$ 5.536 de receita
 * paga no Flow por último clique (ROAS 0,85); o próprio Google credita ~1,5. Meta da conta:
 * ROAS ≥ 4; tROAS da campanha: 3,2. Perda de impressão por RANKING (32% em 7d) — não é falta
 * de dinheiro, é lance/qualidade: subir orçamento não resolve, e o excesso é gasto acima da meta.
 *
 * Passo único e reversível: orçamento diário → R$ 500 (−29%, dentro do passo máximo de 30%
 * pra não chacoalhar o aprendizado). NÃO mexe no tROAS. Sem novas mexidas por 7 dias.
 *
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-shopping-orcamento.js
 *   Remove-Item Env:VALIDAR; railway run --service flowops-lite node backend/scripts/google-ads-shopping-orcamento.js
 *   $env:ORCAMENTO="700"; ...   # rollback = mesmo script com o valor anterior
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '8925231246';
const CAMPANHA = '23750068771';
const VALIDAR = process.env.VALIDAR === '1';
const ORCAMENTO = Number(process.env.ORCAMENTO || 500);

async function token() {
  const b = new URLSearchParams({ client_id: (process.env.GOOGLE_ADS_CLIENT_ID || '').trim(), client_secret: (process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim(), refresh_token: (process.env.GOOGLE_ADS_REFRESH_TOKEN || '').trim(), grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b });
  const j = await r.json(); if (!j.access_token) throw new Error('OAuth falhou'); return j.access_token;
}
function headers(a) {
  const h = { Authorization: `Bearer ${a}`, 'developer-token': (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim(), 'Content-Type': 'application/json' };
  const mcc = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim().replace(/\D/g, ''); if (mcc) h['login-customer-id'] = mcc; return h;
}
async function search(a, gaql) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:search`, { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) });
  const t = await r.text(); if (!r.ok) throw new Error(t.slice(0, 400)); return JSON.parse(t).results || [];
}
(async () => {
  const a = await token();
  const [c] = await search(a, `SELECT campaign.name, campaign.campaign_budget, campaign_budget.amount_micros, campaign.bidding_strategy_type, campaign.target_roas.target_roas FROM campaign WHERE campaign.id = ${CAMPANHA}`);
  const atual = c.campaignBudget.amountMicros / 1e6;
  console.log(`${VALIDAR ? '[VALIDAÇÃO] ' : ''}${c.campaign.name}: orçamento atual R$ ${atual}/dia, tROAS ${c.campaign.targetRoas?.targetRoas} → novo R$ ${ORCAMENTO}/dia`);
  if (!VALIDAR && Math.abs(ORCAMENTO - atual) / atual > 0.3) throw new Error('passo maior que 30% — divida em dois dias');
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/campaignBudgets:mutate`, {
    method: 'POST', headers: headers(a),
    body: JSON.stringify({ operations: [{ update: { resourceName: c.campaign.campaignBudget, amountMicros: String(Math.round(ORCAMENTO * 1e6)) }, updateMask: 'amount_micros' }], validateOnly: VALIDAR }),
  });
  const t = await r.text(); if (!r.ok) throw new Error(t.slice(0, 400));
  console.log(VALIDAR ? 'validado, nada gravado' : 'gravado: ' + t.slice(0, 120));
  if (!VALIDAR) { const [d] = await search(a, `SELECT campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${CAMPANHA}`); console.log('CONFERÊNCIA: R$', d.campaignBudget.amountMicros / 1e6, '/dia'); }
})().catch((e) => { console.error('FALHA', e.message); process.exit(1); });
