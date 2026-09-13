/**
 * REBALANCEIA AS IMAGENS dos grupos de recursos — conta LOJAS FÍSICAS (956-499-8046).
 *
 * ── O QUE ESTE ARQUIVO DESCOBRIU DEPOIS DE ERRAR (13/09/2026) ──
 *
 * A 1ª versão tentava DUAS coisas, e as duas estavam erradas:
 *
 * 1. **Ligar LOGO no grupo de recursos.** Recusado com
 *    `BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL`. As 14 PMax têm
 *    **Brand Guidelines ligado**, e nesse modo o Google MOVE o logo pro nível de
 *    CAMPANHA e marca o vínculo do grupo como REMOVED.
 *    🚨 Pior: o censo que dizia "falta logo em 27 de 27 grupos" era o ERRO.
 *    Ele contava `asset_group_asset` com `status != 'REMOVED'`, via zero e lia
 *    como buraco. As 14 campanhas SEMPRE tiveram LOGO + LANDSCAPE_LOGO +
 *    BUSINESS_NAME, e a arte de lá é MAIOR que a que eu tinha gerado
 *    (1866x1866, 1772x1772, 2363x592 contra 1200x1200). Não faltava nada.
 *
 * 2. **Só ACRESCENTAR imagem.** Recusado com `RESOURCE_LIMIT`, trigger
 *    `ENABLED_IMAGE_ASSET_LINKS_PER_ASSET_GROUP`. O teto é **20 imagens do
 *    anunciante por grupo** — soma de MARKETING_IMAGE + SQUARE_MARKETING_IMAGE
 *    + PORTRAIT_MARKETING_IMAGE. Provado empiricamente: aceita em 20, recusa em
 *    21. E 26 dos 27 grupos já estão em 20/20 (só Anália Franco tem 19).
 *    ⚠️ Os 20-38 `AD_IMAGE` por grupo **NÃO contam** nesse teto: são recortes que
 *    o próprio Google gerou (`source: AUTOMATICALLY_CREATED`), e 597 das 599
 *    tiveram ZERO impressão em 30 dias. Removê-las não abre vaga nenhuma.
 *
 * ── ENTÃO O PROBLEMA NÃO É QUANTIDADE, É MISTURA ──
 *
 * Comparando os grupos EXCELLENT que já existem nesta conta com os 27 ativos:
 *
 *              paisagem 1.91:1   quadrada 1:1   retrato 4:5
 *   EXCELLENT       7-9              7-9            2-4
 *   os 27 ativos    1-2             18-19            0
 *
 * As MESMAS 20 vagas. A diferença é só como foram gastas — tudo entupido de
 * quadrada. Por isso aqui não se "adiciona": se TROCA.
 *
 * (Títulos longos, descrições e vídeo NÃO são o gargalo: nesses três os AVERAGE
 * empatam ou ganham dos EXCELLENT. O gargalo secundário é título curto —
 * EXCELLENT tem 19-20, os ativos têm 15-18 — e isso é assunto de outro script.)
 *
 * ── COMO ESCOLHE QUEM SAI ──
 *
 * Só sai QUADRADA, e pela pior medição de 30 dias: zero impressão primeiro,
 * depois pior CTR. Nunca sai paisagem (é o que está faltando) nem retrato.
 * O relatório imprime quanto das impressões do grupo está sendo sacrificado —
 * se esse número assustar, é pra parar antes de aplicar.
 *
 * Remover e criar vão na MESMA requisição: o Google avalia o teto sobre o
 * ESTADO FINAL, então não existe janela em que o grupo fique sem imagem.
 *
 * ── COMO RODAR (PowerShell) ──
 *   railway run --service Postgres node backend/scripts/google-ads-fotos-verticais.js
 *   node backend/scripts/google-ads-paisagem-montada.js
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-imagens.js
 *   $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-imagens.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
/** CHUMBADA: o script irmão de e-commerce lê GOOGLE_ADS_CONTAS[0], que é OUTRA conta. */
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

