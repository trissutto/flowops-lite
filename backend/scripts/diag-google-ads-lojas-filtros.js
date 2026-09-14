/**
 * A ÁRVORE DE FILTRO DE LISTAGEM DE CADA PMax — conta LOJAS FÍSICAS. Só leitura.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * O filtro de listagem é o que decide QUAIS produtos o grupo de recursos
 * anuncia. Medido em 14/09: 7 campanhas com Merchant vinculado e muitos filtros
 * (Campinas 18, Santos 15, Sorocaba 13) servindo **ZERO produto** — a árvore
 * aponta para um `product_type = novidades` que não existe mais no feed.
 *
 * Nada disso dá erro. O grupo fica no ar, gasta em anúncio de texto e imagem, e
 * a parte de Shopping simplesmente não aparece. É a mesma família do
 * `store_code`: configuração viva apontando pra valor morto.
 *
 * ── O QUE O SCRIPT IMPRIME ──
 *
 * A árvore inteira, por campanha → grupo de recursos, com o TIPO de cada nó
 * (subdivisão, incluído, excluído), a dimensão e o valor. É esse desenho que
 * diz se existe o nó "todo o resto" (sem ele o Google recusa a árvore) e se
 * algum valor é letra morta.
 *
 * 🚨 A árvore é uma ÁRVORE: nó filho pendura em `parent_listing_group_filter`,
 * e a raiz é uma SUBDIVISION sem pai. Ler a lista achatada — como o diagnóstico
 * anterior fazia, só contando quantos nós existem — esconde exatamente o que
 * importa: o CAMINHO de cada folha.
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas-filtros.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';

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
  if (!j.access_token) throw new Error('OAuth falhou: ' + JSON.stringify(j).slice(0, 200));
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
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${t.slice(0, 600)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

/** O `case_value` chega como um objeto com UMA chave preenchida. */
function dimensao(cv) {
  if (!cv || typeof cv !== 'object') return 'TODO O RESTO';
  if (cv.productCategory) return `categoria=${cv.productCategory.categoryId ?? '?'}`;
  if (cv.productBrand) return `marca=${cv.productBrand.value ?? '(resto)'}`;
  if (cv.productChannel) return `canal=${cv.productChannel.channel ?? '?'}`;
  if (cv.productCondition) return `condicao=${cv.productCondition.condition ?? '?'}`;
  if (cv.productItemId) return `id=${cv.productItemId.value ?? '(resto)'}`;
  if (cv.productType) {
    const n = String(cv.productType.level ?? '').replace('LEVEL', 'nivel');
    return `product_type[${n}]=${cv.productType.value ?? '(resto)'}`;
  }
  if (cv.productCustomAttribute) {
    const i = String(cv.productCustomAttribute.index ?? '').replace('INDEX', '');
    return `custom_label_${i}=${cv.productCustomAttribute.value ?? '(resto)'}`;
  }
  return 'TODO O RESTO';
}

const SINAL = { SUBDIVISION: '📂', UNIT_INCLUDED: '✅ inclui', UNIT_EXCLUDED: '⛔ exclui' };

