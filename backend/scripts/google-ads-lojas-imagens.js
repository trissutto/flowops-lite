/**
 * LOGO + FOTO VERTICAL 4:5 nos grupos de recursos — conta LOJAS FÍSICAS (956-499-8046).
 *
 * ── O QUE ISTO CONSERTA (medido pela API em 13/09/2026) ──
 *
 * Os 27 grupos de recursos das campanhas ativas estão TODOS em força "Médio",
 * e dois buracos são de 100%:
 *   🔴 LOGO ....................... falta em 27 de 27
 *   🔴 imagem RETRATO 4:5 ......... falta em 27 de 27
 *
 * Logo não é enfeite: sem ele o Google não monta metade dos formatos (perfil
 * do anunciante, Discover, Gmail) — o grupo fica de fora desses leilões. E o
 * 4:5 é o formato do FEED DE CELULAR, que é onde a cliente está.
 *
 * ── DE ONDE SAI CADA COISA ──
 *   logo ...... `backend/assets/google-ads/logo-1x1.png` e `logo-4x1.png`,
 *               gerados de `ARQUIVOS/LOGO EM PRETO PNG.png` (a arte oficial,
 *               versionada no repo) por `google-ads-gerar-logos.js`
 *   fotos ..... `google-ads-fotos-verticais.js` baixa do catálogo do site,
 *               corta 4:5 e deixa um `manifesto.json` no temp
 *
 * ── IDEMPOTÊNCIA ──
 * Nada é criado duas vezes. O script casa pelo NOME do ativo (que carrega a
 * REF e a data) e pelos vínculos que já existem em `asset_group_asset`. Rodar
 * de novo depois de meia aplicação continua de onde parou.
 *
 * ── COMO RODAR (PowerShell) ──
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-imagens.js
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-imagens.js
 *   $env:VALIDAR=""; $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-imagens.js
 *
 * Default é NÃO APLICAR — `APLICAR=1 railway ...` é sintaxe de bash e no
 * PowerShell a env não chega; se o default fosse aplicar, um comando mal
 * copiado escreveria na conta viva.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
/** CHUMBADA: o script irmão de e-commerce lê GOOGLE_ADS_CONTAS[0], que é OUTRA conta. */
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

const RAIZ = path.resolve(__dirname, '..', '..');
const PASTA_LOGO = path.join(RAIZ, 'backend', 'assets', 'google-ads');
const PASTA_FOTOS = process.env.DESTINO || path.join(os.tmpdir(), 'google-ads-fotos');

/** Teto do Google por grupo de recursos. Não ultrapassar: a API recusa o lote inteiro. */
const TETO = { LOGO: 5, LANDSCAPE_LOGO: 5, PORTRAIT_MARKETING_IMAGE: 20 };
/** Quantas fotos verticais deixar em cada grupo. 4 dá variedade sem virar depósito. */
const FOTOS_POR_GRUPO = 4;

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

/**
 * Sobe UMA imagem e devolve o resourceName. Uma por requisição de propósito:
 * em base64 cada foto passa de 400 KB e um lote de 8 estouraria o corpo.
 */
async function criarImagem(a, nome, arquivo) {
  const dados = fs.readFileSync(arquivo).toString('base64');
  const r = await mutate(a, 'assets', [{ create: { name: nome, imageAsset: { data: dados } } }]);
  return r.results?.[0]?.resourceName || null;
}

