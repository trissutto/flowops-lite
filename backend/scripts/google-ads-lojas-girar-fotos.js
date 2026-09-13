/**
 * GIRO DAS FOTOS VERTICAIS — conta LOJAS FÍSICAS (956-499-8046).
 *
 * ── POR QUE NÃO É "trocar todas as fotos a cada 10 dias" ──
 *
 * O pedido original era esse. Custa dinheiro por dois motivos que não aparecem
 * na tela:
 *
 * 1. **10 dias não dá pra saber quem é boa.** Uma foto precisa juntar
 *    impressão suficiente antes de a diferença de CTR significar alguma coisa.
 *    Trocando a cada 10 dias, todo criativo morre antes de ser julgado — e a
 *    decisão de qual peça anunciar volta a ser palpite.
 * 2. **Mexer no criativo inteiro reabre o aprendizado da PMax.** A campanha
 *    volta a explorar, o custo por ação sobe por alguns dias, e aí a gente
 *    troca tudo de novo. É um moinho que nunca converge.
 *
 * A régua aqui é outra: **a cada ~30 dias, sai só quem foi medido E foi mal.**
 *
 * ── COMO SE MEDE, JÁ QUE O GOOGLE NÃO CONTA MAIS ──
 *
 * 🚨 `asset_group_asset.performance_label` (o "Melhor/Bom/Baixo desempenho" da
 * tela) NÃO EXISTE na API v25 — a consulta volta
 * `Unrecognized field in the query`. O rótulo ficou só na interface.
 *
 * Mas `asset_group_asset` ACEITA MÉTRICAS (impressões, cliques, CTR, conversão,
 * custo). Então a conta é nossa, e é auditável:
 *
 *   · piso de julgamento: a foto só é julgada com >= IMPRESSOES_MINIMAS no
 *     grupo nos últimos 30 dias. Abaixo disso ela FICA — é o equivalente
 *     honesto ao "ainda aprendendo", e é a trava contra girar no escuro;
 *   · reprovação: CTR abaixo de FRACAO_DO_GRUPO × (CTR médio das verticais
 *     DAQUELE grupo). A comparação é dentro da praça de propósito — Moema e
 *     Itanhaém têm patamares de CTR diferentes, e um piso fixo reprovaria a
 *     praça inteira ou nenhuma.
 *
 * ⚠️ Peça esgotada é exceção e sai com qualquer número: anúncio de peça que a
 * loja não tem é clique pago que termina em "não temos". Isso vem de graça —
 * `google-ads-fotos-verticais.js` só monta manifesto de peça com saldo, então
 * a reposição nunca traz de volta o que saiu de linha.
 *
 * ── COMO RODAR (PowerShell) ──
 *   # 1) fotos novas do catálogo (precisa do banco)
 *   railway run --service Postgres node backend/scripts/google-ads-fotos-verticais.js
 *   # 2) ver o giro proposto — não escreve nada
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-girar-fotos.js
 *   # 3) aplicar
 *   $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-girar-fotos.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

const PASTA_FOTOS = process.env.DESTINO || path.join(os.tmpdir(), 'google-ads-fotos');
const CAMPO = 'PORTRAIT_MARKETING_IMAGE';

/** Quantas verticais manter por grupo. Abaixo disso o giro repõe. */
const ALVO_POR_GRUPO = 4;
/** Piso pra julgar. Menos que isso é ruído, não desempenho. */
const IMPRESSOES_MINIMAS = Number(process.env.IMPRESSOES_MINIMAS || 1000);
/** CTR abaixo desta fração da média do PRÓPRIO grupo = reprovada. */
const FRACAO_DO_GRUPO = Number(process.env.FRACAO_DO_GRUPO || 0.6);
/** Janela de medição. 30 dias é o mesmo ciclo do giro. */
const DIAS = 30;

const pct = (v) => `${(Number(v || 0) * 100).toFixed(2)}%`;

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

async function mutate(a, recurso, operations) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/${recurso}:mutate`, {
    method: 'POST',
    headers: headers(a),
    body: JSON.stringify({ operations, validateOnly: VALIDAR || !APLICAR, partialFailure: false }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 2000)}`);
  return JSON.parse(t);
}

async function criarImagem(a, nome, arquivo) {
  const dados = fs.readFileSync(arquivo).toString('base64');
  const r = await mutate(a, 'assets', [{ create: { name: nome, imageAsset: { data: dados } } }]);
  return r.results?.[0]?.resourceName || null;
}