const PASTA_FOTOS = process.env.DESTINO || path.join(os.tmpdir(), 'google-ads-fotos');

/** Teto provado: 20 imagens do ANUNCIANTE por grupo (AD_IMAGE não entra). */
const TETO_IMAGENS = 20;
/** Os três campos que disputam as 20 vagas. */
const CAMPOS_IMAGEM = ['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE'];

/**
 * A mistura alvo. Some 20 de propósito — é o teto.
 *
 * Fica na borda BAIXA da faixa dos EXCELLENT (7-9 / 7-9 / 2-4) porque cada vaga
 * de paisagem sai de uma quadrada que HOJE roda. Ir pro topo da faixa tiraria
 * mais 2-3 quadradas por grupo sem prova de que os 2 pontos extras valem.
 */
const ALVO = {
  MARKETING_IMAGE: 6,
  SQUARE_MARKETING_IMAGE: 10,
  PORTRAIT_MARKETING_IMAGE: 4,
};

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
        .map((e) => `${JSON.stringify(e.errorCode)}${e.trigger ? ` ${JSON.stringify(e.trigger)}` : ''}: ${e.message}`)
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

/** Uma imagem por requisição: em base64 cada foto passa de 400 KB. */
async function criarImagem(a, nome, arquivo) {
  const dados = fs.readFileSync(arquivo).toString('base64');
  const r = await mutate(a, 'assets', [{ create: { name: nome, imageAsset: { data: dados } } }]);
  return r.results?.[0]?.resourceName || null;
}

