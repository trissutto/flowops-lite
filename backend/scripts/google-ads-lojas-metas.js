/**
 * LIMPA AS METAS DE CONVERSÃO da conta LOJAS FÍSICAS (956-499-8046).
 *
 * ── O QUE ESTÁ ERRADO (medido no painel em 13/09/2026) ──
 *
 * TUDO que está marcado como meta PRINCIPAL nesta conta está morto, e o que
 * está vivo não conta. O lance automático roda no escuro gastando ~R$ 800/dia:
 *
 *   PRINCIPAIS, todas sem registrar:
 *     Compra [OK] ............. "Configuração incorreta"
 *                               último ping da tag: 19/08/2026 16:13
 *     [GA4] purchase .......... "Conversões pendentes"
 *     Store visits ............ última conversão 05/09/2026 09:00
 *     Business profile Form / Form submit / Tracked call / Calls ... pendentes
 *
 *   VIVAS, mas com include_in_conversions_metric = FALSE (não contam, não dão lance):
 *     Local actions - Directions ......... ~150/dia
 *     Local actions - Other engagements .. ~200/dia
 *     Local actions - Website visits ..... ~20/dia
 *
 * ── POR QUE `Compra [OK]` NÃO TEM CONSERTO AQUI ──
 *
 * Ela morreu em 19/08 09:00, na virada de domínio: a tag vinha do WordPress
 * velho, que morreu quando o site novo assumiu `lurds.com.br`. E o site novo
 * **nunca vai** dispará-la pelo navegador — `purchase` está em
 * `SERVER_ONLY_EVENTS` de propósito (antifraude + PIX pago horas depois).
 * Na conta de E-COMMERCE isso já foi resolvido em 23/08 com upload server-side
 * (`Compra Flow (upload)`). O que sobrou foi o resto AQUI, onde ninguém mexeu.
 *
 * 🚨 Então o selo vermelho dela NÃO some com configuração — ele descreve um fato
 * verdadeiro. O que se conserta é o que importa: **ela deixa de mandar no lance**.
 * E, pela diretriz do dono ("nas contas locais não devemos ter objetivo de
 * vendas"), venda de site não deveria ser meta desta conta de jeito nenhum.
 *
 * ── O QUE ESTE SCRIPT FAZ ──
 *
 *   1. TIRA de principal e da coluna Conversões toda ação de VENDA DE SITE
 *      (PURCHASE, ADD_TO_CART, BEGIN_CHECKOUT) — elas não pertencem aqui.
 *   2. PROMOVE `Local actions - Directions` a principal e contada. É o melhor
 *      sinal que a gente realmente MEDE de alguém indo à loja: a pessoa pediu a
 *      rota. Substitui a visita modelada, que o Google parou de publicar.
 *   3. NÃO mexe em `Store visits`. Ela está correta; quem parou foi o Google.
 *      Se voltar, volta contando.
 *
 * ⚠️ Só UMA entra como principal nova. Promover `Directions` E
 * `Other engagements` juntas contaria a mesma intenção duas vezes e inflaria o
 * volume de conversão — foi esse tipo de dobra que já mordeu na conta de
 * e-commerce (duas principais contando a mesma venda).
 *
 * ── COMO RODAR (PowerShell) ──
 *   railway run --service flowops-lite node backend/scripts/google-ads-lojas-metas.js
 *   $env:VALIDAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-metas.js
 *   $env:VALIDAR=""; $env:APLICAR="1"; railway run --service flowops-lite node backend/scripts/google-ads-lojas-metas.js
 *
 * ⚠️ A cota do developer token é de nível **Explorer** (~2.880 operações/dia,
 * janela deslizante, COMPARTILHADA entre leitura e escrita) — não Basic, como
 * um comentário antigo meu dizia. Ela estourou em 13/09 e bloqueou até leitura.
 * Se vier 429, é esperar: o próprio erro diz quantos segundos.
 */
const V = (process.env.GOOGLE_ADS_API_VERSION || 'v25').trim();
/** CHUMBADA: o script irmão de e-commerce lê GOOGLE_ADS_CONTAS[0], que é OUTRA conta. */
const CONTA = '9564998046';
const VALIDAR = process.env.VALIDAR === '1';
const APLICAR = process.env.APLICAR === '1';

/** Categorias de venda de site — não pertencem a uma conta de loja física. */
const VENDA_DE_SITE = new Set(['PURCHASE', 'ADD_TO_CART', 'BEGIN_CHECKOUT']);
/** A única que sobe a principal. Casada pelo NOME porque o id muda por conta. */
const NOVA_PRINCIPAL = 'Local actions - Directions';

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
    /* ⚠️ searchStream devolve o erro dentro de um ARRAY; o mutate devolve objeto.
     * Ler só `j.error` fazia a mensagem de cota voltar como JSON cru de 40 linhas. */
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

