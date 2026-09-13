/**
 * HORÁRIO DOS ANÚNCIOS × HORÁRIO DAS LOJAS — conta LOJAS FÍSICAS. Só leitura.
 *
 * ── A PERGUNTA ──
 *
 * As 14 lojas (de `ecommerce/src/data/lojas.json`, que é o que a cliente lê no
 * site) funcionam assim:
 *
 *   12 lojas ......... Seg-Sex 9h-18h · Sáb 9h-13h
 *   Itanhaém ......... Seg-Sáb 9h-19h
 *   Praia Grande ..... Seg-Sáb 10h-19h
 *   DOMINGO .......... NENHUMA abre
 *
 * Campanha do Google, por padrão, roda 24h por dia, 7 dias por semana. Se não
 * houver programação, parte dos ~R$ 800/dia está comprando clique de quem quer
 * ir numa loja fechada.
 *
 * ── MAS NÃO É ÓBVIO, E POR ISSO ISTO MEDE ANTES DE CORTAR ──
 *
 * 🚨 Cortar tudo fora do horário comercial é a conclusão apressada. Gente
 * pesquisa à noite e vai na loja no dia seguinte; domingo é o dia de planejar a
 * semana. O clique de domingo pode ser a visita de segunda. Quem corta por
 * intuição corta demanda, não desperdício.
 *
 * A pergunta certa não é "quanto se gasta fora do horário" — é **"o clique fora
 * do horário custa mais caro por ação do que o de dentro?"**. Se custar igual,
 * não há desperdício a cortar; se custar muito mais, há.
 *
 * ⚠️ A conversão desta conta está capenga desde 05/09 (a visita à loja modelada
 * parou e as ações locais não entram na coluna Conversões). Por isso aqui se usa
 * `all_conversions`, que inclui as ações locais vivas — rota, interações,
 * visitas ao site — e é o único sinal honesto que sobrou. Ver
 * `google-ads-lojas-metas.js`.
 *
 *   railway run --service flowops-lite node backend/scripts/diag-google-ads-lojas-horario.js
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
const CONTA = '9564998046';

/** Régua das lojas, tirada de lojas.json em 13/09/2026. */
const ABRE = 9;
const FECHA = 19; // o mais tarde da rede (Itanhaém e Praia Grande); 12 lojas fecham 18h
const DIAS_FECHADOS = new Set(['SUNDAY']);
const SABADO_FECHA = 13; // 12 das 14 fecham 13h no sábado

