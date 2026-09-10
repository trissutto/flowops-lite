/**
 * ESTAMOS SENDO ATACADOS? — a resposta em número, não em susto.
 *
 * NASCEU DE UM ALERTA DE 10/09/2026: chegou e-mail da Cloudflare e não havia
 * onde conferir. Abrir o painel resolve UMA vez; o problema é que o painel não
 * responde a pergunta que importa ("isto é anormal?") — ele mostra um número
 * solto. Sem base de comparação, 13 mil requisições assustam tanto quanto 13
 * milhões.
 *
 * Este script compara a JANELA DE AGORA com a JANELA ANTERIOR do mesmo
 * tamanho, na mesma zona. É isso que transforma "67 mil requisições" em
 * "normal" ou "3× o de ontem, olha aqui de onde vem".
 *
 * ── O QUE ELE OLHA ──
 *
 *   1. Volume total e quanto disso a Cloudflare marcou como AMEAÇA
 *      (`threats` do dataset horário — o mesmo número do painel).
 *   2. Eventos de segurança por AÇÃO (block, challenge, skip, log...).
 *   3. De onde vem: top IPs, ASNs, países e caminhos atacados.
 *   4. O pico: a hora mais cheia da janela contra a média das outras.
 *
 * ── REGRA DE OURO (a mesma do resto da casa) ──
 *
 * Dataset que o plano não deixa ler vira ERRO NA TELA, nunca zero silencioso.
 * "Zero ameaças" e "não consegui perguntar" são coisas diferentes, e confundir
 * as duas é exatamente como se dorme durante um ataque de verdade.
 *
 * ── COMO USAR ──
 *
 *   1. Crie um token SÓ DE LEITURA em
 *      https://dash.cloudflare.com/profile/api-tokens → "Create Token" →
 *      "Create Custom Token", com estas 3 permissões:
 *         Account · Account Analytics · Read
 *         Zone    · Analytics         · Read
 *         Zone    · Zone              · Read
 *      Escopo: todas as zonas da conta. NÃO dê permissão de escrita —
 *      este script só lê, e token de leitura vazado não derruba o site.
 *
 *   2. Rode:
 *         CLOUDFLARE_API_TOKEN=xxx node backend/scripts/cloudflare-ataque.js
 *
 *      Windows / PowerShell:
 *         $env:CLOUDFLARE_API_TOKEN='xxx'; node backend/scripts/cloudflare-ataque.js
 *
 * ── OPÇÕES ──
 *
 *   --horas N     Tamanho da janela (padrão 24). Mínimo 1.
 *   --zona NOME   Só esta zona (padrão: todas as zonas da conta).
 *   --json        Saída em JSON, pra cron/alerta em vez de leitura humana.
 *
 * ── CÓDIGO DE SAÍDA ──
 *
 *   0 = nada anormal   1 = suspeita (veja o motivo impresso)   2 = falhou ao perguntar
 *
 * O código 1 é de propósito: quem quiser transformar isto em vigia automático
 * (cron do Railway, Monitor, task agendada) tem o sinal pronto, sem parsear
 * texto.
 */

const TOKEN = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
const API = 'https://api.cloudflare.com/client/v4';

const args = process.argv.slice(2);
const flag = (nome, padrao = null) => {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] ? args[i + 1] : padrao;
};
const HORAS = Math.max(1, Number(flag('--horas', '24')) || 24);
const ZONA_FILTRO = flag('--zona');
const JSON_OUT = args.includes('--json');

// ── Os limiares que definem "suspeita" ────────────────────────────────────
// Não são lei da física: são o ponto onde vale a pena OLHAR. Errar pra mais
// (alarme falso) mata a confiança no aviso — foi a lição da fila de tarefas
// da loja. Por isso são folgados de propósito.
const LIMIAR = {
  /** Tráfego da janela dividido pela anterior. 3× é "aconteceu alguma coisa". */
  crescimento: 3,
  /** % de ameaças sobre o total. Acima disso, alguém está batendo na porta. */
  ameacaPct: 5,
  /** Piso pra não gritar com número pequeno: 2 mil requisições na janela. */
  volumeMinimo: 2000,
};

