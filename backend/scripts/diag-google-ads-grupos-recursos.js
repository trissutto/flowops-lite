/**
 * POR QUE OS GRUPOS DE RECURSOS NÃO ESTÃO "ÓTIMO" — conta LOJAS FÍSICAS.
 * Só leitura; nunca escreve.
 *
 * A interface mostra "Médio" e um link "Ver recomendações" que não abriu
 * nenhuma vez em 13/09/2026. Pela API dá pra ver a mesma conta que o Google
 * faz: força do anúncio, quantos ativos de cada tipo, e se existe tema de
 * pesquisa (`asset_group_signal`) — que é o campo cuja ausência bateu com os
 * piores CTR da conta (0,21% sem tema x 4,67% com tema).
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-grupos-recursos.js
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

async function consultar(a, gaql) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`,
    { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${t.slice(0, 1200)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function main() {
  const a = await token();

  /* 1) Os grupos de recursos das campanhas ATIVAS, com a força do anúncio. */
  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.status, asset_group.ad_strength,
            campaign.id, campaign.name
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  /* 2) Os sinais (tema de pesquisa e público) de cada grupo. */
  const sinais = await consultar(
    a,
    `SELECT asset_group_signal.asset_group, asset_group_signal.search_theme.text,
            asset_group_signal.audience.audience
       FROM asset_group_signal`,
  );

  /* 3) Quantos ativos de cada tipo por grupo. */
  const ativos = await consultar(
    a,
    `SELECT asset_group_asset.asset_group, asset_group_asset.field_type, asset_group_asset.asset
       FROM asset_group_asset
      WHERE asset_group_asset.status != 'REMOVED'`,
  );

  const temas = new Map(); // assetGroup -> [textos]
  const publicos = new Map();
  for (const s of sinais) {
    const g = s.assetGroupSignal.assetGroup;
    const t = s.assetGroupSignal.searchTheme?.text;
    if (t) temas.set(g, [...(temas.get(g) || []), t]);
    if (s.assetGroupSignal.audience?.audience) publicos.set(g, (publicos.get(g) || 0) + 1);
  }

  const porTipo = new Map(); // assetGroup -> {fieldType: n}
  for (const x of ativos) {
    const g = x.assetGroupAsset.assetGroup;
    const f = x.assetGroupAsset.fieldType;
    const m = porTipo.get(g) || {};
    m[f] = (m[f] || 0) + 1;
    porTipo.set(g, m);
  }

  const linhas = grupos
    .map((g) => {
      const res = `customers/${CONTA}/assetGroups/${g.assetGroup.id}`;
      const c = porTipo.get(res) || {};
      return {
        campanha: g.campaign.name,
        grupo: g.assetGroup.name,
        forca: g.assetGroup.adStrength || '(sem nota)',
        temas: (temas.get(res) || []).length,
        publicos: publicos.get(res) || 0,
        titulos: c.HEADLINE || 0,
        titulosLongos: c.LONG_HEADLINE || 0,
        descricoes: c.DESCRIPTION || 0,
        imagens: (c.MARKETING_IMAGE || 0) + (c.SQUARE_MARKETING_IMAGE || 0) + (c.PORTRAIT_MARKETING_IMAGE || 0),
        paisagem: c.MARKETING_IMAGE || 0,
        quadrada: c.SQUARE_MARKETING_IMAGE || 0,
        retrato: c.PORTRAIT_MARKETING_IMAGE || 0,
        logos: (c.LOGO || 0) + (c.LANDSCAPE_LOGO || 0),
        videos: c.YOUTUBE_VIDEO || 0,
      };
    })
    .sort((x, y) => x.campanha.localeCompare(y.campanha));

  console.log(`conta ${CONTA} · ${linhas.length} grupos de recursos em campanhas ativas\n`);
  console.log('CAMPANHA / grupo · força · temas · títulos/longos/descr · img(pais/quad/retr) · logos · vídeos');
  for (const l of linhas) {
    const alerta = l.temas === 0 ? '  ⚠️ SEM TEMA DE PESQUISA' : '';
    console.log(
      `\n${l.campanha}\n  ${l.grupo} · ${l.forca} · temas ${l.temas} · público ${l.publicos}` +
        `\n  txt ${l.titulos}/${l.titulosLongos}/${l.descricoes} · img ${l.imagens} (${l.paisagem}p ${l.quadrada}q ${l.retrato}r) · logo ${l.logos} · vídeo ${l.videos}${alerta}`,
    );
  }

  /* Resumo do que falta, pela régua que o Google usa. */
  console.log('\n\n── O QUE FALTA, POR GRUPO ──');
  for (const l of linhas) {
    const falta = [];
    if (l.temas === 0) falta.push('tema de pesquisa');
    if (l.titulos < 11) falta.push(`títulos ${l.titulos}/15`);
    if (l.titulosLongos < 4) falta.push(`títulos longos ${l.titulosLongos}/5`);
    if (l.descricoes < 4) falta.push(`descrições ${l.descricoes}/5`);
    if (l.retrato < 1) falta.push('imagem RETRATO 4:5');
    if (l.quadrada < 1) falta.push('imagem QUADRADA 1:1');
    if (l.paisagem < 1) falta.push('imagem PAISAGEM 1.91:1');
    if (l.videos < 1) falta.push('vídeo');
    if (l.logos < 1) falta.push('logo');
    console.log(`${l.forca.padEnd(10)} ${l.campanha} / ${l.grupo}\n   ${falta.length ? falta.join(' · ') : '(nada — está completo)'}`);
  }
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