async function main() {
  const modo = APLICAR && !VALIDAR ? '🔴 APLICANDO' : VALIDAR ? '🟡 validateOnly' : '🟢 DRY-RUN';
  console.log(`conta ${CONTA} · API ${V} · ${modo}`);
  console.log(`régua: >= ${IMPRESSOES_MINIMAS} impressões em ${DIAS}d para julgar · reprova abaixo de ${Math.round(FRACAO_DO_GRUPO * 100)}% do CTR do grupo\n`);

  const manifestoPath = path.join(PASTA_FOTOS, 'manifesto.json');
  if (!fs.existsSync(manifestoPath)) {
    throw new Error(`sem manifesto em ${PASTA_FOTOS} — rode antes google-ads-fotos-verticais.js`);
  }
  const fotos = JSON.parse(fs.readFileSync(manifestoPath, 'utf8'));

  const a = await token();

  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.name
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  /* O vínculo sem métrica: é ele que dá o resource_name pra remover, e a lista
   * completa — inclusive as fotos que não tiveram NENHUMA impressão e por isso
   * nem aparecem na consulta com janela de data. */
  const vinculos = await consultar(
    a,
    `SELECT asset_group_asset.resource_name, asset_group_asset.asset_group,
            asset_group_asset.asset, asset.name
       FROM asset_group_asset
      WHERE asset_group_asset.field_type = '${CAMPO}'
        AND asset_group_asset.status != 'REMOVED'`,
  );

  /* A mesma coisa COM métrica. Separado de propósito: consulta com
   * `segments.date` só devolve linha que teve movimento, e uma foto morta
   * (zero impressão) sumiria da lista se eu juntasse as duas. */
  const medidos = await consultar(
    a,
    `SELECT asset_group_asset.asset_group, asset_group_asset.asset,
            metrics.impressions, metrics.clicks, metrics.ctr, metrics.conversions
       FROM asset_group_asset
      WHERE asset_group_asset.field_type = '${CAMPO}'
        AND asset_group_asset.status != 'REMOVED'
        AND segments.date DURING LAST_30_DAYS`,
  );
  const metrica = new Map();
  for (const x of medidos) {
    const k = `${x.assetGroupAsset.assetGroup}|${x.assetGroupAsset.asset}`;
    const m = metrica.get(k) || { impr: 0, cliques: 0, conv: 0 };
    m.impr += Number(x.metrics?.impressions || 0);
    m.cliques += Number(x.metrics?.clicks || 0);
    m.conv += Number(x.metrics?.conversions || 0);
    metrica.set(k, m);
  }

  const porGrupo = new Map();
  for (const x of vinculos) {
    const v = x.assetGroupAsset;
    const m = metrica.get(`${v.assetGroup}|${v.asset}`) || { impr: 0, cliques: 0, conv: 0 };
    const lista = porGrupo.get(v.assetGroup) || [];
    lista.push({
      vinculo: v.resourceName,
      asset: v.asset,
      nome: x.asset?.name || '(sem nome)',
      ...m,
      ctr: m.impr ? m.cliques / m.impr : 0,
    });
    porGrupo.set(v.assetGroup, lista);
  }

  /* ⚠️ Contar `vinculos.length` aqui MENTE: a consulta de vínculo não filtra
   * campanha, então ela traz também as verticais penduradas em grupo de
   * campanha PAUSADA (em 13/09 eram 255 — todas em grupo velho, nenhuma nas
   * 27 ativas). O número que interessa é o das ativas. */
  const emUso = grupos.reduce(
    (s, g) => s + (porGrupo.get(`customers/${CONTA}/assetGroups/${g.assetGroup.id}`) || []).length,
    0,
  );
  console.log(`${grupos.length} grupos ativos · ${emUso} fotos verticais em uso (de ${vinculos.length} na conta, o resto em campanha pausada)\n`);

  const naConta = new Map();
  for (const x of await consultar(a, `SELECT asset.resource_name, asset.name FROM asset WHERE asset.type = 'IMAGE'`)) {
    if (x.asset?.name) naConta.set(x.asset.name, x.asset.resourceName);
  }

  const remover = [];
  const plano = [];
  for (const g of grupos) {
    const gRes = `customers/${CONTA}/assetGroups/${g.assetGroup.id}`;
    const atuais = porGrupo.get(gRes) || [];

    /* CTR médio DO GRUPO, contado no agregado (soma cliques ÷ soma impressões),
     * não como média das médias — senão uma foto com 3 impressões pesa igual
     * a uma com 30 mil. */
    const somaImpr = atuais.reduce((s, x) => s + x.impr, 0);
    const somaCli = atuais.reduce((s, x) => s + x.cliques, 0);
    const ctrGrupo = somaImpr ? somaCli / somaImpr : 0;
    const corte = ctrGrupo * FRACAO_DO_GRUPO;

    const julgadas = atuais.filter((x) => x.impr >= IMPRESSOES_MINIMAS);
    const ruins = julgadas.filter((x) => x.ctr < corte);
    const ficam = atuais.filter((x) => !ruins.includes(x));

    const nomesNoGrupo = new Set(atuais.map((x) => x.nome));
    const candidatas = fotos.filter((f) => !nomesNoGrupo.has(f.nome));
    const vagas = Math.max(0, ALVO_POR_GRUPO - ficam.length);
    const entram = candidatas.slice(0, vagas);

    remover.push(...ruins.map((x) => x.vinculo));
    plano.push({
      campanha: g.campaign.name,
      grupo: g.assetGroup.name,
      forca: g.assetGroup.adStrength,
      ctrGrupo,
      corte,
      atuais,
      julgadas: julgadas.length,
      saem: ruins,
      ficam: ficam.length,
      entram,
      gRes,
    });
  }

  plano.sort((x, y) => x.campanha.localeCompare(y.campanha));
  console.log('GIRO PROPOSTO, POR GRUPO');
  for (const p of plano) {
    console.log(
      `\n${p.campanha} / ${p.grupo} (${p.forca})` +
        `\n  CTR do grupo ${pct(p.ctrGrupo)} · corte ${pct(p.corte)} · ${p.julgadas}/${p.atuais.length} fotos com impressão suficiente`,
    );
    for (const x of p.atuais) {
      const marca = p.saem.includes(x) ? '−' : x.impr >= IMPRESSOES_MINIMAS ? '✔' : '·';
      console.log(
        `    ${marca} ${String(x.nome).slice(0, 34).padEnd(34)} ${String(x.impr).padStart(7)} impr · CTR ${pct(x.ctr).padStart(7)} · ${x.conv.toFixed(1)} conv` +
          (marca === '·' ? '  (ainda sem julgamento)' : ''),
      );
    }
    if (p.entram.length) console.log(`    + entra: ${p.entram.map((e) => `${e.ref} ${e.peca}`).join(', ')}`);
    if (!p.saem.length && !p.entram.length) console.log('    (nada a girar)');
  }

  const totalEntra = plano.reduce((s, p) => s + p.entram.length, 0);
  console.log(`\n${remover.length} vínculos a remover · ${totalEntra} a criar`);

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada enviado. Para aplicar: $env:APLICAR="1"');
    return;
  }

  const usadas = new Set(plano.flatMap((p) => p.entram.map((e) => e.nome)));
  const recurso = new Map(naConta);
  for (const f of fotos.filter((x) => usadas.has(x.nome) && !naConta.has(x.nome))) {
    const res = await criarImagem(a, f.nome, path.join(PASTA_FOTOS, f.arquivo));
    if (res) recurso.set(f.nome, res);
    console.log(`  + ativo ${f.nome} → ${res || '(validateOnly)'}`);
  }

  const ops = [];
  for (const p of plano) {
    for (const e of p.entram) {
      const res = recurso.get(e.nome);
      if (res && res.startsWith('customers/')) {
        ops.push({ create: { assetGroup: p.gRes, asset: res, fieldType: CAMPO } });
      }
    }
  }

  /* ORDEM IMPORTA: adiciona ANTES de remover. Se removesse primeiro e a adição
   * falhasse, o grupo ficaria com MENOS foto do que tinha — a gente perderia
   * criativo por causa de um erro de rede. */
  let criados = 0;
  for (let i = 0; i < ops.length; i += 100) {
    const r = await mutate(a, 'assetGroupAssets', ops.slice(i, i + 100));
    criados += (r.results || []).length;
  }
  let removidos = 0;
  for (let i = 0; i < remover.length; i += 100) {
    const r = await mutate(a, 'assetGroupAssets', remover.slice(i, i + 100).map((rn) => ({ remove: rn })));
    removidos += (r.results || []).length;
  }
  console.log(
    VALIDAR
      ? '\n🟡 validateOnly — o Google aceitou; nada alterado.'
      : `\n🔴 APLICADO — ${criados} fotos entraram, ${removidos} saíram.`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
