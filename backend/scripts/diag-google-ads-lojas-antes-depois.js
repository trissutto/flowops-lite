/**
 * ANTES × DEPOIS da conta LOJAS FÍSICAS — só leitura, nunca escreve.
 *
 * ── O QUE ESTE ARQUIVO RESPONDE, E O QUE ELE SE RECUSA A RESPONDER ──
 *
 * Em 13/09/2026 mexemos em três coisas na conta, todas no mesmo dia:
 *   · orçamento e pausas (Sorocaba 120, Campinas 100, 3 Search pausadas)
 *   · tema de pesquisa em 17 grupos que estavam com ZERO
 *   · troca da mistura de imagens — mas só em 4 dos 27 grupos, porque a cota
 *     de escrita da API estourou no meio
 *
 * 🚨 **Desempenho de campanha NÃO se lê em horas.** Mudança feita hoje não tem
 * o que mostrar hoje: o Google consolida relatório com algumas horas de atraso,
 * o dia corrente está pela metade, e PMax reabre aprendizado depois de mudança
 * grande — os primeiros dias são exploração, não resultado. Quem olhar o número
 * de hoje e concluir alguma coisa vai concluir errado, pros dois lados.
 *
 * Então este script faz duas coisas honestas:
 *
 * 1. **O QUE JÁ DÁ**: compara a FORÇA DO ANÚNCIO dos 4 grupos trocados com a
 *    dos 23 intocados. Mesma conta, mesmo dia, mesma sazonalidade — é o teste
 *    mais limpo que existe pra tese de que o gargalo era a MISTURA de formatos.
 *    A força é calculada pelo Google sobre a COMPOSIÇÃO do grupo, não sobre
 *    resultado, então ela pode responder em horas.
 *
 * 2. **O QUE NÃO DÁ AINDA**: imprime a linha do tempo diária como LINHA DE
 *    BASE, marcando o dia da mudança. Serve pra daqui a uma semana a comparação
 *    existir — não pra tirar conclusão agora.
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas-antes-depois.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';

/** Os 4 que a cota deixou passar antes de estourar (13/09 ~17h15). */
const TROCADOS = new Set([
  'ANÁLIA FRANCO PMax 01.06.26 [Petter]|Recursos Anália',
  'CAMPINAS PMax 27.08.25 [Petter]|Recursos Campinas',
  'INDAIATUBA PMax 27.08.25 [Petter]|Grupo de recursos 1',
  'JUNDIAÍ PMax 27.08.25 [Petter]|outubro_20-10',
]);

const brl = (m) => `R$ ${(Number(m || 0) / 1_000_000).toFixed(2).replace('.', ',')}`;
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

