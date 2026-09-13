/**
 * TÍTULO COM A CIDADE nos grupos de recursos — conta LOJAS FÍSICAS (956-499-8046).
 * SAI um genérico, ENTRA o da praça. Troca 1 por 1, nunca soma.
 *
 * ── POR QUE TROCA, E NÃO ACRESCENTA (erro de 13/09, corrigido) ──
 *
 * A 1ª versão ACRESCENTAVA 3 títulos por grupo e levou
 * `RESOURCE_COUNT_LIMIT_EXCEEDED` em todos: os 24 textos foram criados, nenhum
 * vínculo entrou.
 *
 * 🚨 **O teto de títulos por grupo de recursos é 15.** Os grupos desta conta
 * têm 15 a 18 porque nasceram antes da regra — o Google mantém o que já existe,
 * mas não deixa criar mais. É a MESMA armadilha do tema de pesquisa, onde
 * grupos antigos tinham 50 e criar além de 25 era recusado.
 *
 * E o pior é que eu tinha escrito o aviso no cabeçalho da versão anterior
 * ("máximo observado maior que a recomendação são grupos antigos — não prova
 * que dá pra criar mais hoje") e mesmo assim configurei o teto pelo máximo
 * observado. Regra que vale pra próxima: **teto observado nunca é teto de
 * criação; só o validateOnly decide.**
 *
 * ── POR QUE A TROCA É MELHOR QUE A SOMA ──
 *
 * O problema nunca foi FALTA de título. Régua da própria conta, medida:
 *
 *     EXCELLENT   17 grupos   5 - 15,8 - 20 títulos
 *     GOOD        21 grupos   5 - 10,5 - 17
 *     AVERAGE    123 grupos   5 -  8,9 - 19
 *
 * Os 27 ativos têm 15-18 — já na faixa dos EXCELLENT — e mesmo assim marcam
 * AVERAGE. Há EXCELLENT com 5 títulos. Quantidade não move a nota.
 *
 * O defeito é que **nenhum título diz a cidade**. Os mais usados são genéricos
 * e idênticos em toda praça: "Prove Antes de Levar" (18 grupos), "Plus Size do
 * 44 ao 60" (18), "Plus Size Perto de Você" (17). Numa campanha LOCAL isso
 * desperdiça relevância — "Plus Size em Sorocaba" casa com a busca de quem está
 * em Sorocaba; "Perto de Você" não casa com nada.
 *
 * Então trocar é o conserto certo, não o contorno: substitui o vago pelo
 * específico sem inchar o grupo.
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
  /* Nome CURTO de propósito: "São José dos Campos" tem 19 caracteres e
   * "Loja Plus Size São José dos Campos" daria 34, acima do teto de 30. */
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
 *   1. categoria + lugar ...... "moda plus size sorocaba"
 *   2. LOJA + lugar ........... "loja plus size sorocaba" — quem já quer ir
 *   3. TAMANHO + lugar ........ a dor real da cliente plus size
 * O terceiro carrega "do 44 ao 60" porque esse texto já tem 18 usos na conta e
 * funciona; o que faltava era amarrar à praça.
 */
const MOLDES = [
  (c) => `Plus Size em ${c}`,
  (c) => `Loja Plus Size ${c}`,
  (c) => `${c}: do 44 ao 60`,
];

/**
 * QUEM SAI, em ordem de preferência. Só o vago — o que não diz nem lugar nem
 * proposta. O primeiro é o substituído direto: "Perto de Você" vira o nome da
 * cidade, que é a mesma promessa dita de um jeito que casa com a busca.
 *
 * ⚠️ O que NÃO entra nesta lista, e por quê:
 *   "Prove Antes de Levar" — é o diferencial da loja física contra o site.
 *   "Plus Size do 44 ao 60" / "do 46 ao 60" — a grade é informação concreta.
 *   "Lurds Plus Size" — é a marca.
 */
