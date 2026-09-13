/**
 * TEMA DE PESQUISA nos grupos de recursos — conta LOJAS FÍSICAS (956-499-8046).
 *
 * ── O QUE ISTO CONSERTA (medido pela API em 13/09/2026) ──
 *
 * 27 grupos de recursos em campanhas ativas, TODOS com força "AVERAGE".
 * **18 deles têm ZERO tema de pesquisa** — e são exatamente os de pior CTR:
 *
 *   sem tema:  outubro_novidades_17-10 (Campinas)  46.738 impr → CTR 0,21%
 *              Grupo de recursos 1 (SJC)           33.645 impr → CTR 0,26%
 *              rmk 30d santos                      32.020 impr → CTR 0,37%
 *   com tema:  Recursos Santos                      8.259 impr → CTR 1,25%
 *              Recursos Moema                       2.730 impr → CTR 3,63%
 *              Grupo de recursos 1 (Suzano)         2.508 impr → CTR 4,67%
 *
 * Até 20× de diferença. Onde configuraram, configuraram 50 temas; onde não,
 * zero. É configuração feita pela metade, não falta de trabalho.
 *
 * ⚠️ E o modelo tem um defeito que se propaga: o grupo de SOROCABA carrega o
 * tema "moda plus size Moema". Os grupos foram clonados de Moema e ninguém
 * trocou a cidade. Por isso aqui o tema de cidade é MONTADO por campanha, e
 * nenhum tema de outra praça entra.
 *
 * ── COMO RODAR (PowerShell) ──
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-temas.js
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-temas.js
 *   $env:VALIDAR=""; $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-temas.js
 *
 * Default é NÃO APLICAR (ver o irmão `google-ads-lojas-orcamento.js`).
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

/**
 * 🚨 O TETO É 25 TEMAS POR GRUPO — descoberto no validateOnly de 13/09/2026.
 *
 * A primeira versão mandou 52 (os 50 copiados do grupo modelo + 3 da cidade) e
 * o Google devolveu `RESOURCE_COUNT_LIMIT_EXCEEDED` ANTES de escrever nada.
 * Os grupos antigos têm 50 porque foram criados antes do limite — o que já
 * existe o Google mantém, mas não aceita criar mais assim.
 *
 * Então são 22 termos gerais + os 3 da cidade = 25. A escolha dos 22 privilegia
 * INTENÇÃO DE COMPRA e as categorias que a loja realmente vende, e descarta os
 * genéricos de humor ("plus size que valoriza curvas", "looks instagramáveis"),
 * que trazem navegação e não visita.
 */
const TEMAS_BASE = [
  'roupas plus size perto de mim', 'loja plus size', 'moda plus size',
  'moda feminina plus size', 'comprar roupa plus size', 'provador plus size',
  'vestidos plus size', 'vestido plus size festa', 'vestido plus size longo',
  'blusa plus size feminina', 'calça plus size feminina', 'conjunto plus size',
  'saia plus size', 'short plus size', 'macacão plus size', 'jaqueta plus size',
  'blazer plus size', 'legging plus size', 'roupas tamanho grande',
  'roupas femininas grandes', 'looks plus size', 'plus size 46 ao 60',
];

/**
 * Campanha → cidade, escrito à mão e conferido. Não deduzo do nome: "SÃO JOSÉ
 * DOS CAMPOS PMax 27.08.25 [Petter]" e "ANÁLIA FRANCO PMax 01.06.26 [Petter]"
 * quebram qualquer regex simples, e errar aqui manda a verba de uma praça
 * atrás do público de outra — que é exatamente o defeito que este script
 * conserta.
 */
