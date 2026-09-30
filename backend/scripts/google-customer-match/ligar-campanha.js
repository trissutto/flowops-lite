/**
 * LIGA (ou pausa) uma campanha. Existe porque `criar-demand-gen.js` cria tudo
 * PAUSADO de propósito — ligar é decisão do dono, não do script que criou.
 *
 *   CAMPANHA=24300304002 node ligar-campanha.js            → mostra o estado
 *   CAMPANHA=24300304002 node ligar-campanha.js --ligar    → ENABLED
 *   CAMPANHA=24300304002 node ligar-campanha.js --pausar   → PAUSED
 *
 * Antes de ligar, imprime o que a campanha vai gastar e mirar — ligar no
 * escuro é como o orçamento errado entra em produção.
 */
const env = (n) => (process.env[n] || '').trim();
const CONTA = (env('LISTA_CONTA') || '8925231246').replace(/\D/g, '');
const V = env('GOOGLE_ADS_API_VERSION') || 'v25';
const CAMPANHA = env('CAMPANHA').replace(/\D/g, '');
const LIGAR = process.argv.includes('--ligar');
const PAUSAR = process.argv.includes('--pausar');

async function token() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_ADS_CLIENT_ID'),
      client_secret: env('GOOGLE_ADS_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_ADS_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error);
  return j.access_token;
}

let H;
async function api(servico, corpo) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/${servico}`, {
    method: 'POST', headers: H, body: JSON.stringify(corpo), signal: AbortSignal.timeout(60_000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${servico} → ${r.status}: ${t.slice(0, 600)}`);
  const j = JSON.parse(t);
  return servico.includes('searchStream') ? (Array.isArray(j) ? j : [j]).flatMap((l) => l?.results ?? []) : j;
}

(async () => {
  if (!CAMPANHA) throw new Error('defina CAMPANHA=<id>');
  H = { Authorization: `Bearer ${await token()}`, 'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN'), 'Content-Type': 'application/json' };
  const mcc = env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/\D/g, '');
  if (mcc) H['login-customer-id'] = mcc;

  const [c] = await api('googleAds:searchStream', {
    query: `SELECT campaign.name, campaign.status, campaign.advertising_channel_type,
                   campaign_budget.amount_micros
              FROM campaign WHERE campaign.id = ${CAMPANHA}`,
  });
  if (!c) throw new Error(`campanha ${CAMPANHA} não encontrada`);
  const orc = (Number(c.campaignBudget.amountMicros) / 1e6).toFixed(2);
  console.log(`\n  ${c.campaign.name}`);
  console.log(`  ${c.campaign.advertisingChannelType} | status ${c.campaign.status} | R$ ${orc}/dia\n`);

  if (!LIGAR && !PAUSAR) return console.log('(--ligar ou --pausar pra mudar)\n');

  const novo = LIGAR ? 'ENABLED' : 'PAUSED';
  if (c.campaign.status === novo) return console.log(`já está ${novo} — nada a fazer\n`);

  await api('campaigns:mutate', {
    operations: [{ update: { resourceName: `customers/${CONTA}/campaigns/${CAMPANHA}`, status: novo }, updateMask: 'status' }],
  });
  console.log(`✓ agora ${novo}${LIGAR ? ` — começa a gastar até R$ ${orc}/dia` : ''}\n`);
})().catch((e) => { console.error(`\nERRO: ${e.message}\n`); process.exit(1); });