const REMOVIVEIS = [
  'Plus Size Perto de Você',
  'Encontre sua loja',
  'Sua Moda Plus Size',
  'Roupas Lindas Plus Size',
  'Moda que Valoriza Você',
  'Looks Exclusivos Plus Size',
  'Peças Elegantes Plus Size',
  'Moda Plus Size Elegante',
  /* Estes dois vão POR ÚLTIMO e só se faltar candidato: a grade é informação
   * concreta e boa. Mas "Sorocaba: do 44 ao 60" diz a MESMA coisa mais o lugar,
   * então trocar um pelo outro é upgrade, não perda. Nunca saem se houver um
   * genérico de verdade disponível antes. */
  'Plus Size do 44 ao 60',
  'Plus Size do 46 ao 60',
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

  /* Conferir tamanho ANTES de falar com o Google. */
  const longos = [];
  for (const cidade of new Set(Object.values(CIDADE_DA_CAMPANHA))) {
    for (const molde of MOLDES) {
      const t = molde(cidade);
      if (t.length > LIMITE_CARACTERES) longos.push(`${t} (${t.length})`);
    }
  }
  if (longos.length) throw new Error(`acima de ${LIMITE_CARACTERES} caracteres:\n  ${longos.join('\n  ')}`);

  const a = await token();

  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.name, campaign.status
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  /* Os títulos de cada grupo COM o resource_name do vínculo — é ele que remove. */
  const porGrupo = new Map();
  for (const x of await consultar(
    a,
    `SELECT asset_group_asset.asset_group, asset_group_asset.resource_name, asset.text_asset.text
       FROM asset_group_asset
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'
        AND asset_group_asset.status != 'REMOVED'
        AND asset_group_asset.field_type = 'HEADLINE'`,
  )) {
    const g = x.assetGroupAsset.assetGroup;
    const l = porGrupo.get(g) || [];
    if (x.asset?.textAsset?.text) l.push({ texto: x.asset.textAsset.text, vinculo: x.assetGroupAsset.resourceName });
    porGrupo.set(g, l);
  }

  /* Texto que já existe na conta é reaproveitado — criar duplicata é recusado.
   * A rodada de 13/09 já criou os 24 textos de cidade; eles estão aqui. */
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
    const campanha = g.campaign.name;
    const cidade = CIDADE_DA_CAMPANHA[campanha];
    if (!cidade) throw new Error(`campanha sem cidade mapeada: "${campanha}"`);

    const gRes = `customers/${CONTA}/assetGroups/${g.assetGroup.id}`;
    const atuais = porGrupo.get(gRes) || [];
    const textos = new Set(atuais.map((x) => x.texto));

    const querEntrar = MOLDES.map((m) => m(cidade)).filter((t) => !textos.has(t));
    /* Só sai o que está na lista de vagos E existe neste grupo, na ordem da lista. */
    const podeSair = REMOVIVEIS.map((t) => atuais.find((x) => x.texto === t)).filter(Boolean);

    /* TROCA 1 POR 1: o número de títulos do grupo não muda, então o teto não é
     * tocado. Se faltar candidato a sair, entra menos — nunca estoura. */
    const n = Math.min(querEntrar.length, podeSair.length);
    const entram = querEntrar.slice(0, n);
    const saem = podeSair.slice(0, n);

    for (const t of entram) if (!textoExistente.has(t)) precisaCriar.add(t);
    plano.push({ gRes, campanha, grupo: g.assetGroup.name, forca: g.assetGroup.adStrength, tem: atuais.length, entram, saem });
  }

  plano.sort((x, y) => x.campanha.localeCompare(y.campanha));
  console.log('TROCA POR GRUPO  (1 por 1 — o total de títulos não muda)');
  for (const p of plano) {
    console.log(`\n${p.campanha} / ${p.grupo} (${p.forca}) — ${p.tem} títulos`);
    if (!p.entram.length) {
      console.log('  (nada a trocar)');
      continue;
    }
    for (let i = 0; i < p.entram.length; i++) {
      console.log(`  − "${p.saem[i].texto}"\n  + "${p.entram[i]}"`);
    }
  }

  const total = plano.reduce((s, p) => s + p.entram.length, 0);
  console.log(`\n${total} trocas em ${plano.filter((p) => p.entram.length).length} grupos · ${precisaCriar.size} textos novos a criar`);

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

  /* Um lote POR GRUPO, remove e cria JUNTOS: o Google avalia o teto sobre o
   * ESTADO FINAL, então a troca cabe mesmo com o grupo no limite. Foi assim que
   * a troca de imagens passou. Lote único faria o erro de um derrubar os outros. */
  let ok = 0;
  let falhou = 0;
  for (const p of plano) {
    if (!p.entram.length) continue;
    const ops = [
      ...p.saem.map((s) => ({ remove: s.vinculo })),
      ...p.entram
        .map((t) => recurso.get(t))
        .filter((res) => res && res.startsWith('customers/'))
        .map((res) => ({ create: { assetGroup: p.gRes, asset: res, fieldType: 'HEADLINE' } })),
    ];
    try {
      const r = await mutate(a, 'assetGroupAssets', ops);
      ok += (r.results || []).length;
      console.log(`  ✔ ${p.campanha} / ${p.grupo} — ${ops.length} operações`);
    } catch (e) {
      falhou++;
      console.log(`  ❌ ${p.campanha} / ${p.grupo} — ${e.message.slice(0, 200)}`);
      if (/RESOURCE_EXHAUSTED|429/.test(e.message)) {
        console.log('\n🛑 cota esgotada — parando. Rodar de novo depois é seguro: é idempotente.');
        break;
      }
    }
  }
  console.log(
    VALIDAR
      ? `\n🟡 validateOnly — ${ok} aceitas, ${falhou} com erro. Nada alterado.`
      : `\n🔴 APLICADO — ${ok} operações, ${falhou} grupos com erro.`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
