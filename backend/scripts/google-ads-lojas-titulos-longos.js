/**
 * TÍTULO LONGO com a cidade — conta LOJAS FÍSICAS (956-499-8046).
 * ACRESCENTA até o teto de 5. Não troca nada, não remove nada.
 *
 * ── O QUE FALTA, MEDIDO EM 13/09/2026 ──
 *
 * Depois do rebalanceamento de imagens, dos temas e dos títulos curtos, o
 * diagnóstico aponta **21 dos 27 grupos completos** e um único buraco nos
 * outros 6: `títulos longos 3/5`. São São José dos Campos (×2), Suzano (×2) e
 * Vinhedo (×2) — todo o resto neles está cheio.
 *
 * Aqui dá pra SOMAR de verdade, ao contrário do título curto: o teto de título
 * longo é 5 e esses grupos têm 3, então cabem 2 em cada sem tirar nada.
 * (O título curto teve que ser TROCA porque os grupos estavam em 15-18 com teto
 * de 15 — ver `google-ads-lojas-titulos-cidade.js`.)
 *
 * ── O TEXTO NÃO É INVENTADO AQUI ──
 *
 * A conta JÁ TEM uma família de títulos longos com a cidade, em uso em Praia
 * Grande, Campinas e Indaiatuba — escrita por quem montou aquelas praças. As 3
 * que faltam recebem os MESMOS moldes, com a cidade delas. Criar um estilo novo
 * só pra estas três deixaria a conta falando duas línguas.
 *
 * ⚠️ Teto de 90 caracteres. "São José dos Campos" tem 19 e estoura o molde mais
 * longo (92) — por isso cada cidade recebe os 2 primeiros moldes QUE COUBEREM,
 * conferidos antes de qualquer chamada ao Google.
 *
 * ── COMO RODAR (PowerShell) ──
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-titulos-longos.js
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-titulos-longos.js
 *   $env:VALIDAR=""; $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-titulos-longos.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

/** Teto do Google para título longo. */
const LIMITE_CARACTERES = 90;
/** Teto de títulos longos por grupo de recursos. */
const TETO = 5;

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

/**
 * Os moldes que a conta JÁ USA, copiados dos grupos de Praia Grande, Campinas e
 * Indaiatuba. Em ordem: o script pega os 2 primeiros que couberem em 90.
 * Os mais curtos vêm por último de propósito, como rede de segurança pra cidade
 * de nome comprido.
 */