const brl = (m) => `R$ ${(Number(m || 0) / 1_000_000).toFixed(2).replace('.', ',')}`;
const num = (v) => Number(v || 0);

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
  console.log(`conta ${CONTA} · API ${V} · SÓ LEITURA`);
  console.log(`régua das lojas: ${ABRE}h-${FECHA}h seg-sex · sáb até ${SABADO_FECHA}h · domingo FECHADO\n`);
  const a = await token();

  /* 1) Já existe programação de horário? */
  const prog = await consultar(
    a,
    `SELECT campaign.id, campaign.name, campaign.status, campaign_criterion.ad_schedule.day_of_week,
            campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.end_hour,
            campaign_criterion.bid_modifier, campaign_criterion.negative
       FROM campaign_criterion
      WHERE campaign.status = 'ENABLED' AND campaign_criterion.type = 'AD_SCHEDULE'`,
  );
  const porCampanha = new Map();
  for (const x of prog) {
    const l = porCampanha.get(x.campaign.name) || [];
    l.push(x.campaignCriterion.adSchedule);
    porCampanha.set(x.campaign.name, l);
  }
  console.log('PROGRAMAÇÃO DE HORÁRIO EXISTENTE');
  if (!prog.length) {
    console.log('  🔴 NENHUMA campanha ativa tem programação — todas rodam 24h x 7 dias.\n');
  } else {
    for (const [nome, faixas] of porCampanha) {
      console.log(`  ${nome}: ${faixas.map((f) => `${f.dayOfWeek} ${f.startHour}-${f.endHour}`).join(' · ')}`);
    }
    console.log('');
  }

  /* 2) Desempenho por DIA DA SEMANA. */
  const dias = await consultar(
    a,
    `SELECT segments.day_of_week, metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.all_conversions
       FROM customer WHERE segments.date DURING LAST_30_DAYS`,
  );
  const porDia = new Map();
  for (const x of dias) {
    const d = x.segments.dayOfWeek;
    const m = porDia.get(d) || { impr: 0, cli: 0, custo: 0, conv: 0 };
    m.impr += num(x.metrics?.impressions);
    m.cli += num(x.metrics?.clicks);
    m.custo += num(x.metrics?.costMicros);
    m.conv += num(x.metrics?.allConversions);
    porDia.set(d, m);
  }
  const ordem = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
  const pt = { MONDAY: 'segunda', TUESDAY: 'terça', WEDNESDAY: 'quarta', THURSDAY: 'quinta', FRIDAY: 'sexta', SATURDAY: 'sábado', SUNDAY: 'DOMINGO' };

  console.log('POR DIA DA SEMANA (30 dias)');
  console.log('dia        cliques     custo        ações   custo/ação   loja');
  for (const d of ordem) {
    const m = porDia.get(d) || { impr: 0, cli: 0, custo: 0, conv: 0 };
    const cpa = m.conv ? m.custo / 1e6 / m.conv : 0;
    const estado = DIAS_FECHADOS.has(d) ? '🔴 FECHADA' : d === 'SATURDAY' ? `abre até ${SABADO_FECHA}h` : 'aberta';
    console.log(
      `${pt[d].padEnd(9)} ${String(m.cli).padStart(8)}  ${brl(m.custo).padStart(11)}  ${m.conv.toFixed(0).padStart(7)}  ` +
        `${(cpa ? `R$ ${cpa.toFixed(2)}` : '—').padStart(11)}   ${estado}`,
    );
  }

  /* 3) Desempenho por HORA. */
  const horas = await consultar(
    a,
    `SELECT segments.hour, metrics.clicks, metrics.cost_micros, metrics.all_conversions
       FROM customer WHERE segments.date DURING LAST_30_DAYS`,
  );
  const porHora = new Map();
  for (const x of horas) {
    const h = Number(x.segments.hour);
    const m = porHora.get(h) || { cli: 0, custo: 0, conv: 0 };
    m.cli += num(x.metrics?.clicks);
    m.custo += num(x.metrics?.costMicros);
    m.conv += num(x.metrics?.allConversions);
    porHora.set(h, m);
  }

  console.log('\nPOR HORA (30 dias)');
  console.log('hora   cliques     custo        ações   custo/ação   loja');
  let dentro = { custo: 0, conv: 0 };
  let fora = { custo: 0, conv: 0 };
  for (let h = 0; h < 24; h++) {
    const m = porHora.get(h) || { cli: 0, custo: 0, conv: 0 };
    const aberta = h >= ABRE && h < FECHA;
    (aberta ? dentro : fora).custo += m.custo;
    (aberta ? dentro : fora).conv += m.conv;
    const cpa = m.conv ? m.custo / 1e6 / m.conv : 0;
    console.log(
      `${String(h).padStart(2, '0')}h  ${String(m.cli).padStart(8)}  ${brl(m.custo).padStart(11)}  ` +
        `${m.conv.toFixed(0).padStart(7)}  ${(cpa ? `R$ ${cpa.toFixed(2)}` : '—').padStart(11)}   ${aberta ? 'aberta' : '🔴 fechada'}`,
    );
  }

  /* ── O VEREDITO ─────────────────────────────────────────────────────── */
  const cpaDentro = dentro.conv ? dentro.custo / 1e6 / dentro.conv : 0;
  const cpaFora = fora.conv ? fora.custo / 1e6 / fora.conv : 0;
  const total = dentro.custo + fora.custo;

  console.log('\n── VEREDITO ──');
  console.log(`dentro do horário (${ABRE}h-${FECHA}h): ${brl(dentro.custo)} · ${dentro.conv.toFixed(0)} ações · R$ ${cpaDentro.toFixed(2)}/ação`);
  console.log(`fora do horário:                ${brl(fora.custo)} · ${fora.conv.toFixed(0)} ações · R$ ${cpaFora.toFixed(2)}/ação`);
  console.log(`fora do horário é ${total ? ((fora.custo / total) * 100).toFixed(1) : 0}% do gasto`);

  if (cpaDentro && cpaFora) {
    const razao = cpaFora / cpaDentro;
    console.log(`\ncusto por ação FORA é ${razao.toFixed(2)}× o de DENTRO`);
    if (razao < 1.15) {
      console.log('→ NÃO CORTE. O clique fora do horário rende praticamente igual: quem pesquisa à');
      console.log('  noite vai na loja no dia seguinte. Cortar aqui tira demanda, não desperdício.');
    } else if (razao < 1.6) {
      console.log('→ Diferença moderada. Em vez de cortar, vale REDUZIR lance nas horas piores —');
      console.log('  corte seco perde a pesquisa da véspera.');
    } else {
      console.log('→ Diferença grande: aí sim há desperdício real a cortar nas horas piores.');
    }
  }

  const dom = porDia.get('SUNDAY');
  if (dom) {
    const cpaDom = dom.conv ? dom.custo / 1e6 / dom.conv : 0;
    console.log(
      `\nDOMINGO (nenhuma loja abre): ${brl(dom.custo)} em 30d · ${dom.conv.toFixed(0)} ações · ` +
        `${cpaDom ? `R$ ${cpaDom.toFixed(2)}/ação` : 'sem ação'}`,
    );
    console.log('  ⚠️ Domingo é o dia de planejar a semana. Só corte se o custo por ação for MUITO');
    console.log('     pior que o da média — senão você está cortando a visita de segunda-feira.');
  }
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
