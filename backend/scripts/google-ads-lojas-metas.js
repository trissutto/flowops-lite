/**
 * METAS DE LANCE das campanhas — conta LOJAS FÍSICAS (956-499-8046).
 * Tira do lance o que está MORTO, põe o que está VIVO.
 *
 * ── O PROBLEMA, MEDIDO EM 13/09/2026 ──
 *
 * A conta gasta ~R$ 800/dia e o lance automático otimiza para o VAZIO. O que
 * está declarado como sucesso:
 *
 *   ★ PURCHASE / WEBSITE ...... `Compra [OK]`, tag morta desde 19/08 às 16:13
 *                               (virada de domínio: a tag vinha do WordPress).
 *                               ZERO conversões em 30 dias.
 *   ★ STORE_VISIT / STORE ..... o Google parou de publicar em 05/09 às 09:00.
 *
 * E o que está VIVO não conta:
 *
 *     GET_DIRECTIONS / GOOGLE_HOSTED .... 4.133 em 30 dias — só relatório
 *     ENGAGEMENT / GOOGLE_HOSTED ........ 7.302 em 30 dias — só relatório
 *
 * O robô do Google aprende com EXEMPLOS de sucesso. Sem nenhum, ele não sabe
 * de quem chegar perto — e o dinheiro sai igual.
 *
 * ── 🚨 DOIS ERROS MEUS ANTES DE CHEGAR AQUI ──
 *
 * 1. A 1ª versão usava `conversionActions:mutate` para mexer em
 *    `primary_for_goal` / `include_in_conversions_metric`. Devolveu
 *    `IMMUTABLE_FIELD` e `MUTATE_NOT_ALLOWED`: esses campos NÃO são mutáveis
 *    nesse recurso na v25, e as ações `Local actions` são hospedadas pelo
 *    Google — não aceitam mutação nenhuma.
 *
 * 2. O recurso certo parecia ser `customer_conversion_goal` (meta da CONTA).
 *    Também estaria errado: as 26 campanhas ativas têm
 *    `conversion_goal_campaign_config.goal_config_level = CAMPAIGN`, ou seja
 *    **meta PRÓPRIA**. Mexer na conta não teria efeito nenhum nelas — eu teria
 *    "consertado" e o lance continuaria no vazio, sem nenhum erro aparecendo.
 *
 * O recurso certo é **`campaign_conversion_goal`**, campanha por campanha.
 * Lição: antes de mutar meta, conferir SEMPRE o `goal_config_level`.
 *
 * ── O QUE MUDA, E O RISCO ──
 *
 * Liga GET_DIRECTIONS como meta de lance: o robô passa a ter ~138 exemplos por
 * dia de "esta pessoa pediu o caminho até a loja" e redireciona a verba para
 * quem se parece com ela.
 *
 * ⚠️ Pedir rota NÃO é entrar na loja e comprar. O robô vai ficar bom em gerar
 * pedidos de rota — é o que se mandou. Se rota não tiver relação com visita, a
 * gente ganha mais de um número que não importa. É aposta, não fato. O que a
 * confirma é a receita da loja subir onde os pedidos de rota subiram.
 * Ainda assim é melhor que otimizar para zero, que é o estado de hoje.
 *
 * Só GET_DIRECTIONS sobe. ENGAGEMENT (7.302) fica de fora de propósito: é
 * "qualquer interação", sinal fraco, e somar os dois dilui o que o robô
 * persegue.
 *
 * PURCHASE/WEBSITE sai do lance — está morta E é venda de site numa conta de
 * loja física, o que a diretriz do dono já proibia.
 * STORE_VISIT continua ligada: a configuração está certa, quem parou foi o
 * Google. Se o modelo voltar, ela volta contando sozinha.
 *
 * ── COMO RODAR (PowerShell) ──
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-metas.js
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-metas.js
 *   $env:VALIDAR=""; $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-metas.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

/** Meta que PASSA a mandar no lance. */
const LIGAR = [{ categoria: 'GET_DIRECTIONS', origem: 'GOOGLE_HOSTED' }];
/** Metas que SAEM do lance — mortas e/ou venda de site em conta de loja. */
const DESLIGAR = [
  { categoria: 'PURCHASE', origem: 'WEBSITE' },
  { categoria: 'ADD_TO_CART', origem: 'WEBSITE' },
  { categoria: 'BEGIN_CHECKOUT', origem: 'WEBSITE' },
];

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
  const h = {
    Authorization: `Bearer ${a}`,
    'developer-token': (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '').trim(),
    'Content-Type': 'application/json',
  };
  const mcc = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim().replace(/\D/g, '');
  if (mcc) h['login-customer-id'] = mcc;
  return h;
}