async function main() {
  const modo = APLICAR && !VALIDAR ? '🔴 APLICANDO' : VALIDAR ? '🟡 validateOnly' : '🟢 DRY-RUN';
  console.log(`conta ${CONTA} · API ${V} · ${modo}`);
  console.log(`alvo por grupo: ${ALVO.MARKETING_IMAGE} paisagem · ${ALVO.SQUARE_MARKETING_IMAGE} quadrada · ${ALVO.PORTRAIT_MARKETING_IMAGE} retrato (teto ${TETO_IMAGENS})\n`);

  const manifestoPath = path.join(PASTA_FOTOS, 'manifesto.json');
  if (!fs.existsSync(manifestoPath)) {
    throw new Error(`sem manifesto em ${PASTA_FOTOS} — rode antes google-ads-fotos-verticais.js e google-ads-paisagem-montada.js`);
  }
  const manifesto = JSON.parse(fs.readFileSync(manifestoPath, 'utf8'));
  for (const m of manifesto) {
    const p = path.join(PASTA_FOTOS, m.arquivo);
    if (!fs.existsSync(p)) throw new Error(`arquivo do manifesto não existe: ${p}`);
  }
  const novas = {
    MARKETING_IMAGE: manifesto.filter((m) => m.campo === 'MARKETING_IMAGE'),
    PORTRAIT_MARKETING_IMAGE: manifesto.filter((m) => m.campo === 'PORTRAIT_MARKETING_IMAGE'),
  };
  console.log(`manifesto: ${novas.MARKETING_IMAGE.length} paisagem · ${novas.PORTRAIT_MARKETING_IMAGE.length} retrato\n`);

  const a = await token();

  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.name, campaign.status
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  /* Inventário SEM data: consulta com segments.date omite linha sem movimento,
   * e imagem com zero impressão é justamente a que eu quero achar. */
  const vinculos = await consultar(
    a,
    `SELECT asset_group_asset.resource_name, asset_group_asset.asset_group, asset_group_asset.asset,
            asset_group_asset.field_type, asset.name
       FROM asset_group_asset
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'
        AND asset_group_asset.status != 'REMOVED'
        AND asset_group_asset.field_type IN (${CAMPOS_IMAGEM.map((c) => `'${c}'`).join(',')})`,
  );

  /* Agora as métricas, em consulta separada e casada por (grupo|ativo). */
  const medidos = await consultar(
    a,
    `SELECT asset_group_asset.asset_group, asset_group_asset.asset, asset_group_asset.field_type,
            metrics.impressions, metrics.clicks, metrics.conversions
       FROM asset_group_asset
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'
        AND asset_group_asset.status != 'REMOVED'
        AND asset_group_asset.field_type IN (${CAMPOS_IMAGEM.map((c) => `'${c}'`).join(',')})
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
      campo: v.fieldType,
      nome: x.asset?.name || '(sem nome)',
      ...m,
      ctr: m.impr ? m.cliques / m.impr : 0,
    });
    porGrupo.set(v.assetGroup, lista);
  }

  /* Ativos que já existem na conta, por NOME — é a idempotência. */
  const naConta = new Map();
  for (const x of await consultar(a, `SELECT asset.resource_name, asset.name FROM asset WHERE asset.type = 'IMAGE'`)) {
    if (x.asset?.name) naConta.set(x.asset.name, x.asset.resourceName);
  }
  const aCriar = manifesto.filter((m) => !naConta.has(m.nome));
  console.log(`${grupos.length} grupos ativos · ${aCriar.length} ativos novos a criar (${manifesto.length - aCriar.length} já existem)\n`);

  /* ── PLANO, GRUPO A GRUPO ────────────────────────────────────────────── */
  const plano = [];
  for (const g of grupos) {
    const gRes = `customers/${CONTA}/assetGroups/${g.assetGroup.id}`;
    const atuais = porGrupo.get(gRes) || [];
    const tem = (campo) => atuais.filter((x) => x.campo === campo);

    const nomesNoGrupo = new Set(atuais.map((x) => x.nome));
    const entram = [];
    for (const campo of ['MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE']) {
      const faltam = Math.max(0, ALVO[campo] - tem(campo).length);
      entram.push(...novas[campo].filter((n) => !nomesNoGrupo.has(n.nome)).slice(0, faltam));
    }

    /* Só QUADRADA sai, e o quanto for preciso pra caber. Pior primeiro:
     * zero impressão, depois pior CTR, e em empate a que menos converteu. */
    const excedente = atuais.length + entram.length - TETO_IMAGENS;
    const quadradas = tem('SQUARE_MARKETING_IMAGE')
      .slice()
      .sort((x, y) => x.impr - y.impr || x.ctr - y.ctr || x.conv - y.conv);
    /* Nunca deixar a quadrada abaixo do alvo — é formato obrigatório do Google. */
    const podeSair = Math.max(0, quadradas.length - ALVO.SQUARE_MARKETING_IMAGE);
    const saem = quadradas.slice(0, Math.min(Math.max(0, excedente), podeSair));

    /* Se não abriu vaga suficiente, corta a entrada — nunca estoura o teto. */
    const vagas = TETO_IMAGENS - (atuais.length - saem.length);
    const entramCabem = entram.slice(0, Math.max(0, vagas));

    const imprGrupo = atuais.reduce((s, x) => s + x.impr, 0);
    const imprSaem = saem.reduce((s, x) => s + x.impr, 0);

    plano.push({
      gRes,
      campanha: g.campaign.name,
      grupo: g.assetGroup.name,
      forca: g.assetGroup.adStrength,
      antes: {
        paisagem: tem('MARKETING_IMAGE').length,
        quadrada: tem('SQUARE_MARKETING_IMAGE').length,
        retrato: tem('PORTRAIT_MARKETING_IMAGE').length,
      },
      saem,
      entram: entramCabem,
      imprGrupo,
      imprSaem,
      zeradasQueSaem: saem.filter((x) => x.impr === 0).length,
    });
  }

  plano.sort((x, y) => x.campanha.localeCompare(y.campanha));

  console.log('PLANO POR GRUPO  (antes → depois · o que sai custa quanto)');
  for (const p of plano) {
    const dep = {
      paisagem: p.antes.paisagem + p.entram.filter((e) => e.campo === 'MARKETING_IMAGE').length,
      quadrada: p.antes.quadrada - p.saem.length,
      retrato: p.antes.retrato + p.entram.filter((e) => e.campo === 'PORTRAIT_MARKETING_IMAGE').length,
    };
    const custo = p.imprGrupo ? p.imprSaem / p.imprGrupo : 0;
    console.log(
      `\n${p.campanha} / ${p.grupo} (${p.forca})` +
        `\n  paisagem ${p.antes.paisagem}→${dep.paisagem} · quadrada ${p.antes.quadrada}→${dep.quadrada} · retrato ${p.antes.retrato}→${dep.retrato}` +
        `\n  saem ${p.saem.length} quadradas (${p.zeradasQueSaem} com ZERO impressão) — custam ${p.imprSaem} de ${p.imprGrupo} impressões = ${pct(custo)} do grupo`,
    );
    if (custo > 0.15) console.log('  ⚠️  MAIS DE 15% DAS IMPRESSÕES DO GRUPO — olhe antes de aplicar');
  }

  const totalSai = plano.reduce((s, p) => s + p.saem.length, 0);
  const totalEntra = plano.reduce((s, p) => s + p.entram.length, 0);
  const imprTotal = plano.reduce((s, p) => s + p.imprGrupo, 0);
  const imprSacrificada = plano.reduce((s, p) => s + p.imprSaem, 0);
  const zeradas = plano.reduce((s, p) => s + p.zeradasQueSaem, 0);

  console.log(
    `\n── TOTAL ──\n${totalSai} quadradas saem (${zeradas} delas com ZERO impressão em 30d) · ${totalEntra} entram` +
      `\nimpressões sacrificadas: ${imprSacrificada} de ${imprTotal} = ${pct(imprTotal ? imprSacrificada / imprTotal : 0)} da conta`,
  );

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada enviado. Para aplicar: $env:APLICAR="1"');
    return;
  }

  /* ── CRIAR OS ATIVOS ─────────────────────────────────────────────────── */
  const recurso = new Map(naConta);
  for (const m of aCriar) {
    const res = await criarImagem(a, m.nome, path.join(PASTA_FOTOS, m.arquivo));
    if (res) recurso.set(m.nome, res);
    console.log(`  + ativo ${m.nome} → ${res || '(validateOnly)'}`);
  }

  /* ── TROCAR ──────────────────────────────────────────────────────────────
   * Um lote POR GRUPO: o teto é por grupo, e lote único de 27 grupos faria o
   * erro de um derrubar os outros 26 (partialFailure está desligado de
   * propósito — troca pela metade é pior que troca nenhuma). */
  let ok = 0;
  let falhou = 0;
  for (const p of plano) {
    /* ⚠️ O par (recurso, campo) anda JUNTO até o fim. A 1ª versão fazia
     * `.map(pega recurso).filter(existe).map((res, i) => ... p.entram[i].campo)`
     * — e depois do filter o índice já não aponta pro mesmo item: bastava UM
     * ativo faltando pra uma paisagem subir marcada como retrato. */
    const ops = [
      ...p.saem.map((s) => ({ remove: s.vinculo })),
      ...p.entram
        .map((e) => ({ res: recurso.get(e.nome), campo: e.campo }))
        .filter((x) => x.res && x.res.startsWith('customers/'))
        .map((x) => ({ create: { assetGroup: p.gRes, asset: x.res, fieldType: x.campo } })),
    ];
    if (!ops.length) continue;
    try {
      const r = await mutate(a, 'assetGroupAssets', ops);
      ok += (r.results || []).length;
      console.log(`  ✔ ${p.campanha} / ${p.grupo} — ${ops.length} operações`);
    } catch (e) {
      falhou++;
      console.log(`  ❌ ${p.campanha} / ${p.grupo} — ${e.message.slice(0, 260)}`);
    }
  }
  console.log(
    VALIDAR
      ? `\n🟡 validateOnly — ${ok} operações aceitas, ${falhou} grupos com erro. Nada alterado.`
      : `\n🔴 APLICADO — ${ok} operações, ${falhou} grupos com erro.`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
