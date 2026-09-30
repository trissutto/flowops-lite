/**
 * EXCLUI as compradoras de uma campanha de AQUISIÇÃO.
 *
 * Por quê: campanha de aquisição existe pra comprar gente NOVA. Quando ela
 * paga o clique de quem já é cliente, o dinheiro compra uma venda que viria
 * de qualquer jeito — e a cliente antiga fica sem campanha própria, com a
 * mensagem errada.
 *
 * 🚨 NÃO é para toda campanha. Excluir de uma campanha que VENDE muito derruba
 * venda de verdade: cliente recorrente que clicaria no Shopping e compraria
 * simplesmente não vê mais o anúncio. O caso seguro é a campanha de MARCA
 * (quem busca "Lurds" já decidiu; ali o pago rouba do orgânico). Antes de
 * excluir de uma campanha de produto, meça quanto dela é recompra.
 *
 *   node excluir-compradoras.js                 → só mostra o que existe hoje
 *   node excluir-compradoras.js --aplicar       → aplica a exclusão
 *
 * `CAMPANHAS` = ids separados por vírgula. `LISTA_ID` = a lista a excluir.
 */
const env = (n) => (process.env[n] || '').trim();
const CONTA = (env('LISTA_CONTA') || '8925231246').replace(/\D/g, '');
const V = env('GOOGLE_ADS_API_VERSION') || 'v25';
const APLICAR = process.argv.includes('--aplicar');
const LISTA_ID = env('LISTA_ID');
const CAMPANHAS = env('CAMPANHAS').split(',').map((c) => c.replace(/\D/g, '')).filter(Boolean);

async function token() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
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
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${j.error_description || j.error}`);
  return j.access_token;
}

let H;
async function chamar(caminho, corpo) {
  const res = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/${caminho}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(60_000),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Google ${res.status} em ${caminho}:\n${texto.slice(0, 700)}`);
  const j = JSON.parse(texto);
  // searchStream devolve ARRAY de lotes com `results` dentro — ler j.results
  // na raiz volta vazio sem erro nenhum.
  return caminho.includes('searchStream')
    ? (Array.isArray(j) ? j : [j]).flatMap((l) => l?.results ?? [])
    : j;
}

(async () => {
  H = {
    Authorization: `Bearer ${await token()}`,
    'developer-token': env('GOOGLE_ADS_DEVELOPER_TOKEN'),
    'Content-Type': 'application/json',
  };
  const mcc = env('GOOGLE_ADS_LOGIN_CUSTOMER_ID').replace(/\D/g, '');
  if (mcc) H['login-customer-id'] = mcc;

  console.log(`\n=== EXCLUSÃO DE COMPRADORAS — ${APLICAR ? 'APLICANDO' : 'só olhando'} ===\n`);

  // O que JÁ existe: exclusão repetida é erro, e público já excluído por outra
  // mão é informação antes de mexer.
  const jaTem = await chamar('googleAds:searchStream', {
    query: `
      SELECT campaign.id, campaign.name, campaign_criterion.criterion_id,
             campaign_criterion.user_list.user_list, campaign_criterion.negative,
             campaign_criterion.type
        FROM campaign_criterion
       WHERE campaign_criterion.type = 'USER_LIST'
         AND campaign.status IN ('ENABLED','PAUSED')`,
  });
  if (!jaTem.length) console.log('nenhuma campanha tem público de lista hoje.\n');
  for (const r of jaTem) {
    const c = r.campaignCriterion;
    console.log(`  ${r.campaign.name}: ${c.negative ? 'EXCLUI' : 'segmenta'} ${c.userList?.userList}`);
  }

  if (!CAMPANHAS.length || !LISTA_ID) {
    return console.log('\n(defina CAMPANHAS=<ids> e LISTA_ID=<id> pra aplicar)\n');
  }

  const recurso = `customers/${CONTA}/userLists/${LISTA_ID}`;
  const operacoes = CAMPANHAS.map((id) => ({
    create: {
      campaign: `customers/${CONTA}/campaigns/${id}`,
      userList: { userList: recurso },
      negative: true,
    },
  }));

  console.log(`\n${APLICAR ? 'excluindo' : 'validando'} a lista ${LISTA_ID} de ${CAMPANHAS.length} campanha(s)...`);
  const r = await chamar('campaignCriteria:mutate', {
    operations: operacoes,
    partialFailure: false,
    ...(APLICAR ? {} : { validateOnly: true }),
  });
  const n = (r.results || []).length;
  console.log(APLICAR ? `✓ ${n} exclusão(ões) aplicada(s)` : `✓ validado pelo Google — ${n} operação(ões) aceitas, nada gravado`);
  console.log('');
})().catch((e) => { console.error(`\nERRO: ${e.message}\n`); process.exit(1); });