const CIDADE_DA_CAMPANHA = {
  'SOROCABA PMax 27.08.25 [Petter]': 'Sorocaba',
  'CAMPINAS PMax 27.08.25 [Petter]': 'Campinas',
  'SANTOS PMax 27.08.25 [Petter]': 'Santos',
  'ITANHAÉM PMax 27.08.25 [Petter]': 'Itanhaém',
  'VINHEDO PMax 27.08.25 [Petter]': 'Vinhedo',
  'SUZANO PMax 27.08.25 [Petter]': 'Suzano',
  'SÃO JOSÉ DOS CAMPOS PMax 27.08.25 [Petter]': 'São José dos Campos',
  'PRAIA GRANDE PMax 27.08.25 [Petter]': 'Praia Grande',
  'PIRACICABA PMax 27.08.25 [Petter]': 'Piracicaba',
  'JUNDIAÍ PMax 27.08.25 [Petter]': 'Jundiaí',
  'LIMEIRA PMax 27.08.25 [Petter]': 'Limeira',
  'INDAIATUBA PMax 27.08.25 [Petter]': 'Indaiatuba',
  'MOEMA PMax 27.08.25 [Petter]': 'Moema',
  'ANÁLIA FRANCO PMax 01.06.26 [Petter]': 'Anália Franco',
};

const temasDaCidade = (cidade) => [
  `moda plus size ${cidade}`,
  `loja plus size ${cidade}`,
  `roupa plus size ${cidade}`,
];

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

function erroLegivel(t) {
  try {
    const j = JSON.parse(t);
    return (
      (j.error?.details?.[0]?.errors || [])
        .map((e) => `${JSON.stringify(e.errorCode)}: ${e.message}`)
        .join(' | ') || j.error?.message || t
    );
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
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 2000)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function mutate(a, operations) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/assetGroupSignals:mutate`,
    {
      method: 'POST',
      headers: headers(a),
      body: JSON.stringify({ operations, validateOnly: VALIDAR || !APLICAR, partialFailure: false }),
    },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 2000)}`);
  return JSON.parse(t);
}

async function main() {
  const modo = APLICAR && !VALIDAR ? '🔴 APLICANDO' : VALIDAR ? '🟡 validateOnly' : '🟢 DRY-RUN';
  console.log(`conta ${CONTA} · API ${V} · ${modo}\n`);
  const a = await token();

  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.name
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  const sinais = await consultar(
    a,
    `SELECT asset_group_signal.asset_group, asset_group_signal.search_theme.text
       FROM asset_group_signal`,
  );
  const jaTem = new Set(
    sinais.filter((s) => s.assetGroupSignal?.searchTheme?.text).map((s) => s.assetGroupSignal.assetGroup),
  );

  const vazios = grupos.filter((g) => !jaTem.has(`customers/${CONTA}/assetGroups/${g.assetGroup.id}`));
  console.log(`${grupos.length} grupos ativos · ${vazios.length} SEM tema de pesquisa\n`);

  const ops = [];
  for (const g of vazios) {
    const campanha = g.campaign.name;
    const cidade = CIDADE_DA_CAMPANHA[campanha];
    if (!cidade) throw new Error(`campanha sem cidade mapeada: "${campanha}" — acrescente em CIDADE_DA_CAMPANHA`);
    const res = `customers/${CONTA}/assetGroups/${g.assetGroup.id}`;
    const temas = [...TEMAS_BASE, ...temasDaCidade(cidade)];
    console.log(`  ${campanha}\n    ${g.assetGroup.name} → ${temas.length} temas (cidade: ${cidade})`);
    for (const texto of temas) {
      ops.push({ create: { assetGroup: res, searchTheme: { text: texto } } });
    }
  }

  console.log(`\n${ops.length} temas a criar em ${vazios.length} grupos`);

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada enviado. Para validar: $env:VALIDAR="1"');
    return;
  }
  if (!ops.length) return console.log('nada a fazer');

  // Em lotes de 100 pra não estourar o limite de operações por requisição.
  let feitas = 0;
  for (let i = 0; i < ops.length; i += 100) {
    const r = await mutate(a, ops.slice(i, i + 100));
    feitas += (r.results || []).length;
  }
  console.log(VALIDAR ? `\n🟡 validateOnly — o Google aceitou (${feitas} confirmadas), nada alterado.` : `\n🔴 APLICADO — ${feitas} temas criados.`);
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