function iso(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function rest(caminho) {
  const r = await fetch(`${API}${caminho}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.success) {
    const msg = body?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${r.status}`;
    throw new Error(`REST ${caminho}: ${msg}`);
  }
  return body.result;
}

async function graphql(query, variables) {
  const r = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`GraphQL HTTP ${r.status}`);
  // GraphQL da Cloudflare devolve 200 COM erros no corpo. Deixar passar aqui
  // seria o "fonte morta com cara de não-existe" de novo.
  if (body?.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  return body.data;
}

const Q_TRAFEGO = `
query($zona: String!, $desde: Time!, $ate: Time!) {
  viewer { zones(filter: { zoneTag: $zona }) {
    porHora: httpRequests1hGroups(
      limit: 720
      filter: { datetime_geq: $desde, datetime_lt: $ate }
      orderBy: [datetime_ASC]
    ) { dimensions { datetime } sum { requests cachedRequests threats bytes } }
  } }
}`;

const Q_SEGURANCA = `
query($zona: String!, $desde: Time!, $ate: Time!) {
  viewer { zones(filter: { zoneTag: $zona }) {
    porAcao: firewallEventsAdaptiveGroups(
      limit: 20 filter: { datetime_geq: $desde, datetime_lt: $ate } orderBy: [count_DESC]
    ) { count dimensions { action } }
    topIps: firewallEventsAdaptiveGroups(
      limit: 10 filter: { datetime_geq: $desde, datetime_lt: $ate } orderBy: [count_DESC]
    ) { count dimensions { clientIP clientAsn clientCountryName } }
    topAlvos: firewallEventsAdaptiveGroups(
      limit: 10 filter: { datetime_geq: $desde, datetime_lt: $ate } orderBy: [count_DESC]
    ) { count dimensions { clientRequestHTTPHost clientRequestPath } }
  } }
}`;

async function trafego(zonaId, desde, ate) {
  const d = await graphql(Q_TRAFEGO, { zona: zonaId, desde: iso(desde), ate: iso(ate) });
  const linhas = d?.viewer?.zones?.[0]?.porHora || [];
  const total = { requests: 0, cachedRequests: 0, threats: 0, bytes: 0 };
  for (const l of linhas) {
    total.requests += l.sum.requests;
    total.cachedRequests += l.sum.cachedRequests;
    total.threats += l.sum.threats;
    total.bytes += l.sum.bytes;
  }
  return { total, porHora: linhas.map((l) => ({ hora: l.dimensions.datetime, ...l.sum })) };
}

/** O pico só interessa comparado com o resto da janela — 1 hora cheia num dia calmo é live, não ataque. */
function pico(porHora) {
  if (porHora.length < 2) return null;
  const maior = porHora.reduce((a, b) => (b.requests > a.requests ? b : a));
  const resto = porHora.filter((h) => h.hora !== maior.hora);
  const media = resto.reduce((s, h) => s + h.requests, 0) / Math.max(1, resto.length);
  return { hora: maior.hora, requests: maior.requests, mediaDemais: Math.round(media), vezes: media > 0 ? maior.requests / media : null };
}

function num(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}

async function analisarZona(zona, agora) {
  const fimAgora = agora;
  const iniAgora = new Date(agora.getTime() - HORAS * 3600_000);
  const iniAntes = new Date(iniAgora.getTime() - HORAS * 3600_000);

  const out = { zona: zona.name, plano: zona.plan?.name || '?', horas: HORAS, erros: [] };

  try {
    const [agoraT, antesT] = await Promise.all([
      trafego(zona.id, iniAgora, fimAgora),
      trafego(zona.id, iniAntes, iniAgora),
    ]);
    out.agora = agoraT.total;
    out.anterior = antesT.total;
    out.pico = pico(agoraT.porHora);
    out.crescimento = antesT.total.requests > 0 ? agoraT.total.requests / antesT.total.requests : null;
    out.ameacaPct = agoraT.total.requests > 0 ? (agoraT.total.threats / agoraT.total.requests) * 100 : 0;
  } catch (e) {
    // Não engole: sem tráfego não há veredito, e dizer "normal" aqui seria mentir.
    out.erros.push(`tráfego: ${e.message}`);
  }

  try {
    const d = await graphql(Q_SEGURANCA, { zona: zona.id, desde: iso(iniAgora), ate: iso(fimAgora) });
    const z = d?.viewer?.zones?.[0] || {};
    out.porAcao = (z.porAcao || []).map((r) => ({ acao: r.dimensions.action, n: r.count }));
    out.topIps = (z.topIps || []).map((r) => ({ ip: r.dimensions.clientIP, asn: r.dimensions.clientAsn, pais: r.dimensions.clientCountryName, n: r.count }));
    out.topAlvos = (z.topAlvos || []).map((r) => ({ host: r.dimensions.clientRequestHTTPHost, caminho: r.dimensions.clientRequestPath, n: r.count }));
  } catch (e) {
    // MEDIDO EM 10/09/2026: zona no plano Free responde
    // "zone ... does not have access to the path" — o dataset de eventos de
    // firewall é Pro+. Não é falha do script nem ausência de ataque: é a
    // pergunta que aquele plano não deixa fazer. Dizer isso com todas as
    // letras evita a leitura errada de "0 eventos = tudo limpo".
    const semPlano = /does not have access to the path/i.test(e.message);
    out.erros.push(
      semPlano
        ? `eventos de segurança: indisponíveis no plano ${out.plano} (dataset é Pro+). Volume e ameaças acima seguem válidos.`
        : `eventos de segurança: ${e.message}`,
    );
    out.semEventosPorPlano = semPlano;
  }

  // ── Veredito ──
  const motivos = [];
  if (out.agora) {
    const volumeConta = out.agora.requests >= LIMIAR.volumeMinimo;
    if (volumeConta && out.crescimento && out.crescimento >= LIMIAR.crescimento) {
      motivos.push(`tráfego ${out.crescimento.toFixed(1)}× a janela anterior`);
    }
    if (volumeConta && out.ameacaPct >= LIMIAR.ameacaPct) {
      motivos.push(`${out.ameacaPct.toFixed(1)}% do tráfego marcado como ameaça`);
    }
    if (out.pico && out.pico.vezes && out.pico.vezes >= 10 && out.agora.requests >= LIMIAR.volumeMinimo) {
      motivos.push(`pico de ${num(out.pico.requests)} req numa hora (${out.pico.vezes.toFixed(0)}× a média da janela)`);
    }
  }
  const bloqueios = (out.porAcao || []).filter((a) => ['block', 'managed_challenge', 'challenge', 'js_challenge'].includes(a.acao)).reduce((s, a) => s + a.n, 0);
  if (bloqueios >= 1000) motivos.push(`${num(bloqueios)} bloqueios/desafios na janela`);

  out.bloqueios = bloqueios;
  out.motivos = motivos;
  out.veredito = out.erros.length && !out.agora ? 'NAO_SEI' : motivos.length ? 'SUSPEITO' : 'NORMAL';
  return out;
}

function imprimir(r) {
  const marca = { NORMAL: '✅ NORMAL', SUSPEITO: '🚨 SUSPEITO', NAO_SEI: '⚠️  NÃO CONSEGUI PERGUNTAR' }[r.veredito];
  console.log(`\n── ${r.zona}  (plano ${r.plano}, últimas ${r.horas}h) ${'─'.repeat(Math.max(0, 46 - r.zona.length))}`);
  console.log(`   ${marca}`);
  if (r.agora) {
    const pctCache = r.agora.requests ? ((r.agora.cachedRequests / r.agora.requests) * 100).toFixed(1) : '0';
    console.log(`   requisições : ${num(r.agora.requests)}   (janela anterior: ${num(r.anterior.requests)}${r.crescimento ? ` · ${r.crescimento.toFixed(2)}×` : ''})`);
    console.log(`   ameaças     : ${num(r.agora.threats)}   (${r.ameacaPct.toFixed(2)}% do total)`);
    console.log(`   cache       : ${pctCache}%   ·   tráfego: ${(r.agora.bytes / 1e9).toFixed(2)} GB`);
    if (r.pico) console.log(`   hora de pico: ${r.pico.hora} — ${num(r.pico.requests)} req (média das demais: ${num(r.pico.mediaDemais)})`);
  }
  if (r.porAcao?.length) {
    console.log(`   eventos por ação: ${r.porAcao.map((a) => `${a.acao}=${num(a.n)}`).join('  ')}`);
  } else if (!r.erros.length) {
    console.log('   eventos por ação: nenhum evento de segurança na janela');
  }
  if (r.semEventosPorPlano) console.log('   (visão parcial: sem os eventos de firewall, o veredito olhou só volume e ameaças)');
  if (r.veredito === 'SUSPEITO') {
    console.log(`   MOTIVO: ${r.motivos.join(' · ')}`);
    if (r.topIps?.length) {
      console.log('   de onde vem:');
      for (const i of r.topIps) console.log(`     ${String(i.n).padStart(7)}  ${i.ip}  AS${i.asn}  ${i.pais}`);
    }
    if (r.topAlvos?.length) {
      console.log('   no que bate:');
      for (const a of r.topAlvos) console.log(`     ${String(a.n).padStart(7)}  ${a.host}${a.caminho}`);
    }
  }
  for (const e of r.erros) console.log(`   ⚠️  ${e}`);
}

/**
 * ⚠️ NUNCA `process.exit()` AQUI.
 *
 * Medido em 10/09/2026 no Windows: sair à força logo depois de um `fetch`
 * derruba o Node numa assertion do libuv (`UV_HANDLE_CLOSING`, src/win/async.c)
 * e o código de saída vira 127 — justamente o código que o vigia automático
 * leria como "deu ruim no script", escondendo o veredito. `process.exitCode`
 * deixa o Node fechar os sockets sozinho e sair com o número certo.
 */
async function main() {
  if (!TOKEN) {
    console.error('Falta CLOUDFLARE_API_TOKEN. Veja o cabeçalho deste arquivo: token SÓ DE LEITURA, 3 permissões.');
    return 2;
  }

  let zonas;
  try {
    zonas = await rest('/zones?per_page=50');
  } catch (e) {
    console.error(`Não consegui listar as zonas: ${e.message}`);
    console.error('Se disser "Authentication error", o token não tem Zone·Zone·Read ou expirou.');
    return 2;
  }

  if (ZONA_FILTRO) zonas = zonas.filter((z) => z.name === ZONA_FILTRO);
  if (!zonas.length) {
    console.error(ZONA_FILTRO ? `Zona "${ZONA_FILTRO}" não existe nesta conta.` : 'A conta não tem nenhuma zona.');
    return 2;
  }

  const agora = new Date();
  const resultados = [];
  for (const z of zonas) resultados.push(await analisarZona(z, agora));

  if (JSON_OUT) {
    console.log(JSON.stringify({ em: iso(agora), horas: HORAS, zonas: resultados }, null, 2));
  } else {
    console.log(`Cloudflare — janela de ${HORAS}h encerrada em ${iso(agora)}`);
    resultados.forEach(imprimir);
    console.log('');
  }

  const suspeito = resultados.some((r) => r.veredito === 'SUSPEITO');
  const cego = resultados.every((r) => r.veredito === 'NAO_SEI');
  return suspeito ? 1 : cego ? 2 : 0;
}

main().then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (e) => {
    console.error(`Falha inesperada: ${e?.stack || e}`);
    process.exitCode = 2;
  },
);
