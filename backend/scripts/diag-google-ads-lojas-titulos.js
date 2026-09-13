/**
 * TÍTULOS dos grupos de recursos — conta LOJAS FÍSICAS. Só leitura.
 *
 * ── POR QUE ──
 *
 * Comparando os grupos EXCELLENT que já existem nesta conta com os 27 ativos, o
 * gargalo que sobra depois da mistura de imagens é TÍTULO CURTO: os EXCELLENT
 * têm 19-20, os ativos têm 15-18. Todos os 27 estão abaixo de 19.
 *
 * ⚠️ MAS ANTES DE ESCREVER: é preciso saber o TETO REAL. A documentação do
 * Google fala em 15 títulos por grupo de recursos, e os grupos EXCELLENT desta
 * conta têm 19-20 — ou o teto mudou, ou eles nasceram antes de um limite novo.
 * Já aconteceu exatamente isso com TEMA DE PESQUISA nesta conta: grupos antigos
 * tinham 50, e criar mais de 25 foi recusado com RESOURCE_COUNT_LIMIT_EXCEEDED.
 * Quem escrever 5 títulos por grupo sem conferir pode levar a mesma recusa.
 *
 * Este script lê o que existe e imprime o texto de cada título, porque:
 *   · título repetido não acrescenta nada (o Google mede VARIEDADE);
 *   · título de OUTRA cidade é o defeito que já apareceu aqui — o grupo de
 *     Sorocaba carregava tema "moda plus size Moema", clonado e não trocado.
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas-titulos.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';

/** O que o Google diz querer, para dar nota cheia. */
const IDEAL = { HEADLINE: 15, LONG_HEADLINE: 5, DESCRIPTION: 5 };

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
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 500)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function main() {
  console.log(`conta ${CONTA} · API ${V} · SÓ LEITURA\n`);
  const a = await token();

  /* Todos os textos de TODOS os grupos, inclusive de campanha pausada: é nos
   * grupos EXCELLENT (muitos deles em campanha parada) que está a régua. */
  const linhas = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength, asset_group.status,
            campaign.name, campaign.status,
            asset_group_asset.field_type, asset.text_asset.text
       FROM asset_group_asset
      WHERE asset_group_asset.status != 'REMOVED'
        AND asset_group_asset.field_type IN ('HEADLINE','LONG_HEADLINE','DESCRIPTION')`,
  );

  const grupos = new Map();
  for (const x of linhas) {
    const k = `${x.assetGroup.id}`;
    const g = grupos.get(k) || {
      nome: x.assetGroup.name,
      campanha: x.campaign.name,
      forca: x.assetGroup.adStrength || '(sem nota)',
      ativo: x.campaign.status === 'ENABLED' && x.assetGroup.status === 'ENABLED',
      HEADLINE: [], LONG_HEADLINE: [], DESCRIPTION: [],
    };
    const txt = x.asset?.textAsset?.text;
    if (txt) g[x.assetGroupAsset.fieldType].push(txt);
    grupos.set(k, g);
  }

  const todos = [...grupos.values()];
  const ativos = todos.filter((g) => g.ativo);
  const otimos = todos.filter((g) => ['EXCELLENT', 'GOOD'].includes(g.forca));

  /* ── O TETO REAL, lido do que existe ─────────────────────────────────── */
  const maxPorCampo = {};
  for (const c of Object.keys(IDEAL)) {
    maxPorCampo[c] = Math.max(...todos.map((g) => g[c].length), 0);
  }
  console.log('MÁXIMO OBSERVADO NA CONTA (todos os grupos, inclusive pausados)');
  for (const c of Object.keys(IDEAL)) {
    console.log(`  ${c.padEnd(14)} maior grupo tem ${maxPorCampo[c]}  ·  o Google recomenda ${IDEAL[c]}`);
  }
  console.log(
    `\n⚠️ Se o máximo observado for MAIOR que a recomendação, são grupos antigos —` +
      `\n   não prova que dá pra criar mais hoje. Só o validateOnly decide.`,
  );

  /* ── A RÉGUA: o que os bons têm ──────────────────────────────────────── */
  /* 🚨 SEPARAR GOOD de EXCELLENT. Juntar os dois numa média só esconde a
   * resposta: se os GOOD tiverem POUCO título e mesmo assim pontuarem melhor
   * que os nossos AVERAGE, então título NÃO é o que decide a nota — e escrever
   * mais seria trabalho jogado fora. */
  const porForca = new Map();
  for (const g of todos) {
    const l = porForca.get(g.forca) || [];
    l.push(g);
    porForca.set(g.forca, l);
  }
  console.log('\nRÉGUA POR NÍVEL (todos os grupos da conta)');
  console.log('nível         grupos   títulos (mín-méd-máx)   longos   descr');
  for (const nivel of ['EXCELLENT', 'GOOD', 'AVERAGE', 'POOR', 'PENDING']) {
    const l = porForca.get(nivel);
    if (!l || !l.length) continue;
    const n = (c) => l.map((g) => g[c].length);
    const med = (c) => (n(c).reduce((s, v) => s + v, 0) / l.length).toFixed(1);
    console.log(
      `${nivel.padEnd(12)} ${String(l.length).padStart(6)}   ` +
        `${String(Math.min(...n('HEADLINE'))).padStart(3)}-${med('HEADLINE').padStart(4)}-${String(Math.max(...n('HEADLINE'))).padEnd(3)}        ` +
        `${med('LONG_HEADLINE').padStart(4)}   ${med('DESCRIPTION').padStart(5)}`,
    );
  }

  /* ── O ESTADO DOS 27 ─────────────────────────────────────────────────── */
  console.log(`\nOS ${ativos.length} GRUPOS ATIVOS`);
  console.log('força      títulos  longos  descr   campanha / grupo');
  for (const g of ativos.sort((x, y) => x.campanha.localeCompare(y.campanha))) {
    console.log(
      `${g.forca.padEnd(10)} ${String(g.HEADLINE.length).padStart(7)} ${String(g.LONG_HEADLINE.length).padStart(7)} ` +
        `${String(g.DESCRIPTION.length).padStart(6)}   ${g.campanha} / ${g.nome}`,
    );
  }

  /* ── O TEXTO QUE JÁ EXISTE, pra não repetir ──────────────────────────── */
  const usados = new Map();
  for (const g of ativos) for (const t of g.HEADLINE) usados.set(t, (usados.get(t) || 0) + 1);
  console.log(`\nTÍTULOS EM USO NOS ATIVOS: ${usados.size} textos distintos`);
  for (const [t, n] of [...usados.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(2)}×  "${t}"  (${t.length} car.)`);
  }

  const acima30 = [...usados.keys()].filter((t) => t.length > 30);
  if (acima30.length) console.log(`\n⚠️ ${acima30.length} títulos passam de 30 caracteres — o teto do Google.`);
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
