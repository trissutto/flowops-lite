/**
 * CORREÇÕES NA CONTA ECOMM (892-523-1246) — Google Ads API v25.
 *
 * Como rodar, no PowerShell (a pasta do repo já está linkada ao Railway):
 *
 *   # 1) conferir sem alterar nada
 *   $env:VALIDAR="1"; railway run --service flowops-lite node <este-arquivo>
 *
 *   # 2) aplicar os 4 primeiros passos
 *   Remove-Item Env:VALIDAR; railway run --service flowops-lite node <este-arquivo>
 *
 *   # 3) criar o grupo de recursos SÓ-FEED do PMax (passo 5)
 *   $env:FEED_ONLY="1"; railway run --service flowops-lite node <este-arquivo>
 *
 *   # 4) SÓ NO DIA SEGUINTE, com o só-feed já veiculando: pausar os antigos
 *   $env:FEED_ONLY=""; $env:PAUSAR_ANTIGOS="1"; railway run --service flowops-lite node <este-arquivo>
 *
 * ⚠️ `VALIDAR=1 railway ...` é sintaxe de BASH e o PowerShell recusa com
 * CommandNotFoundException — lá a variável se define ANTES, com $env:.
 * Toda operação daqui é reversível e sai no log com o que foi feito.
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = (process.env.GOOGLE_ADS_CONTAS || '').split(',')[0].replace(/\D/g, '');
const VALIDAR = process.env.VALIDAR === '1';
const FEED_ONLY = process.env.FEED_ONLY === '1';
const PAUSAR_ANTIGOS = process.env.PAUSAR_ANTIGOS === '1';
const CAMP_SHOPPING = '23750068771', CAMP_SEARCH = '20597374226', CAMP_PMAX = '23091898790';
const ACAO_GA4_PURCHASE = '6657542368';
const NOME_FEED_ONLY = 'So feed (Shopping) - sem Display';

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
    const j = JSON.parse(t);
    return (j.error?.details?.[0]?.errors || [])
      .map((e) => `${JSON.stringify(e.errorCode)}: ${e.message}`)
      .join(' | ') || j.error?.message || t;
  } catch {
    return t;
  }
}

async function mutate(a, recurso, operations, extra = {}) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/${recurso}:mutate`, {
    method: 'POST', headers: headers(a),
    body: JSON.stringify({ operations, validateOnly: VALIDAR, ...extra }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 400)}`);
  return JSON.parse(t);
}

async function consultar(a, gaql) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`, {
    method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 300)}`);
  const l = JSON.parse(t);
  return (Array.isArray(l) ? l : [l]).flatMap((x) => x.results || []);
}

const ok = (rot, res) =>
  console.log(`  ${VALIDAR ? '[validou]' : '[APLICADO]'} ${rot}${res?.results?.length ? ` (${res.results.length})` : ''}`);
const falhou = (rot, e) => console.log(`  [FALHOU] ${rot}\n     ${e.message}`);

(async () => {
  const a = await token();
  console.log(VALIDAR ? '=== MODO VALIDACAO (nada e alterado) ===' : '=== APLICANDO NA CONTA ===');

  if (!PAUSAR_ANTIGOS) {
    // 1. Uma só ação de compra principal.
    console.log('\n1) [GA4] purchase vira SECUNDARIA (fim do risco de venda contada em dobro)');
    try {
      const res = await mutate(a, 'conversionActions', [{
        update: { resourceName: `customers/${CONTA}/conversionActions/${ACAO_GA4_PURCHASE}`, primaryForGoal: false },
        updateMask: 'primary_for_goal',
      }]);
      ok('conversionAction 6657542368 primary_for_goal=false', res);
    } catch (e) { falhou('conversionAction primary_for_goal', e); }

    // 2. Shopping: tROAS 4,0 -> 3,2 (corte de 20%, o máximo recomendado por vez).
    console.log('\n2) Shopping: ROAS desejado 400% -> 320%');
    try {
      const res = await mutate(a, 'campaigns', [{
        update: { resourceName: `customers/${CONTA}/campaigns/${CAMP_SHOPPING}`, targetRoas: { targetRoas: 3.2 } },
        updateMask: 'target_roas.target_roas',
      }]);
      ok('campanha Shopping target_roas=3.2', res);
    } catch (e) { falhou('Shopping target_roas', e); }

    // 3. UTM unificada: campanhas voltam a herdar o modelo da CONTA.
    console.log('\n3) UTM unificada - apaga o modelo proprio de Search e PMax');
    for (const [nome, id] of [['Search Institucional', CAMP_SEARCH], ['PMax Feeds', CAMP_PMAX]]) {
      try {
        const res = await mutate(a, 'campaigns', [{
          update: { resourceName: `customers/${CONTA}/campaigns/${id}` }, updateMask: 'tracking_url_template',
        }]);
        ok(`${nome}: volta a herdar utm_source=google&utm_medium=cpc da conta`, res);
      } catch (e) { falhou(`${nome} tracking_url_template`, e); }
    }

    /**
     * 4. Negativas de "marca + cidade": quem procura a LOJA não é do e-commerce.
     *
     * ⚠️ `sjc` e `sao jose dos campos` ficam DE FORA de propósito: esse termo
     * converteu (R$ 609 de venda para R$ 41 de custo).
     * ⚠️ `praia grande` é FRASE, não ampla — em ampla bloquearia "saída de
     * praia tamanho grande", que é peça nossa.
     */
    console.log('\n4) Negativas na Search Institucional (marca + cidade, R$ 807/30d e zero venda)');
    const AMPLA = ['campinas', 'sorocaba', 'indaiatuba', 'jundiai', 'jundiaí', 'vinhedo', 'limeira', 'santos', 'piracicaba', 'moema', 'suzano'];
    const FRASE = ['praia grande', 'mogi das cruzes', 'reclame aqui'];
    const ops = [
      ...AMPLA.map((t) => ({ create: { campaign: `customers/${CONTA}/campaigns/${CAMP_SEARCH}`, negative: true, keyword: { text: t, matchType: 'BROAD' } } })),
      ...FRASE.map((t) => ({ create: { campaign: `customers/${CONTA}/campaigns/${CAMP_SEARCH}`, negative: true, keyword: { text: t, matchType: 'PHRASE' } } })),
    ];
    try {
      const res = await mutate(a, 'campaignCriteria', ops, { partialFailure: true });
      const erros = res.partialFailureError?.details?.[0]?.errors || [];
      ok(`${ops.length} negativas (${AMPLA.length} ampla + ${FRASE.length} frase)`, res);
      for (const e of erros) console.log(`     ignorada (provavel duplicata): ${e.message}`);
    } catch (e) { falhou('negativas', e); }
  }

  /**
   * 5. GRUPO DE RECURSOS SÓ-FEED no PMax.
   *
   * Sem asset nenhum, o PMax perde o que serve em Discover, Gmail e Display —
   * onde a campanha gastou R$ 1.477 em 30 dias a ROAS 0,44, com 11.160 cliques
   * de R$ 0,13 que em maioria nem abrem o site. A API aceita grupo ENABLED sem
   * asset (medido em 27/08). O filtro de listagem raiz é obrigatório: sem ele
   * o grupo existe e não anuncia produto nenhum.
   */
  if (FEED_ONLY) {
    console.log('\n5) Grupo de recursos SO-FEED no PMax');
    try {
      const res = await mutate(a, 'assetGroups', [{ create: {
        campaign: `customers/${CONTA}/campaigns/${CAMP_PMAX}`,
        name: NOME_FEED_ONLY,
        finalUrls: ['https://lurds.com.br/novidades'],
        status: 'ENABLED',
      } }]);
      const rn = res?.results?.[0]?.resourceName;
      ok(`grupo "${NOME_FEED_ONLY}" criado${rn ? ' — ' + rn : ''}`, res);
      if (rn) {
        const filtro = await mutate(a, 'assetGroupListingGroupFilters', [{ create: {
          assetGroup: rn, type: 'UNIT_INCLUDED', listingSource: 'SHOPPING',
        } }]);
        ok('filtro de listagem raiz (todos os produtos)', filtro);
      } else if (!VALIDAR) {
        console.log('  [ATENCAO] sem resourceName na resposta - crie o filtro de listagem na mao');
      }
    } catch (e) { falhou('grupo so-feed', e); }
  }

  /**
   * 6. PAUSAR OS GRUPOS COM ASSET — só depois de ver o só-feed veiculando.
   *
   * É a única operação daqui que pode fazer a campanha parar de entregar se
   * rodar cedo demais. Por isso é opt-in e confere antes se o só-feed já
   * existe e está ELIGIBLE.
   */
  if (PAUSAR_ANTIGOS) {
    console.log('\n6) Pausar os grupos de recursos com asset (o Display do PMax)');
    try {
      const grupos = await consultar(a,
        `SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.primary_status
           FROM asset_group WHERE campaign.id = ${CAMP_PMAX} AND asset_group.status = 'ENABLED'`);
      const soFeed = grupos.find((g) => g.assetGroup.name === NOME_FEED_ONLY);
      if (!soFeed) {
        console.log(`  [PAROU] o grupo "${NOME_FEED_ONLY}" nao existe ou nao esta ativo - rode antes com FEED_ONLY=1`);
        return;
      }
      if (soFeed.assetGroup.primaryStatus !== 'ELIGIBLE') {
        console.log(`  [PAROU] o so-feed esta ${soFeed.assetGroup.primaryStatus}, nao ELIGIBLE - pausar os outros agora derrubaria a campanha`);
        return;
      }
      const antigos = grupos.filter((g) => g.assetGroup.name !== NOME_FEED_ONLY);
      if (!antigos.length) { console.log('  nada a pausar'); return; }
      const res = await mutate(a, 'assetGroups', antigos.map((g) => ({
        update: { resourceName: `customers/${CONTA}/assetGroups/${g.assetGroup.id}`, status: 'PAUSED' },
        updateMask: 'status',
      })));
      ok(`pausados: ${antigos.map((g) => g.assetGroup.name).join(', ')}`, res);
    } catch (e) { falhou('pausar grupos antigos', e); }
  }

  if (!FEED_ONLY && !PAUSAR_ANTIGOS) {
    console.log('\n(passo 5 do PMax nao rodou - para criar o grupo so-feed, defina FEED_ONLY=1)');
  }
})().catch((e) => { console.error('ERRO GERAL:', e.message); process.exit(1); });
