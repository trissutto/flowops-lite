/**
 * ORÇAMENTO E STATUS DAS CAMPANHAS DE LOJA — conta LOJAS FÍSICAS (956-499-8046).
 *
 * ── POR QUE ESTE ARQUIVO EXISTE (13/09/2026) ──
 *
 * A interface do Google Ads recusou 26 tentativas de editar orçamento neste
 * navegador: o painel de edição não abre, a seleção múltipla marca a linha
 * errada (pediu Indaiatuba, marcou Suzano) e o campo de busca não recebe
 * texto. A única coisa que respondeu o dia inteiro foi o ponto de status.
 * Mexer em 29 campanhas de uma conta viva por esse caminho é como se muda o
 * orçamento errado sem perceber.
 *
 * Pela API é determinístico: diz o que vai fazer, faz, e prova o que fez.
 * A escrita já está PROVADA nesta conta — em 24/08/2026 o orçamento da
 * ITANHAÉM PMax subiu de R$ 10 para R$ 20/dia por aqui
 * (`campaignBudgets/14487777834`). O token é Basic (~15 mil operações/dia).
 *
 * ── COMO RODAR (PowerShell; a pasta do repo já está linkada ao Railway) ──
 *
 *   # 1) VER o que mudaria — não escreve nada
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-orcamento.js
 *
 *   # 2) validar no servidor do Google sem aplicar (validateOnly)
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-orcamento.js
 *
 *   # 3) APLICAR de verdade
 *   $env:VALIDAR=""; $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-orcamento.js
 *
 * ⚠️ `APLICAR=1 railway ...` é sintaxe de BASH; o PowerShell recusa e a env
 * NÃO chega — por isso o default aqui é NÃO APLICAR. O script antigo
 * (`google-ads-correcoes.js`) tem o default invertido: lá, env que não chega
 * significa aplicar. Aqui, env que não chega significa só olhar.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * O QUE MUDAR — a tabela é a decisão do dono, escrita à mão, conferida na tela
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Orçamento diário novo, em REAIS — REPARTIDO PELA RECEITA REAL DA LOJA (14/09).
 *
 * Gerado por `google-ads-lojas-orcamento-por-receita.js` com `TOTAL=542.25`, que
 * é a soma real do orçamento das 14 PMax. **Não é palpite:** cada valor é a
 * fatia daquela praça na receita da rede nos últimos 30 dias, e o total não
 * muda — só é redistribuído.
 *
 * 🚨 A régua é a RECEITA DO PDV, não a "visita à loja" do Google. Essa métrica
 * mente nesta rede (Anália Franco era a pior loja e ele a ranqueava em 2º) e
 * desde 05/09 ela nem publica mais.
 *
 * Itanhaém entra com METADE da receita, por ordem do dono: vende infantil,
 * masculino e tamanho menor, que o anúncio plus size não traz.
 *
 * ⚠️ QUATRO AUMENTOS PASSAM DE 100% — Limeira 20→55 (+175%), Praia Grande
 * 20→35, Jundiaí 20→30, Indaiatuba 20→30. Mudança grande de orçamento REABRE o
 * aprendizado da PMax: a campanha volta a explorar e o custo por ação sobe por
 * alguns dias antes de assentar. É o preço de corrigir uma alocação que estava
 * torta — Limeira vendia R$ 89 mil com o orçamento mínimo da conta. Se preferir
 * suavizar, o caminho é aplicar metade agora e o resto em duas semanas.
 */
const ORCAMENTO_NOVO = {
  'ANÁLIA FRANCO PMax 01.06.26 [Petter]': 20.0,
  'CAMPINAS PMax 27.08.25 [Petter]': 55.0,
  'INDAIATUBA PMax 27.08.25 [Petter]': 30.0,
  'ITANHAÉM PMax 27.08.25 [Petter]': 45.0,
  'JUNDIAÍ PMax 27.08.25 [Petter]': 30.0,
  'LIMEIRA PMax 27.08.25 [Petter]': 55.0,
  'MOEMA PMax 27.08.25 [Petter]': 40.0,
  'PIRACICABA PMax 27.08.25 [Petter]': 30.0,
  'PRAIA GRANDE PMax 27.08.25 [Petter]': 35.0,
  'SANTOS PMax 27.08.25 [Petter]': 35.0,
  'SÃO JOSÉ DOS CAMPOS PMax 27.08.25 [Petter]': 35.0,
  'SOROCABA PMax 27.08.25 [Petter]': 70.0,
  'SUZANO PMax 27.08.25 [Petter]': 30.0,
  'VINHEDO PMax 27.08.25 [Petter]': 25.0,
};

/**
 * Campanhas a PAUSAR.
 *
 * ⚠️ As 3 de Pesquisa que estavam aqui antes (ITANHAEM, VINHEDO, INDAIATUBA) já
 * foram pausadas em 13/09 e SAÍRAM da lista: `acharUma` só procura entre as
 * ENABLED e ABORTA o script inteiro se não achar o nome. Lista velha = script
 * que não roda mais.
 *
 * As duas que ficam são as únicas campanhas ativas SEM conjunto de ativos de
 * local. Sem local vinculado elas não podem, por construção, gerar visita nem
 * pedido de rota — que é o objetivo desta conta. A de vídeo ainda está com
 * orçamento R$ 0,00: existe sem fazer nada.
 *
 * 🚨 PAUSA, não remoção. O dono disse "pode excluir", mas campanha REMOVED no
 * Google Ads não volta, e pausar tem o mesmo efeito prático — para de gastar,
 * para de aparecer — sem queimar o histórico.
 */
const PAUSAR = [
  'MOEMA Vídeo visualizações – 2025-11-12',
  '[Petter][Search][Piracicaba Pesquisa] Base',
];

