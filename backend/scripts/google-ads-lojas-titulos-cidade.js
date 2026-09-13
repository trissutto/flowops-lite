/**
 * TÍTULO COM A CIDADE nos grupos de recursos — conta LOJAS FÍSICAS (956-499-8046).
 *
 * ── O QUE ISTO CONSERTA, E O QUE NÃO ──
 *
 * 🚨 Primeiro o que NÃO é: **não é falta de título.** Medido em 13/09, os 27
 * grupos ativos têm 15 a 18 títulos, e a régua da própria conta é:
 *
 *     EXCELLENT   17 grupos   5 - 15,8 - 20 títulos
 *     GOOD        21 grupos   5 - 10,5 - 17
 *     AVERAGE    123 grupos   5 -  8,9 - 19
 *     POOR        25 grupos   1 -  5,0 - 13
 *
 * Ou seja: os nossos JÁ ESTÃO na faixa dos EXCELLENT, acima da média deles — e
 * ainda assim marcam AVERAGE. E existe grupo EXCELLENT com 5 títulos. Encher de
 * texto não move a nota; o que separa os nossos continua sendo a mistura de
 * imagens (ver `google-ads-lojas-imagens.js`).
 *
 * ── O DEFEITO REAL: nenhum título diz a cidade ──
 *
 * Os mais usados hoje são todos genéricos, iguais em Sorocaba e em Moema:
 *
 *     "Prove Antes de Levar" ..... 18 grupos
 *     "Plus Size do 44 ao 60" .... 18
 *     "Plus Size Perto de Você" .. 17
 *     "Encontre sua loja" ......... 5
 *
 * Numa campanha LOCAL isso é desperdício de relevância: "Plus Size em Sorocaba"
 * casa com a busca de quem está em Sorocaba; "Perto de Você" não casa com nada.
 * É o mesmo defeito que os temas de pesquisa tinham — o grupo de Sorocaba
 * carregava "moda plus size Moema", clonado de outra praça e nunca trocado.
 *
 * Então aqui entram **3 títulos por grupo, cada um nomeando a cidade daquela
 * campanha**. Relevância, não enchimento.
 *
 * ── COMO RODAR (PowerShell) ──
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-titulos-cidade.js
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-titulos-cidade.js
 *   $env:VALIDAR=""; $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-titulos-cidade.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

/** Teto do Google para título de PMax. Texto maior é recusado. */
const LIMITE_CARACTERES = 30;
/** Maior contagem observada na conta. Não passar disso sem o Google confirmar. */
const TETO_TITULOS = 20;

/**
 * Campanha → cidade, escrito à mão e conferido. Não deduzo do nome: "SÃO JOSÉ
 * DOS CAMPOS PMax 27.08.25 [Petter]" e "ANÁLIA FRANCO PMax 01.06.26 [Petter]"
 * quebram qualquer regex simples, e errar aqui põe o nome de uma praça no
 * anúncio de outra — que é exatamente o defeito que este script conserta.
 */
const CIDADE_DA_CAMPANHA = {
  'SOROCABA PMax 27.08.25 [Petter]': 'Sorocaba',
  'CAMPINAS PMax 27.08.25 [Petter]': 'Campinas',
  'SANTOS PMax 27.08.25 [Petter]': 'Santos',
  'ITANHAÉM PMax 27.08.25 [Petter]': 'Itanhaém',
  'VINHEDO PMax 27.08.25 [Petter]': 'Vinhedo',
  'SUZANO PMax 27.08.25 [Petter]': 'Suzano',
  /* Nome CURTO de propósito: "São José dos Campos" tem 19 caracteres e estoura
   * o teto de 30 em qualquer molde ("Loja Plus Size São José dos Campos" = 34). */
  'SÃO JOSÉ DOS CAMPOS PMax 27.08.25 [Petter]': 'São José',
  'PRAIA GRANDE PMax 27.08.25 [Petter]': 'Praia Grande',
  'PIRACICABA PMax 27.08.25 [Petter]': 'Piracicaba',
  'JUNDIAÍ PMax 27.08.25 [Petter]': 'Jundiaí',
  'LIMEIRA PMax 27.08.25 [Petter]': 'Limeira',
  'INDAIATUBA PMax 27.08.25 [Petter]': 'Indaiatuba',
  'MOEMA PMax 27.08.25 [Petter]': 'Moema',
  'ANÁLIA FRANCO PMax 01.06.26 [Petter]': 'Anália Franco',
};

/**
 * Os três moldes. Cada um ataca uma busca diferente:
 *   1. a busca por categoria + lugar ("moda plus size sorocaba")
 *   2. a busca por LOJA ("loja plus size sorocaba") — quem já quer ir
 *   3. a busca por TAMANHO, que é a dor real da cliente plus size
 * O terceiro carrega a grade porque "do 44 ao 60" é o que já tem 18 usos na
 * conta — funciona; o que faltava era amarrar à praça.
 */
const MOLDES = [
  (c) => `Plus Size em ${c}`,
  (c) => `Loja Plus Size ${c}`,
  (c) => `${c}: do 44 ao 60`,
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
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 600)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function mutate(a, recurso, operations) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/${recurso}:mutate`, {
    method: 'POST',
    headers: headers(a),
    body: JSON.stringify({ operations, validateOnly: VALIDAR || !APLICAR, partialFailure: false }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 900)}`);
  return JSON.parse(t);
}