async function main() {
  const modo = APLICAR && !VALIDAR ? '🔴 APLICANDO' : VALIDAR ? '🟡 validateOnly' : '🟢 DRY-RUN';
  console.log(`conta ${CONTA} · API ${V} · ${modo}\n`);

  /* ── 1) O QUE TEMOS PRA SUBIR ─────────────────────────────────────────── */
  const manifestoPath = path.join(PASTA_FOTOS, 'manifesto.json');
  if (!fs.existsSync(manifestoPath)) {
    throw new Error(`sem manifesto em ${PASTA_FOTOS} — rode antes google-ads-fotos-verticais.js`);
  }
  const fotos = JSON.parse(fs.readFileSync(manifestoPath, 'utf8'));

  const desejados = [
    { campo: 'LOGO', nome: 'Lurds logo 1x1', arquivo: path.join(PASTA_LOGO, 'logo-1x1.png') },
    { campo: 'LANDSCAPE_LOGO', nome: 'Lurds logo 4x1', arquivo: path.join(PASTA_LOGO, 'logo-4x1.png') },
    ...fotos.map((f) => ({
      campo: 'PORTRAIT_MARKETING_IMAGE',
      nome: f.nome,
      arquivo: path.join(PASTA_FOTOS, f.arquivo),
      rotulo: `${f.ref} · ${f.peca}`,
    })),
  ];
  for (const d of desejados) {
    if (!fs.existsSync(d.arquivo)) throw new Error(`arquivo não existe: ${d.arquivo}`);
  }

  const a = await token();

  /* ── 2) O QUE JÁ EXISTE NA CONTA ──────────────────────────────────────── */
  const jaNaConta = new Map(); // nome -> resourceName
  const achados = await consultar(
    a,
    `SELECT asset.resource_name, asset.name FROM asset WHERE asset.type = 'IMAGE'`,
  );
  for (const x of achados) {
    if (x.asset && x.asset.name) jaNaConta.set(x.asset.name, x.asset.resourceName);
  }

  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength, campaign.name
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  /** grupo → quantos de cada campo já tem (pra respeitar o teto e não duplicar). */
  const jaLigado = new Map();
  const vinculos = await consultar(
    a,
    `SELECT asset_group_asset.asset_group, asset_group_asset.asset, asset_group_asset.field_type
       FROM asset_group_asset WHERE asset_group_asset.status != 'REMOVED'`,
  );
  for (const x of vinculos) {
    const g = x.assetGroupAsset.assetGroup;
    const m = jaLigado.get(g) || { campos: new Map(), pares: new Set() };
    const f = x.assetGroupAsset.fieldType;
    m.campos.set(f, (m.campos.get(f) || 0) + 1);
    m.pares.add(`${f}|${x.assetGroupAsset.asset}`);
    jaLigado.set(g, m);
  }

  console.log(`${grupos.length} grupos de recursos ativos · ${jaNaConta.size} imagens já na conta\n`);

  /* ── 3) CRIAR OS ATIVOS QUE FALTAM ────────────────────────────────────── */
  console.log('ATIVOS DE IMAGEM');
  const recurso = new Map(); // nome -> resourceName
  for (const d of desejados) {
    const existente = jaNaConta.get(d.nome);
    if (existente) {
      console.log(`  = ${d.nome}  (já existe)`);
      recurso.set(d.nome, existente);
      continue;
    }
    const kb = Math.round(fs.statSync(d.arquivo).size / 1024);
    if (!APLICAR && !VALIDAR) {
      console.log(`  + ${d.nome}  ${d.campo} · ${kb} KB${d.rotulo ? ` · ${d.rotulo}` : ''}`);
      recurso.set(d.nome, null);
      continue;
    }
    const res = await criarImagem(a, d.nome, d.arquivo);
    console.log(`  + ${d.nome}  ${d.campo} · ${kb} KB → ${res || '(validateOnly)'}`);
    /* No validateOnly o Google não devolve resourceName real; sem ele não dá
     * pra montar o vínculo, então a etapa 4 só escreve mesmo no APLICAR. */
    recurso.set(d.nome, res);
  }

  /* ── 4) LIGAR NOS GRUPOS ──────────────────────────────────────────────── */
  const ops = [];
  const resumo = [];
  for (const g of grupos) {
    const gRes = `customers/${CONTA}/assetGroups/${g.assetGroup.id}`;
    const estado = jaLigado.get(gRes) || { campos: new Map(), pares: new Set() };
    const falta = [];

    const ligar = (d) => {
      const res = recurso.get(d.nome);
      const tem = estado.campos.get(d.campo) || 0;
      if (tem >= (TETO[d.campo] || 20)) return;
      if (res && estado.pares.has(`${d.campo}|${res}`)) return;
      estado.campos.set(d.campo, tem + 1);
      falta.push(d.campo === 'PORTRAIT_MARKETING_IMAGE' ? `4:5 ${d.rotulo.split(' · ')[0]}` : d.campo.toLowerCase());
      if (res && res.startsWith('customers/')) {
        ops.push({ create: { assetGroup: gRes, asset: res, fieldType: d.campo } });
      }
    };

    ligar(desejados[0]); // LOGO 1:1
    ligar(desejados[1]); // LANDSCAPE_LOGO 4:1
    for (const d of desejados.slice(2, 2 + FOTOS_POR_GRUPO)) ligar(d);

    resumo.push({
      campanha: g.campaign.name,
      grupo: g.assetGroup.name,
      forca: g.assetGroup.adStrength,
      falta,
    });
  }

  resumo.sort((x, y) => x.campanha.localeCompare(y.campanha));
  console.log('\nVÍNCULOS A CRIAR, POR GRUPO');
  for (const r of resumo) {
    console.log(
      `  ${r.campanha} / ${r.grupo} (${r.forca})\n     ${r.falta.length ? r.falta.join(' · ') : '(nada — já completo)'}`,
    );
  }

  const total = resumo.reduce((s, r) => s + r.falta.length, 0);
  console.log(`\n${total} vínculos em ${grupos.length} grupos`);

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada enviado. Para validar: $env:VALIDAR="1"');
    return;
  }
  if (!ops.length) {
    console.log(
      VALIDAR
        ? '\n🟡 validateOnly — os ATIVOS passaram no servidor do Google. O vínculo só pode ser validado depois de o ativo existir (o validateOnly não devolve id), então ele vai junto no APLICAR.'
        : '\nnada a ligar',
    );
    return;
  }

  let feitos = 0;
  for (let i = 0; i < ops.length; i += 100) {
    const r = await mutate(a, 'assetGroupAssets', ops.slice(i, i + 100));
    feitos += (r.results || []).length;
  }
  console.log(`\n🔴 APLICADO — ${feitos} vínculos criados.`);
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
