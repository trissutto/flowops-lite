/**
 * O RÓTULO DO FEED VAZIO QUEBRA O CASAMENTO? — conta LOJAS FÍSICAS. Só leitura.
 *
 * ── A PERGUNTA ──
 *
 * Medido em 14/09: das 14 PMax ativas, **9 têm Merchant Center vinculado com
 * `enable_local`** e 5 não têm nada. E entre as 9, **só a LIMEIRA tem rótulo de
 * feed `BR`** — as outras 8 estão com o rótulo VAZIO.
 *
 * O feed de produtos e o de inventário local do Merchant estão os dois com
 * rótulo `BR`. A dúvida é se rótulo vazio significa "não casa com nada" ou
 * "aceita qualquer rótulo". Na primeira leitura, o inventário local casou ZERO
 * produtos — e isso pode ser a explicação.
 *
 * 🚨 Isto NÃO se resolve por leitura de documentação nem por dedução: é a mesma
 * família de falha silenciosa do `store_code` — nada dá erro, o produto só não
 * aparece. Quem decide é o DADO: campanha que serve produto tem impressão em
 * `shopping_performance_view`; campanha que não casa tem zero.
 *
 * ── O TESTE ──
 *
 * 1. Impressão e clique de PRODUTO por campanha (30 dias). Se a Limeira (rótulo
 *    BR) tem e as 8 de rótulo vazio não têm, o rótulo é o culpado. Se todas as 9
 *    têm, o rótulo vazio é permissivo e o problema do inventário local é outro.
 * 2. `asset_group_listing_group_filter` — sem filtro de listagem o grupo não
 *    anuncia produto NENHUM, mesmo com Merchant vinculado. É o outro elo
 *    possível, e nenhuma tela avisa.
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas-merchant.js
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
  if (!r.ok) return { erro: `HTTP ${r.status} — ${t.slice(0, 400)}` };
  const j = JSON.parse(t);
  return { linhas: (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []) };
}

async function main() {
  console.log(`conta ${CONTA} · API ${V} · SÓ LEITURA\n`);
  const a = await token();

  /* Configuração de cada PMax, pra cruzar com o desempenho. */
  const cfg = new Map();
  const c = await consultar(
    a,
    `SELECT campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign.shopping_setting.merchant_id, campaign.shopping_setting.feed_label,
            campaign.shopping_setting.enable_local
       FROM campaign
      WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'`,
  );
  if (c.erro) throw new Error(c.erro);
  for (const x of c.linhas) {
    const s = x.campaign.shoppingSetting || {};
    cfg.set(x.campaign.name, {
      merchant: s.merchantId || null,
      rotulo: s.feedLabel || '',
      local: s.enableLocal === true,
      impr: 0, cli: 0, custo: 0, filtros: 0,
    });
  }

  /* 1) DESEMPENHO DE PRODUTO — a prova. */
  const sp = await consultar(
    a,
    `SELECT campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros
       FROM shopping_performance_view
      WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS`,
  );
  if (sp.erro) console.log('⚠️ shopping_performance_view: ' + sp.erro + '\n');
  else for (const x of sp.linhas) {
    const i = cfg.get(x.campaign.name);
    if (!i) continue;
    i.impr += Number(x.metrics?.impressions || 0);
    i.cli += Number(x.metrics?.clicks || 0);
    i.custo += Number(x.metrics?.costMicros || 0);
  }

  /* 2) FILTRO DE LISTAGEM — sem ele o grupo não anuncia produto. */
  const lg = await consultar(
    a,
    `SELECT campaign.name, asset_group_listing_group_filter.resource_name
       FROM asset_group_listing_group_filter
      WHERE campaign.status = 'ENABLED'`,
  );
  if (lg.erro) console.log('⚠️ asset_group_listing_group_filter: ' + lg.erro + '\n');
  else for (const x of lg.linhas) {
    const i = cfg.get(x.campaign.name);
    if (i) i.filtros++;
  }

  console.log('rótulo   local  filtros   impressões de PRODUTO (30d)   campanha');
  const ordenado = [...cfg].sort((x, y) => {
    if (!!y[1].merchant !== !!x[1].merchant) return y[1].merchant ? 1 : -1;
    return x[0].localeCompare(y[0]);
  });
  for (const [nome, i] of ordenado) {
    if (!i.merchant) {
      console.log(`  🔴 SEM MERCHANT                                           ${nome}`);
      continue;
    }
    console.log(
      `  ${(i.rotulo || '(vazio)').padEnd(8)} ${(i.local ? 'SIM' : 'não').padEnd(6)} ` +
        `${String(i.filtros).padStart(7)}   ${String(i.impr).padStart(9)} impr · ${String(i.cli).padStart(5)} cli · ${brl(i.custo).padStart(11)}   ${nome}`,
    );
  }

  /* ── O VEREDITO, tirado do dado ──────────────────────────────────────── */
  const comMerchant = [...cfg.values()].filter((i) => i.merchant);
  const comRotulo = comMerchant.filter((i) => i.rotulo);
  const semRotulo = comMerchant.filter((i) => !i.rotulo);
  const servem = (l) => l.filter((i) => i.impr > 0).length;

  console.log('\n── VEREDITO ──');
  console.log(`com rótulo (${comRotulo.length}): ${servem(comRotulo)} servem produto`);
  console.log(`rótulo VAZIO (${semRotulo.length}): ${servem(semRotulo)} servem produto`);

  if (comRotulo.length && semRotulo.length) {
    if (servem(semRotulo) === 0 && servem(comRotulo) > 0) {
      console.log('\n🔴 O RÓTULO VAZIO QUEBRA. Só quem tem rótulo serve produto — pôr `BR` nas outras.');
    } else if (servem(semRotulo) > 0) {
      console.log('\n✅ RÓTULO VAZIO NÃO QUEBRA — campanha sem rótulo também serve produto.');
      console.log('   Então o zero do inventário local tem OUTRA causa. Não mexa no rótulo.');
    } else {
      console.log('\n⚠️ NENHUMA serve produto, com ou sem rótulo. O rótulo não é o discriminante —');
      console.log('   o suspeito passa a ser o filtro de listagem (coluna `filtros`) ou o próprio feed.');
    }
  }
  const semFiltro = comMerchant.filter((i) => !i.filtros).length;
  if (semFiltro) {
    console.log(`\n⚠️ ${semFiltro} campanha(s) com Merchant mas SEM filtro de listagem — sem ele o`);
    console.log('   grupo não anuncia produto nenhum, e nenhuma tela avisa.');
  }
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