async function main() {
  const modo = APLICAR && !VALIDAR ? '🔴 APLICANDO' : VALIDAR ? '🟡 validateOnly' : '🟢 DRY-RUN';
  console.log(`conta ${CONTA} · API ${V} · ${modo}\n`);

  /* ── Conferir os textos ANTES de falar com o Google ───────────────────── */
  const longos = [];
  for (const cidade of new Set(Object.values(CIDADE_DA_CAMPANHA))) {
    for (const molde of MOLDES) {
      const t = molde(cidade);
      if (t.length > LIMITE_CARACTERES) longos.push(`${t} (${t.length})`);
    }
  }
  if (longos.length) {
    throw new Error(`títulos acima de ${LIMITE_CARACTERES} caracteres:\n  ${longos.join('\n  ')}`);
  }
  console.log(`✔ os ${new Set(Object.values(CIDADE_DA_CAMPANHA)).size * MOLDES.length} textos cabem em ${LIMITE_CARACTERES} caracteres\n`);

  const a = await token();

  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.name, campaign.status
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  const jaTem = new Map(); // grupo -> Set(texto)
  for (const x of await consultar(
    a,
    `SELECT asset_group_asset.asset_group, asset.text_asset.text
       FROM asset_group_asset
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'
        AND asset_group_asset.status != 'REMOVED'
        AND asset_group_asset.field_type = 'HEADLINE'`,
  )) {
    const g = x.assetGroupAsset.assetGroup;
    const s = jaTem.get(g) || new Set();
    if (x.asset?.textAsset?.text) s.add(x.asset.textAsset.text);
    jaTem.set(g, s);
  }

  /* Texto que já existe como ATIVO na conta é reaproveitado — criar um segundo
   * com o mesmo texto é recusado com DUPLICATE_ASSET. */
  const textoExistente = new Map();
  for (const x of await consultar(
    a,
    `SELECT asset.resource_name, asset.text_asset.text FROM asset WHERE asset.type = 'TEXT'`,
  )) {
    if (x.asset?.textAsset?.text) textoExistente.set(x.asset.textAsset.text, x.asset.resourceName);
  }

  /* ── O PLANO ─────────────────────────────────────────────────────────── */
  const plano = [];
  const precisaCriar = new Set();
  for (const g of grupos) {
    const campanha = g.campaign.name;
    const cidade = CIDADE_DA_CAMPANHA[campanha];
    if (!cidade) throw new Error(`campanha sem cidade mapeada: "${campanha}" — acrescente em CIDADE_DA_CAMPANHA`);

    const gRes = `customers/${CONTA}/assetGroups/${g.assetGroup.id}`;
    const atuais = jaTem.get(gRes) || new Set();
    const vagas = Math.max(0, TETO_TITULOS - atuais.size);
    const novos = MOLDES.map((m) => m(cidade)).filter((t) => !atuais.has(t)).slice(0, vagas);

    for (const t of novos) if (!textoExistente.has(t)) precisaCriar.add(t);
    plano.push({ gRes, campanha, grupo: g.assetGroup.name, forca: g.assetGroup.adStrength, cidade, tem: atuais.size, novos });
  }

  plano.sort((x, y) => x.campanha.localeCompare(y.campanha));
  console.log('PLANO POR GRUPO');
  for (const p of plano) {
    console.log(
      `\n${p.campanha} / ${p.grupo} (${p.forca}) — ${p.tem} títulos hoje` +
        (p.novos.length ? `\n  + ${p.novos.map((t) => `"${t}"`).join('  ')}` : '\n  (nada a acrescentar)'),
    );
  }
  const total = plano.reduce((s, p) => s + p.novos.length, 0);
  console.log(`\n${total} títulos a ligar · ${precisaCriar.size} textos novos a criar na conta`);

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada enviado. Para validar: $env:VALIDAR="1"');
    return;
  }
  if (!total) return console.log('nada a fazer');

  /* ── 1) Criar os textos que ainda não existem ─────────────────────────── */
  const recurso = new Map(textoExistente);
  const aCriar = [...precisaCriar];
  for (let i = 0; i < aCriar.length; i += 100) {
    const lote = aCriar.slice(i, i + 100);
    const r = await mutate(a, 'assets', lote.map((t) => ({ create: { textAsset: { text: t } } })));
    (r.results || []).forEach((res, k) => {
      if (res.resourceName) recurso.set(lote[k], res.resourceName);
    });
  }
  console.log(`\n✔ textos: ${aCriar.length} criados`);

  /* ── 2) Ligar nos grupos ──────────────────────────────────────────────── */
  const ops = [];
  for (const p of plano) {
    for (const t of p.novos) {
      const res = recurso.get(t);
      if (res && res.startsWith('customers/')) {
        ops.push({ create: { assetGroup: p.gRes, asset: res, fieldType: 'HEADLINE' } });
      }
    }
  }
  let feitos = 0;
  for (let i = 0; i < ops.length; i += 100) {
    const r = await mutate(a, 'assetGroupAssets', ops.slice(i, i + 100));
    feitos += (r.results || []).length;
  }
  console.log(
    VALIDAR
      ? `\n🟡 validateOnly — o Google aceitou. Nada alterado.\n   (os vínculos só validam de verdade depois de o texto existir; eles vão junto no APLICAR)`
      : `\n🔴 APLICADO — ${feitos} títulos ligados.`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