async function consultar(a, gaql) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/googleAds:searchStream`,
    { method: 'POST', headers: headers(a), body: JSON.stringify({ query: gaql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${t.slice(0, 700)}`);
  const j = JSON.parse(t);
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function main() {
  const a = await token();

  /* ── 1) O QUE JÁ DÁ PRA LER: força do anúncio, trocados × intocados ───── */
  const grupos = await consultar(
    a,
    `SELECT asset_group.id, asset_group.name, asset_group.ad_strength,
            campaign.name, campaign.status
       FROM asset_group
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'`,
  );

  const imagens = await consultar(
    a,
    `SELECT asset_group_asset.asset_group, asset_group_asset.field_type
       FROM asset_group_asset
      WHERE campaign.status = 'ENABLED' AND asset_group.status = 'ENABLED'
        AND asset_group_asset.status != 'REMOVED'
        AND asset_group_asset.field_type IN
            ('MARKETING_IMAGE','SQUARE_MARKETING_IMAGE','PORTRAIT_MARKETING_IMAGE')`,
  );
  const mix = new Map();
  for (const x of imagens) {
    const g = x.assetGroupAsset.assetGroup;
    const m = mix.get(g) || { p: 0, q: 0, r: 0 };
    if (x.assetGroupAsset.fieldType === 'MARKETING_IMAGE') m.p++;
    else if (x.assetGroupAsset.fieldType === 'SQUARE_MARKETING_IMAGE') m.q++;
    else m.r++;
    mix.set(g, m);
  }

  const linhas = grupos.map((g) => {
    const chave = `${g.campaign.name}|${g.assetGroup.name}`;
    const m = mix.get(`customers/${CONTA}/assetGroups/${g.assetGroup.id}`) || { p: 0, q: 0, r: 0 };
    return {
      chave,
      campanha: g.campaign.name,
      grupo: g.assetGroup.name,
      forca: g.assetGroup.adStrength || '(sem nota)',
      trocado: TROCADOS.has(chave),
      m,
    };
  });

  const conta = (ls) => {
    const c = {};
    for (const l of ls) c[l.forca] = (c[l.forca] || 0) + 1;
    return c;
  };
  const trocados = linhas.filter((l) => l.trocado);
  const intactos = linhas.filter((l) => !l.trocado);

  console.log('══ FORÇA DO ANÚNCIO — trocados × intocados ══\n');
  console.log(`TROCADOS (${trocados.length})`);
  for (const l of trocados) {
    console.log(`  ${l.forca.padEnd(10)} ${l.m.p}p ${l.m.q}q ${l.m.r}r   ${l.campanha} / ${l.grupo}`);
  }
  console.log(`  → ${JSON.stringify(conta(trocados))}`);

  console.log(`\nINTOCADOS (${intactos.length})`);
  console.log(`  → ${JSON.stringify(conta(intactos))}`);
  const amostra = intactos.slice(0, 3);
  for (const l of amostra) {
    console.log(`  ex.: ${l.forca.padEnd(10)} ${l.m.p}p ${l.m.q}q ${l.m.r}r   ${l.campanha} / ${l.grupo}`);
  }

  /* ── 2) LINHA DE BASE — NÃO é conclusão ──────────────────────────────── */
  const dias = await consultar(
    a,
    `SELECT segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.conversions, metrics.ctr
       FROM campaign
      WHERE campaign.status IN ('ENABLED','PAUSED')
        AND segments.date DURING LAST_14_DAYS`,
  );
  const porDia = new Map();
  for (const x of dias) {
    const d = x.segments.date;
    const m = porDia.get(d) || { impr: 0, cliques: 0, custo: 0, conv: 0 };
    m.impr += Number(x.metrics?.impressions || 0);
    m.cliques += Number(x.metrics?.clicks || 0);
    m.custo += Number(x.metrics?.costMicros || 0);
    m.conv += Number(x.metrics?.conversions || 0);
    porDia.set(d, m);
  }

  console.log('\n\n══ LINHA DE BASE (14 dias) — referência, NÃO conclusão ══\n');
  console.log('data         impressões   cliques     CTR     custo        conversões');
  const ordenados = [...porDia.entries()].sort();
  for (const [d, m] of ordenados) {
    const marca = d === '2026-09-13' ? '  ← mudanças de hoje (dia incompleto)' : '';
    console.log(
      `${d}  ${String(m.impr).padStart(10)}  ${String(m.cliques).padStart(7)}  ` +
        `${pct(m.impr ? m.cliques / m.impr : 0).padStart(7)}  ${brl(m.custo).padStart(11)}  ` +
        `${m.conv.toFixed(1).padStart(8)}${marca}`,
    );
  }

  const anteriores = ordenados.slice(0, -1);
  if (anteriores.length) {
    const s = anteriores.reduce(
      (t, [, m]) => ({ impr: t.impr + m.impr, cliques: t.cliques + m.cliques, custo: t.custo + m.custo, conv: t.conv + m.conv }),
      { impr: 0, cliques: 0, custo: 0, conv: 0 },
    );
    const n = anteriores.length;
    console.log(
      `\nMÉDIA dos ${n} dias ANTES: ${Math.round(s.impr / n)} impr · ${Math.round(s.cliques / n)} cliques · ` +
        `CTR ${pct(s.impr ? s.cliques / s.impr : 0)} · ${brl(s.custo / n)} · ${(s.conv / n).toFixed(1)} conv`,
    );
  }

  console.log(
    `\n🚨 NÃO tire conclusão de desempenho daqui hoje. As mudanças têm HORAS, o dia\n` +
      `   corrente está incompleto, o Google consolida com atraso e a PMax reabre\n` +
      `   aprendizado depois de mudança grande. A comparação honesta é rodar isto de\n` +
      `   novo em ~7 dias e comparar semana contra semana.`,
  );
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