/* ──────────────────────────────────────────────────────────────────────────── */

const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
/**
 * CONTA CHUMBADA, de propósito. O script irmão lê
 * `GOOGLE_ADS_CONTAS.split(',')[0]`, que é a conta de E-COMMERCE — copiar
 * aquela linha aqui aplicaria orçamento de loja física na conta errada.
 */
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

/** R$ 45,00 → '45000000'. Em BRL o valor tem que ser múltiplo de 10.000 micros. */
function reaisParaMicros(reais) {
  return String(Math.round(Number(reais) * 100) * 10_000);
}
const microsParaReais = (m) => Number(m || 0) / 1_000_000;
const brl = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

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
  if (!j.access_token) throw new Error(`OAuth falhou: ${JSON.stringify(j).slice(0, 300)}`);
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

/** O corpo de erro do Ads é um bolo; isto tira a frase que interessa. */
function erroLegivel(t) {
  try {
    const j = JSON.parse(t);
    return (
      (j.error?.details?.[0]?.errors || [])
        .map((e) => `${JSON.stringify(e.errorCode)}: ${e.message}${e.trigger ? ` (${JSON.stringify(e.trigger)})` : ''}`)
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
  // searchStream devolve ARRAY de lotes, não um objeto.
  return (Array.isArray(j) ? j : [j]).flatMap((x) => x.results || []);
}

async function mutate(a, recurso, operations) {
  const r = await fetch(
    `https://googleads.googleapis.com/${V}/customers/${CONTA}/${recurso}:mutate`,
    {
      method: 'POST',
      headers: headers(a),
      body: JSON.stringify({ operations, validateOnly: VALIDAR || !APLICAR }),
    },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${String(erroLegivel(t)).slice(0, 2000)}`);
  return JSON.parse(t);
}

async function main() {
  const modo = APLICAR && !VALIDAR ? '🔴 APLICANDO DE VERDADE' : VALIDAR ? '🟡 validateOnly no Google' : '🟢 DRY-RUN (nada será escrito)';
  console.log(`conta ${CONTA} · API ${V} · ${modo}\n`);

  const a = await token();

  const linhas = await consultar(
    a,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            campaign_budget.id, campaign_budget.resource_name, campaign_budget.amount_micros,
            campaign_budget.explicitly_shared
       FROM campaign
      WHERE campaign.status = 'ENABLED'`,
  );

  const campanhas = linhas.map((l) => ({
    id: l.campaign.id,
    nome: l.campaign.name,
    tipo: l.campaign.advertisingChannelType,
    budgetRes: l.campaignBudget.resourceName,
    budgetId: l.campaignBudget.id,
    atual: microsParaReais(l.campaignBudget.amountMicros),
    compartilhado: !!l.campaignBudget.explicitlyShared,
  }));

  const totalAntes = campanhas.reduce((s, c) => s + c.atual, 0);
  console.log(`${campanhas.length} campanhas ativas · orçamento total ${brl(totalAntes)}/dia\n`);

  /** Acha UMA campanha pelo nome; aborta se não achar ou se achar duas. */
  const acharUma = (nome) => {
    const achadas = campanhas.filter((c) => norm(c.nome) === norm(nome));
    if (achadas.length === 0) throw new Error(`campanha não encontrada: "${nome}"`);
    if (achadas.length > 1) throw new Error(`nome ambíguo (${achadas.length} campanhas): "${nome}"`);
    return achadas[0];
  };

  /* ── 1) ORÇAMENTOS ──────────────────────────────────────────────────────── */
  const opsOrc = [];
  let totalDepois = totalAntes;

  console.log('ORÇAMENTO');
  for (const [nome, novo] of Object.entries(ORCAMENTO_NOVO)) {
    const c = acharUma(nome);
    if (c.compartilhado) {
      throw new Error(
        `"${c.nome}" usa orçamento COMPARTILHADO (${c.budgetRes}); mudar aqui mexeria em outras campanhas. Abortado.`,
      );
    }
    const delta = novo - c.atual;
    totalDepois += delta;
    console.log(
      `  ${c.nome}\n    ${brl(c.atual)} → ${brl(novo)}  (${delta >= 0 ? '+' : ''}${brl(delta)}/dia)`,
    );
    opsOrc.push({
      update: { resourceName: c.budgetRes, amountMicros: reaisParaMicros(novo) },
      updateMask: 'amount_micros',
    });
  }

  /* ── 2) PAUSAS ──────────────────────────────────────────────────────────── */
  const opsStatus = [];
  console.log('\nPAUSAR');
  for (const nome of PAUSAR) {
    const c = acharUma(nome);
    totalDepois -= c.atual;
    console.log(`  ${c.nome}  (libera ${brl(c.atual)}/dia)`);
    opsStatus.push({
      update: { resourceName: `customers/${CONTA}/campaigns/${c.id}`, status: 'PAUSED' },
      updateMask: 'status',
    });
  }

  console.log(
    `\nTOTAL DA CONTA: ${brl(totalAntes)} → ${brl(totalDepois)}/dia  (${totalDepois >= totalAntes ? '+' : ''}${brl(totalDepois - totalAntes)})`,
  );

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada foi enviado. Para aplicar: $env:APLICAR="1"');
    return;
  }

  const rOrc = await mutate(a, 'campaignBudgets', opsOrc);
  console.log(`\n✔ orçamentos: ${(rOrc.results || []).length} operações`);
  const rSt = await mutate(a, 'campaigns', opsStatus);
  console.log(`✔ status: ${(rSt.results || []).length} operações`);
  console.log(VALIDAR ? '\n🟡 validateOnly — o Google aceitou, mas NADA foi alterado.' : '\n🔴 APLICADO.');
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