async function main() {
  console.log(`conta ${CONTA} · API ${V} · SÓ LEITURA\n`);
  const a = await token();

  /* Inventário: toda PMax ativa e seus grupos, mesmo sem filtro nenhum. */
  const grupos = await consultar(
    a,
    `SELECT campaign.name, campaign.status, campaign.shopping_setting.merchant_id,
            campaign.shopping_setting.feed_label, campaign.shopping_setting.enable_local,
            asset_group.resource_name, asset_group.name, asset_group.status
       FROM asset_group
      WHERE campaign.status = 'ENABLED'
        AND campaign.advertising_channel_type = 'PERFORMANCE_MAX'
        AND asset_group.status != 'REMOVED'`,
  );

  const porCampanha = new Map();
  for (const g of grupos) {
    const s = g.campaign.shoppingSetting || {};
    if (!porCampanha.has(g.campaign.name)) {
      porCampanha.set(g.campaign.name, {
        merchant: s.merchantId || null,
        rotulo: s.feedLabel || '',
        local: s.enableLocal === true,
        grupos: [],
      });
    }
    porCampanha.get(g.campaign.name).grupos.push({
      res: g.assetGroup.resourceName,
      nome: g.assetGroup.name,
      status: g.assetGroup.status,
      nos: [],
    });
  }

  /* A árvore. Uma consulta só, depois montada por `parent`. */
  /**
   * ⚠️ `case_value` NÃO pode ir inteiro no SELECT (`PROHIBITED_FIELD_IN_SELECT_
   * CLAUSE`) — cada subcampo é pedido na mão. A lista veio da própria API
   * (`googleAdsFields:search`, que por sua vez não aceita `FROM`).
   */
  const nos = await consultar(
    a,
    `SELECT campaign.name, campaign.status, asset_group.resource_name,
            asset_group_listing_group_filter.resource_name,
            asset_group_listing_group_filter.type,
            asset_group_listing_group_filter.parent_listing_group_filter,
            asset_group_listing_group_filter.case_value.product_brand.value,
            asset_group_listing_group_filter.case_value.product_category.category_id,
            asset_group_listing_group_filter.case_value.product_category.level,
            asset_group_listing_group_filter.case_value.product_channel.channel,
            asset_group_listing_group_filter.case_value.product_condition.condition,
            asset_group_listing_group_filter.case_value.product_custom_attribute.index,
            asset_group_listing_group_filter.case_value.product_custom_attribute.value,
            asset_group_listing_group_filter.case_value.product_item_id.value,
            asset_group_listing_group_filter.case_value.product_type.level,
            asset_group_listing_group_filter.case_value.product_type.value
       FROM asset_group_listing_group_filter
      WHERE campaign.status = 'ENABLED'`,
  );

  const porGrupo = new Map();
  for (const n of nos) {
    const k = n.assetGroup.resourceName;
    if (!porGrupo.has(k)) porGrupo.set(k, []);
    porGrupo.get(k).push({
      res: n.assetGroupListingGroupFilter.resourceName,
      tipo: n.assetGroupListingGroupFilter.type,
      pai: n.assetGroupListingGroupFilter.parentListingGroupFilter || null,
      rotulo: dimensao(n.assetGroupListingGroupFilter.caseValue),
    });
  }

  let semFiltro = 0;
  let comArvoreMorta = 0;

  for (const [campanha, c] of [...porCampanha].sort((x, y) => x[0].localeCompare(y[0]))) {
    const cab = c.merchant
      ? `merchant ${c.merchant} · rótulo ${c.rotulo || '(vazio)'} · local ${c.local ? 'SIM' : 'não'}`
      : '🔴 SEM MERCHANT VINCULADO';
    console.log(`\n━━ ${campanha}\n   ${cab}`);

    for (const g of c.grupos) {
      const lista = porGrupo.get(g.res) || [];
      console.log(`   └─ grupo "${g.nome}" (${g.status}) — ${lista.length} nó(s)`);
      if (!lista.length) {
        console.log('      ⚠️ NENHUM filtro de listagem: este grupo não anuncia produto nenhum');
        semFiltro++;
        continue;
      }

      /* Desenha a árvore de verdade, da raiz pra baixo. */
      const filhos = new Map();
      for (const n of lista) {
        const p = n.pai || '(raiz)';
        if (!filhos.has(p)) filhos.set(p, []);
        filhos.get(p).push(n);
      }
      const desenhar = (pai, nivel) => {
        for (const n of filhos.get(pai) || []) {
          console.log(
            `      ${'  '.repeat(nivel)}${SINAL[n.tipo] || n.tipo} ${n.rotulo}`,
          );
          desenhar(n.res, nivel + 1);
        }
      };
      desenhar('(raiz)', 0);

      /* Valor que não existe mais no feed é o que faz o grupo servir zero. */
      const mortos = lista.filter(
        (n) => n.tipo === 'UNIT_INCLUDED' && /product_type\[.*\]=novidades/i.test(n.rotulo),
      );
      if (mortos.length) {
        console.log(`      🔴 ${mortos.length} nó(s) incluindo \`product_type = novidades\` — valor que NÃO existe no feed`);
        comArvoreMorta++;
      }
    }
  }

  console.log('\n── RESUMO ──');
  console.log(`campanhas PMax ativas: ${porCampanha.size}`);
  console.log(`grupos sem filtro nenhum: ${semFiltro}`);
  console.log(`grupos incluindo valor morto (product_type=novidades): ${comArvoreMorta}`);
  console.log(
    `campanhas sem Merchant: ${[...porCampanha.values()].filter((c) => !c.merchant).length}`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
