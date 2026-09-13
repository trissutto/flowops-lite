/**
 * CONFERÊNCIA da conta LOJAS FÍSICAS (956-499-8046) — só leitura, nunca escreve.
 *
 * Existe pra provar o estado DEPOIS de uma aplicação de orçamento
 * (`google-ads-lojas-orcamento.js`), sem depender da interface — que em
 * 13/09/2026 não abriu o painel de edição nenhuma vez.
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';

const brl = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
const microsParaReais = (m) => Number(m || 0) / 1_000_000;

async function token() {
  const b = new URLSearchParams({
    client_id: (process.env.GOOGLE_ADS_CLIENT_ID || '').trim(),
    client_secret: (process.env.GOOGLE_ADS_CLIENT_SECRET || '').trim(),
    refresh_token: (process.env.GOOGLE_ADS_REFRESH_TOKEN || '').trim(),
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: b,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('OAuth falhou');
  return j.access_token;
}

function headers(a) {
  const h = {
    Authorization: `Bearer ${a}`,
    'developer-token': (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim(),
    'Content-Type': 'application/json',
  };
  const mcc = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim().replace(/\D/g, '');
  if (mcc) h['login-customer-id'] = mcc;
  return h;
}

async function consultar(a, gaql) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`,
    { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${t.slice(0, 800)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function main() {
  const a = await token();
  const linhas = await consultar(
    a,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign_budget.amount_micros
       FROM campaign
      WHERE campaign.status IN ('ENABLED','PAUSED')`,
  );

  const cs = linhas
    .map((l) => ({
      nome: l.campaign.name,
      status: l.campaign.status,
      tipo: l.campaign.advertisingChannelType,
      orc: microsParaReais(l.campaignBudget.amountMicros),
    }))
    .sort((x, y) => y.orc - x.orc);

  const ativas = cs.filter((c) => c.status === 'ENABLED');
  const total = ativas.reduce((s, c) => s + c.orc, 0);

  console.log(`conta ${CONTA} · ${ativas.length} ativas · orçamento total ${brl(total)}/dia\n`);
  console.log('ATIVAS (por orçamento)');
  for (const c of ativas) console.log(`  ${brl(c.orc).padEnd(12)} ${c.nome}`);

  const pausadas = cs.filter((c) => c.status === 'PAUSED');
  console.log(`\nPAUSADAS: ${pausadas.length}`);
  for (const c of pausadas.slice(0, 12)) console.log(`  ${brl(c.orc).padEnd(12)} ${c.nome}`);
  if (pausadas.length > 12) console.log(`  ... e mais ${pausadas.length - 12}`);
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