function erroLegivel(t) {
  try {
    const bruto = JSON.parse(t);
    const j = Array.isArray(bruto) ? bruto[0] : bruto;
    const errs = j.error?.details?.[0]?.errors || [];
    const quota = errs.find((e) => e.errorCode?.quotaError);
    if (quota) {
      const s = /Retry in (\d+) seconds/.exec(quota.message || '')?.[1];
      return `COTA ESGOTADA${s ? ` — o Google pede ${s}s ≈ ${(s / 3600).toFixed(1)}h` : ''}`;
    }
    return errs.map((e) => `${JSON.stringify(e.errorCode)}: ${e.message}`).join(' | ') || j.error?.message || t;
  } catch {
    return t;
  }
}

async function consultar(a, gaql) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`,
    { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 700)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function mutate(a, operations) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/campaignConversionGoals:mutate`, {
    method: 'POST',
    headers: headers(a),
    body: JSON.stringify({ operations, validateOnly: VALIDAR || !APLICAR }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 900)}`);
  return JSON.parse(t);
}

async function main() {
  const modo = APLICAR && !VALIDAR ? '🔴 APLICANDO' : VALIDAR ? '🟡 validateOnly' : '🟢 DRY-RUN';
  console.log(`conta ${CONTA} · API ${V} · ${modo}\n`);
  const a = await token();

  /* 🚨 CONFERIR O NÍVEL ANTES DE QUALQUER COISA. Campanha em ACCOUNT ignora a
   * meta própria e segue a da conta — mexer aqui não faria efeito e o erro
   * seria SILENCIOSO. */
  const nivel = await consultar(
    a,
    `SELECT campaign.name, campaign.status, conversion_goal_campaign_config.goal_config_level
       FROM conversion_goal_campaign_config
      WHERE campaign.status = 'ENABLED'`,
  );
  const porNivel = {};
  for (const x of nivel) {
    const n = x.conversionGoalCampaignConfig.goalConfigLevel;
    porNivel[n] = (porNivel[n] || 0) + 1;
  }
  console.log('nível da meta nas campanhas ativas:', porNivel);
  if (porNivel.ACCOUNT) {
    console.log(
      `⚠️ ${porNivel.ACCOUNT} campanha(s) em ACCOUNT — essas seguem a meta da CONTA e NÃO` +
        `\n   são afetadas por este script. Para elas o recurso é customer_conversion_goal.`,
    );
  }

  const metas = await consultar(
    a,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign_conversion_goal.resource_name, campaign_conversion_goal.category,
            campaign_conversion_goal.origin, campaign_conversion_goal.biddable
       FROM campaign_conversion_goal
      WHERE campaign.status = 'ENABLED'`,
  );

  const porCampanha = new Map();
  for (const x of metas) {
    const l = porCampanha.get(x.campaign.name) || [];
    l.push({ ...x.campaignConversionGoal, tipo: x.campaign.advertisingChannelType });
    porCampanha.set(x.campaign.name, l);
  }

  const casa = (g, lista) => lista.some((y) => y.categoria === g.category && y.origem === g.origin);

  const ops = [];
  const resumo = [];
  for (const [campanha, lista] of [...porCampanha].sort()) {
    const liga = lista.filter((g) => casa(g, LIGAR) && !g.biddable);
    const desliga = lista.filter((g) => casa(g, DESLIGAR) && g.biddable);
    const jaLance = lista.filter((g) => g.biddable).map((g) => `${g.category}/${g.origin}`);

    for (const g of liga) {
      ops.push({ update: { resourceName: g.resourceName, biddable: true }, updateMask: 'biddable' });
    }
    for (const g of desliga) {
      ops.push({ update: { resourceName: g.resourceName, biddable: false }, updateMask: 'biddable' });
    }
    resumo.push({ campanha, tipo: lista[0]?.tipo, jaLance, liga, desliga });
  }

  console.log('\nPOR CAMPANHA  (★ = manda no lance hoje)');
  for (const r of resumo) {
    console.log(`\n${r.campanha}  [${r.tipo}]`);
    console.log(`  hoje: ${r.jaLance.length ? r.jaLance.map((x) => '★ ' + x).join(' · ') : '(nenhuma)'}`);
    for (const g of r.liga) console.log(`  + LIGA  ${g.category}/${g.origin}`);
    for (const g of r.desliga) console.log(`  − TIRA  ${g.category}/${g.origin}`);
    if (!r.liga.length && !r.desliga.length) console.log('  (nada a mudar)');
  }

  console.log(`\n${ops.length} operações em ${resumo.filter((r) => r.liga.length || r.desliga.length).length} campanhas`);

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada enviado. Para validar: $env:VALIDAR="1"');
    return;
  }
  if (!ops.length) return console.log('nada a fazer');

  const r = await mutate(a, ops);
  console.log(
    VALIDAR
      ? `\n🟡 validateOnly — o Google aceitou as ${ops.length} operações. Nada alterado.`
      : `\n🔴 APLICADO — ${(r.results || []).length} metas atualizadas.`,
  );
  if (APLICAR && !VALIDAR) console.log('\nRode em DRY-RUN de novo pra ver o depois provado pela própria API.');
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
