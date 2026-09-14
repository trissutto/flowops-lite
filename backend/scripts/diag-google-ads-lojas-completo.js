/**
 * AS CAMPANHAS ESTÃO CERTAS PRA TRAZER GENTE À LOJA? — conferência completa.
 * Só leitura.
 *
 * Existe porque eu afirmei coisas hoje que a medição depois derrubou — quatro
 * vezes. Este script mede as três coisas que EU AINDA NÃO TINHA OLHADO e que
 * decidem se a campanha local funciona:
 *
 *   1. ESTRATÉGIA DE LANCE — a mais perigosa. Campanha de loja com ROAS
 *      desejado é armadilha: não há receita de site pra perseguir, e o robô
 *      estrangula a ENTREGA em vez de gastar (foi o que derrubou o Shopping em
 *      agosto: cliques de 487 pra 109 com o custo igual).
 *   2. RAIO GEOGRÁFICO — campanha de Sorocaba mirando o Brasil inteiro gasta
 *      com quem nunca vai entrar na loja. É o desperdício mais caro que existe
 *      em campanha local, e nada na tela de criativo denuncia.
 *   3. PALAVRA-CHAVE — PMax não tem palavra-chave (tem tema de pesquisa, já
 *      conferido). Mas as campanhas de PESQUISA têm, e ninguém olhou ainda.
 *      Também checa o NEGATIVO: sem negativa, campanha de loja paga por
 *      "roupa plus size atacado", "como fazer", "usada".
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas-completo.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';

const brl = (m) => `R$ ${(Number(m || 0) / 1_000_000).toFixed(2).replace('.', ',')}`;

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

async function consultar(a, gaql) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`,
    { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${t.slice(0, 500)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function main() {
  console.log(`conta ${CONTA} · API ${V} · SÓ LEITURA\n`);
  const a = await token();

  /* ── 1) ESTRATÉGIA DE LANCE ──────────────────────────────────────────── */
  const camps = await consultar(
    a,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.bidding_strategy_type, campaign.maximize_conversions.target_cpa_micros,
            campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
            campaign.maximize_conversion_value.target_roas, campaign_budget.amount_micros
       FROM campaign WHERE campaign.status = 'ENABLED'`,
  );
  console.log('1) ESTRATÉGIA DE LANCE');
  const porEstrategia = {};
  for (const x of camps) {
    const c = x.campaign;
    porEstrategia[c.biddingStrategyType] = (porEstrategia[c.biddingStrategyType] || 0) + 1;
  }
  console.log('  ', porEstrategia);
  for (const x of camps.sort((p, q) => p.campaign.name.localeCompare(q.campaign.name))) {
    const c = x.campaign;
    const alvo =
      c.targetCpa?.targetCpaMicros ? `CPA alvo ${brl(c.targetCpa.targetCpaMicros)}` :
      c.maximizeConversions?.targetCpaMicros ? `CPA alvo ${brl(c.maximizeConversions.targetCpaMicros)}` :
      c.targetRoas?.targetRoas ? `🚨 ROAS alvo ${c.targetRoas.targetRoas}` :
      c.maximizeConversionValue?.targetRoas ? `🚨 ROAS alvo ${c.maximizeConversionValue.targetRoas}` : 'sem alvo';
    console.log(`  ${String(c.biddingStrategyType).padEnd(26)} ${alvo.padEnd(24)} ${brl(x.campaignBudget.amountMicros)}/dia  ${c.name}`);
  }

  /* ── 2) RAIO GEOGRÁFICO ──────────────────────────────────────────────── */
  const geo = await consultar(
    a,
    `SELECT campaign.name, campaign.status,
            campaign_criterion.type, campaign_criterion.negative,
            campaign_criterion.location.geo_target_constant,
            campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units,
            campaign_criterion.proximity.address.city_name
       FROM campaign_criterion
      WHERE campaign.status = 'ENABLED'
        AND campaign_criterion.type IN ('LOCATION','PROXIMITY')`,
  );
  const porCamp = new Map();
  for (const x of geo) {
    const l = porCamp.get(x.campaign.name) || { loc: [], prox: [], neg: 0 };
    const cc = x.campaignCriterion;
    if (cc.negative) l.neg++;
    else if (cc.type === 'PROXIMITY') l.prox.push(`${cc.proximity?.radius} ${cc.proximity?.radiusUnits} (${cc.proximity?.address?.cityName || '?'})`);
    else l.loc.push(String(cc.location?.geoTargetConstant || '').split('/').pop());
    porCamp.set(x.campaign.name, l);
  }
  console.log('\n2) SEGMENTAÇÃO GEOGRÁFICA');
  for (const c of camps.sort((p, q) => p.campaign.name.localeCompare(q.campaign.name))) {
    const l = porCamp.get(c.campaign.name);
    if (!l) { console.log(`  🚨 SEM GEO NENHUMA — ${c.campaign.name}`); continue; }
    const desc = l.prox.length ? `raio: ${l.prox.join(' · ')}` : `${l.loc.length} local(is): ${l.loc.slice(0, 4).join(',')}${l.loc.length > 4 ? '…' : ''}`;
    console.log(`  ${desc}${l.neg ? ` · ${l.neg} excluído(s)` : ''}\n     ${c.campaign.name}`);
  }

  /* ── 3) PALAVRAS-CHAVE (só Pesquisa) ─────────────────────────────────── */
  const kw = await consultar(
    a,
    `SELECT campaign.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
            ad_group_criterion.negative, metrics.impressions, metrics.clicks, metrics.cost_micros
       FROM keyword_view
      WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
  );
  const neg = await consultar(
    a,
    `SELECT campaign.name, campaign_criterion.keyword.text
       FROM campaign_criterion
      WHERE campaign.status = 'ENABLED' AND campaign_criterion.type = 'KEYWORD'
        AND campaign_criterion.negative = TRUE`,
  );
  console.log('\n3) PALAVRAS-CHAVE (campanhas de Pesquisa)');
  const porKw = new Map();
  for (const x of kw) {
    const k = `${x.adGroupCriterion.keyword.text} [${x.adGroupCriterion.keyword.matchType}]`;
    const m = porKw.get(k) || { impr: 0, cli: 0, custo: 0 };
    m.impr += Number(x.metrics?.impressions || 0);
    m.cli += Number(x.metrics?.clicks || 0);
    m.custo += Number(x.metrics?.costMicros || 0);
    porKw.set(k, m);
  }
  console.log(`  ${porKw.size} palavras-chave com movimento em 30 dias · ${neg.length} negativas na conta`);
  const top = [...porKw].sort((x, y) => y[1].custo - x[1].custo).slice(0, 15);
  console.log('  as 15 que mais gastaram:');
  for (const [k, m] of top) {
    console.log(`    ${brl(m.custo).padStart(11)}  ${String(m.cli).padStart(4)} cliques  ${String(m.impr).padStart(6)} impr   ${k}`);
  }
  if (!neg.length) {
    console.log('\n  🚨 ZERO palavras-chave NEGATIVAS na conta. Campanha de loja sem negativa paga');
    console.log('     por "atacado", "usada", "como fazer", "aluguel", "trabalhe conosco".');
  } else {
    console.log(`\n  negativas: ${neg.slice(0, 20).map((x) => x.campaignCriterion.keyword.text).join(' · ')}`);
  }
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