const MOLDES = [
  (c) => `Loja de moda plus size em ${c}: do 44 ao 60, pra provar e levar no mesmo dia.`,
  (c) => `Blusas, saias, jaquetas e moda praia plus size pra provar na loja de ${c}.`,
  (c) => `Vestidos, blusas, calças e conjuntos plus size na Lurds de ${c}. Venha conhecer.`,
  (c) => `Na Lurds de ${c} você prova, ajusta e leva na hora. Grade do 44 ao 60, sempre.`,
  (c) => `Moda plus size feminina em ${c}. Atendimento que entende o corpo real.`,
  (c) => `Vestidos, blusas, calças e conjuntos plus size na Lurds de ${c}.`,
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

  const a = await token();

  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.name, campaign.status
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  const porGrupo = new Map();
  for (const x of await consultar(
    a,
    `SELECT asset_group_asset.asset_group, asset.text_asset.text
       FROM asset_group_asset
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'
        AND asset_group_asset.status != 'REMOVED'
        AND asset_group_asset.field_type = 'LONG_HEADLINE'`,
  )) {
    const g = x.assetGroupAsset.assetGroup;
    const s = porGrupo.get(g) || new Set();
    if (x.asset?.textAsset?.text) s.add(x.asset.textAsset.text);
    porGrupo.set(g, s);
  }

  const textoExistente = new Map();
  for (const x of await consultar(
    a,
    `SELECT asset.resource_name, asset.text_asset.text FROM asset WHERE asset.type = 'TEXT'`,
  )) {
    if (x.asset?.textAsset?.text) textoExistente.set(x.asset.textAsset.text, x.asset.resourceName);
  }

  const plano = [];
  const precisaCriar = new Set();
  for (const g of grupos) {
    const cidade = CIDADE_DA_CAMPANHA[g.campaign.name];
    if (!cidade) throw new Error(`campanha sem cidade mapeada: "${g.campaign.name}"`);

    const gRes = `customers/${CONTA}/assetGroups/${g.assetGroup.id}`;
    const atuais = porGrupo.get(gRes) || new Set();
    const vagas = Math.max(0, TETO - atuais.size);
    if (!vagas) {
      plano.push({ gRes, campanha: g.campaign.name, grupo: g.assetGroup.name, tem: atuais.size, entram: [] });
      continue;
    }

    /* Só molde que CABE em 90 e que o grupo ainda não tem. A conferência é aqui,
     * antes de qualquer chamada — texto grande demais é recusado pelo Google e
     * derruba o lote inteiro. */
    const entram = MOLDES.map((m) => m(cidade))
      .filter((t) => t.length <= LIMITE_CARACTERES && !atuais.has(t))
      .slice(0, vagas);

    for (const t of entram) if (!textoExistente.has(t)) precisaCriar.add(t);
    plano.push({ gRes, campanha: g.campaign.name, grupo: g.assetGroup.name, tem: atuais.size, entram });
  }

  plano.sort((x, y) => x.campanha.localeCompare(y.campanha));
  console.log('O QUE ENTRA');
  for (const p of plano.filter((x) => x.entram.length)) {
    console.log(`\n${p.campanha} / ${p.grupo} — ${p.tem} de ${TETO} hoje`);
    for (const t of p.entram) console.log(`  + (${String(t.length).padStart(2)}) "${t}"`);
  }
  const cheios = plano.filter((x) => !x.entram.length).length;
  const total = plano.reduce((s, p) => s + p.entram.length, 0);
  console.log(`\n${total} títulos longos a ligar · ${cheios} grupos já no teto · ${precisaCriar.size} textos novos`);

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada enviado. Para validar: $env:VALIDAR="1"');
    return;
  }
  if (!total) return console.log('nada a fazer');

  const recurso = new Map(textoExistente);
  const aCriar = [...precisaCriar];
  for (let i = 0; i < aCriar.length; i += 100) {
    const lote = aCriar.slice(i, i + 100);
    const r = await mutate(a, 'assets', lote.map((t) => ({ create: { textAsset: { text: t } } })));
    (r.results || []).forEach((res, k) => {
      if (res.resourceName) recurso.set(lote[k], res.resourceName);
    });
  }
  if (aCriar.length) console.log(`\n✔ textos: ${aCriar.length} criados`);

  /* Um lote por grupo: o teto é por grupo, e erro de um não derruba os outros. */
  let ok = 0;
  let falhou = 0;
  for (const p of plano) {
    if (!p.entram.length) continue;
    const ops = p.entram
      .map((t) => recurso.get(t))
      .filter((res) => res && res.startsWith('customers/'))
      .map((res) => ({ create: { assetGroup: p.gRes, asset: res, fieldType: 'LONG_HEADLINE' } }));
    try {
      const r = await mutate(a, 'assetGroupAssets', ops);
      ok += (r.results || []).length;
      console.log(`  ✔ ${p.campanha} / ${p.grupo} — ${ops.length} operações`);
    } catch (e) {
      falhou++;
      console.log(`  ❌ ${p.campanha} / ${p.grupo} — ${e.message.slice(0, 200)}`);
    }
  }
  console.log(
    VALIDAR ? `\n🟡 validateOnly — ${ok} aceitas, ${falhou} com erro.` : `\n🔴 APLICADO — ${ok} operações, ${falhou} grupos com erro.`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