async function mutate(a, operations) {
  const r = await fetch(`https://googleads.googleapis.com/${V}/customers/${CONTA}/conversionActions:mutate`, {
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

  const acoes = (
    await consultar(
      a,
      `SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name,
              conversion_action.type, conversion_action.category, conversion_action.status,
              conversion_action.origin, conversion_action.primary_for_goal,
              conversion_action.include_in_conversions_metric, conversion_action.owner_customer
         FROM conversion_action
        WHERE conversion_action.status = 'ENABLED'`,
    )
  ).map((x) => x.conversionAction);

  /* Quem REGISTROU alguma coisa em 30 dias — é o que separa meta viva de meta
   * decorativa. Consulta separada: a com segments.date omite quem não teve
   * movimento, e é justamente o morto que eu quero achar. */
  const conta30 = new Map();
  for (const x of await consultar(
    a,
    `SELECT segments.conversion_action, metrics.all_conversions
       FROM customer WHERE segments.date DURING LAST_30_DAYS`,
  )) {
    const id = String(x.segments.conversionAction || '').split('/').pop();
    conta30.set(id, (conta30.get(id) || 0) + Number(x.metrics?.allConversions || 0));
  }

  const linha = (c) =>
    `${c.primaryForGoal ? '★' : ' '}${c.includeInConversionsMetric ? '✓' : ' '} ` +
    `${String(c.id).padEnd(11)} ${String(c.category).padEnd(16)} ` +
    `30d=${(conta30.get(String(c.id)) || 0).toFixed(0).padStart(6)}  ${c.name}`;

  console.log('ANTES  (★ principal · ✓ conta na coluna Conversões)');
  for (const c of acoes.slice().sort((x, y) => Number(y.primaryForGoal) - Number(x.primaryForGoal))) {
    console.log('  ' + linha(c));
  }

  /* ── O PLANO ─────────────────────────────────────────────────────────── */
  const ops = [];
  const mudancas = [];

  for (const c of acoes) {
    /* 1) Venda de site sai de meta desta conta. */
    if (VENDA_DE_SITE.has(c.category) && (c.primaryForGoal || c.includeInConversionsMetric)) {
      const dona = String(c.ownerCustomer || '').split('/').pop();
      if (dona && dona !== CONTA) {
        /* Ação compartilhada do MCC: mexer aqui mexeria na conta de e-commerce,
         * onde ela é legítima. Aviso e NÃO toco. */
        mudancas.push({ nome: c.name, o_que: `⚠️ PULADA — é da conta ${dona}, mexer daqui afetaria o e-commerce` });
        continue;
      }
      ops.push({
        update: {
          resourceName: c.resourceName,
          primaryForGoal: false,
          includeInConversionsMetric: false,
        },
        updateMask: 'primary_for_goal,include_in_conversions_metric',
      });
      mudancas.push({ nome: c.name, o_que: 'sai de principal e da coluna Conversões (venda de site não é meta de loja)' });
    }
  }

  /* 2) A nova principal: o sinal que a gente realmente mede. */
  const rota = acoes.find((c) => c.name === NOVA_PRINCIPAL);
  if (!rota) {
    console.log(`\n⚠️ não achei a ação "${NOVA_PRINCIPAL}" — confira o nome antes de aplicar`);
  } else if (rota.primaryForGoal && rota.includeInConversionsMetric) {
    mudancas.push({ nome: rota.name, o_que: '(já está principal e contando)' });
  } else {
    ops.push({
      update: { resourceName: rota.resourceName, primaryForGoal: true, includeInConversionsMetric: true },
      updateMask: 'primary_for_goal,include_in_conversions_metric',
    });
    mudancas.push({
      nome: rota.name,
      o_que: `vira PRINCIPAL e passa a contar (${(conta30.get(String(rota.id)) || 0).toFixed(0)} em 30d — sinal vivo)`,
    });
  }

  console.log('\nO QUE MUDA');
  for (const m of mudancas) console.log(`  · ${m.nome}\n      ${m.o_que}`);
  console.log(`\n${ops.length} operações`);

  console.log(
    `\nNÃO MEXE em "Store visits": a configuração dela está correta (ENABLED, principal,` +
      `\n  janela 30d, valor R$ 249). Quem parou de publicar foi o Google, em 05/09 09:00.` +
      `\n  Se o modelo voltar, ela volta contando sozinha.`,
  );

  if (!APLICAR && !VALIDAR) {
    console.log('\n🟢 DRY-RUN — nada enviado. Para validar: $env:VALIDAR="1"');
    return;
  }
  if (!ops.length) return console.log('\nnada a fazer');

  const r = await mutate(a, ops);
  console.log(
    VALIDAR
      ? `\n🟡 validateOnly — o Google aceitou as ${ops.length} operações. Nada alterado.`
      : `\n🔴 APLICADO — ${(r.results || []).length} ações atualizadas.`,
  );
  if (APLICAR && !VALIDAR) {
    console.log('\nRode de novo em DRY-RUN pra ver o ANTES/DEPOIS provado pela própria API.');
  }
}

main().catch((e) => {
  console.error('\n❌', e.message);
  process.exit(1);
});
