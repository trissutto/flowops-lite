import 'server-only';

import type { Robo } from '../bot-detect';
import type { TrackingEvent } from '../types';

/**
 * CÓPIA NOSSA DOS CLIQUES DE LOJA.
 *
 * O evento continua indo pro GA4 e pra Meta como sempre; isto aqui só garante
 * que o dado também exista no Postgres do FlowOps, onde a tela da retaguarda
 * consegue ler sem depender de cota de API nem da amostragem do Google.
 *
 * Por que só os quatro botões de loja e não o funil inteiro: `view_item` e
 * `add_to_cart` são milhares por dia e já têm dono (o GA4). Clique em "Como
 * chegar" são dezenas, valem por unidade, e hoje não existem em lugar nenhum —
 * é a lacuna que justifica gravar. Ampliar a lista é acrescentar aqui.
 */
const EVENTOS_DE_LOJA = new Set([
  'whatsapp_click',
  'instagram_click',
  'store_locator',
  'phone_click',
  'stores_online_cta_click',
  'stores_product_click',
]);

/** Nunca segura a resposta do beacon por causa de métrica. */
const TIMEOUT_MS = 4_000;

function texto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  const t = String(valor).trim();
  return t || null;
}

const PARAMETROS_SEGUROS: Partial<Record<string, readonly string[]>> = {
  color_switch: ['color'],
  size_switch: ['size'],
  add_to_cart_blocked: ['reason'],
  add_shipping_info: ['shipping_tier'],
  add_payment_info: ['payment_type'],
  checkout_submission: ['method'],
  checkout_error: ['method', 'reason', 'field'],
  checkout_validation_error: ['section', 'field'],
  pix_created: ['method'],
  payment_method_selected: ['method'],
  pix_copied: ['method', 'order_id'],
  pix_expired: ['method', 'order_id'],
  card_declined: ['method', 'attempt'],
  payment_retry: ['method', 'attempt'],
  checkout_recovered: ['method', 'order_id'],
  stores_online_cta_click: ['source_position'],
  stores_product_click: ['source_position', 'product_ref', 'item_index'],
};

function dadosSeguros(evento: TrackingEvent): Record<string, unknown> {
  const dados: Record<string, unknown> = {};
  for (const chave of PARAMETROS_SEGUROS[evento.event] ?? []) {
    const valor = texto(evento.params?.[chave]);
    if (valor) dados[chave] = valor.slice(0, 80);
  }
  return dados;
}

/**
 * Envia o que for clique de loja. NUNCA lança: chamada em paralelo ao despacho
 * das plataformas, e uma falha aqui não pode derrubar o envio pro GA4/Meta.
 */
export async function persistirCliquesDeLoja(events: TrackingEvent[]): Promise<number> {
  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  // Sem configuração o recurso some em silêncio — mesmo contrato dos destinos
  // de tracking: variável ausente significa desligado, não erro.
  if (!baseUrl || !token) return 0;

  const cliques = events
    .filter((e) => EVENTOS_DE_LOJA.has(e.event))
    .map((e) => ({
      evento: e.event,
      /**
       * A loja pode chegar por dois caminhos e os dois são legítimos:
       * `params.store` é a unidade DO BOTÃO clicado; `context.loja` é a loja
       * atribuída à visitante por CEP. A do botão ganha — a pergunta é "qual
       * loja receberia esse contato", não "de onde a pessoa é".
       */
      loja: texto(e.params?.store) ?? texto(e.context?.loja),
      cidade: texto(e.params?.city),
      origem: texto(e.params?.source) ?? texto(e.params?.source_position),
      path: texto(e.context?.page?.path),
      sessionId: texto(e.context?.session_id),
    }));

  if (!cliques.length) return 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/site-metrics/cliques`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-loja-token': token },
      body: JSON.stringify({ cliques }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[tracking] FlowOps recusou os cliques: HTTP ${res.status}`);
      return 0;
    }
    return cliques.length;
  } catch (err) {
    console.error('[tracking] falha ao gravar cliques no FlowOps:', err);
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A CÓPIA DE PRIMEIRA PARTE DO FUNIL INTEIRO (dono, 13/08: "preciso de todos
 * os cliques registrados — para todo o site").
 *
 * TODO evento vai pro Postgres do FlowOps — inclusive de visitante sem aceite
 * do banner, que chega aqui já anonimizado (sem user_id; fbp/fbc nem saíram
 * do navegador). O que NUNCA muda: GA4 e Meta continuam atrás do opt-in — o
 * corte é do `/api/events`, este módulo só grava na casa.
 *
 * Vai o mínimo que dá leitura: nome do evento, path, loja, sessão, valor e um
 * `dados` enxuto (REFs, termo de busca, origem). Nada de e-mail, telefone,
 * endereço — dado pessoal não entra nesta tabela.
 *
 * `robo` vem carimbado do `/api/events`, que é o único lugar com o user-agent
 * na mão. O evento de robô CONTINUA sendo gravado, de propósito: marcado, ele
 * responde "quem varreu meu site" e dá pra medir o custo que a varredura gera.
 * Descartar aqui jogaria essa resposta fora — quem esconde o robô é a tela.
 */
export async function persistirEventosSite(
  events: TrackingEvent[],
  semAceite: boolean,
  robo: Robo = { bot: false, nome: null },
): Promise<number> {
  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  if (!baseUrl || !token) return 0;

  const eventos = events.map((e) => {
    const refs = Array.isArray(e.items)
      ? e.items.map((i) => texto(i.sku) ?? texto(i.product_id)).filter(Boolean).slice(0, 6)
      : [];
    const dados: Record<string, unknown> = dadosSeguros(e);
    if (refs.length) dados.refs = refs;
    const termo = texto((e.params as Record<string, unknown>)?.search_term);
    if (termo) dados.busca = termo;
    const origem =
      texto((e.params as Record<string, unknown>)?.source) ??
      texto((e.params as Record<string, unknown>)?.source_position);
    if (origem) dados.origem = origem;

    /**
     * DE ONDE A PESSOA VEIO — o UTM, que chegava aqui e era jogado fora.
     *
     * `context.attribution` já viajava em TODO evento (o checkout usa pra casar
     * o pedido com a campanha), mas nada disso entrava no `site_eventos`: o
     * painel do funil não tinha como separar público de intenção diferente.
     * Foi o que faltou pra medir o anúncio das LOJAS, cujo público não compra
     * no site e por isso não pode contar como "visitante sem compra".
     *
     * Chave `campanha`, não `origem`: `origem` já significa outra coisa aqui
     * (a POSIÇÃO do botão de loja clicado — store_card, rodapé). Misturar os
     * dois quebraria a tela de cliques de loja, que lê essa chave.
     *
     * ⚠️ A atribuição sobrevive 30 dias (ver `captureAttribution`). Quem veio
     * pelo anúncio hoje continua carimbado se voltar semana que vem — então
     * regra de exclusão do funil casa a campanha COM a página de entrada, e
     * não só o `campanha=`, senão uma compra orgânica dela sumiria da conta.
     */
    const attr = e.context?.attribution;
    const campanha = texto(attr?.campaign);
    if (campanha) dados.campanha = campanha;
    const canal = texto(attr?.source);
    if (canal) dados.canal = canal;
    const midia = texto(attr?.medium);
    if (midia) dados.midia = midia;
    // `term` carrega o `{{placement}}` do Meta — é ele que denuncia se o clique
    // veio de um lugar que só gera rejeição.
    const posicao = texto(attr?.term);
    if (posicao) dados.posicao = posicao;
    const utmId = texto(attr?.id);
    if (utmId) dados.utm_id = utmId;

    /**
     * CLIQUE PAGO — o `gclid`/`fbclid`, que o navegador capturava e este
     * módulo jogava fora.
     *
     * Sem isto, "tráfego pago" no relatório dependeria 100% de o `utm_medium`
     * estar certo em cada anúncio — e anúncio mal etiquetado é a regra, não a
     * exceção. O id do clique é posto pela PRÓPRIA plataforma na URL de
     * destino: existe mesmo quando ninguém lembrou de marcar UTM, e não existe
     * em quem chegou de graça. É a única prova de "isto foi anúncio" que não
     * depende da disciplina de quem sobe a campanha.
     *
     * Guarda o FATO e a PLATAFORMA, nunca o id: `gclid`/`fbclid` identificam
     * um clique de uma pessoa, e identificador de pessoa não entra nesta
     * tabela (mesma regra que já barra e-mail, telefone e endereço aqui).
     *
     * O `utm_medium` entra como segunda via, pro anúncio que venha etiquetado
     * mas sem id de clique (link na bio impulsionado, parceria, e-mail pago).
     *
     * ⚠️ Herda a janela de 30 dias da atribuição: quem clicou no anúncio na
     * semana passada e voltou direto hoje continua marcada como paga. É o
     * mesmo last-click do Meta e do GA4 — bate com o Gerenciador, mas não se
     * confunde com "esta visita veio do anúncio".
     */
    const gclid = texto(attr?.gclid);
    const fbclid = texto(attr?.fbclid);
    const midiaPaga = /^(cpc|ppc|paid|paid_social|paidsocial|paid-social)$/i.test(midia ?? '');
    if (gclid || fbclid || midiaPaga) {
      dados.pago = true;
      // Os dois ids ao mesmo tempo só acontece com URL montada na mão; o
      // Google ganha por ser o que reescreve a URL de destino sozinho.
      dados.plataforma = gclid ? 'google' : fbclid ? 'meta' : (canal ?? 'nao-identificada');
    }

    return {
      evento: e.event,
      path: texto(e.context?.page?.path),
      loja: texto((e.params as Record<string, unknown>)?.store) ?? texto(e.context?.loja),
      sessionId: texto(e.context?.session_id),
      valor: typeof e.value === 'number' && Number.isFinite(e.value) ? e.value : null,
      dados: Object.keys(dados).length ? dados : undefined,
      semAceite,
      bot: robo.bot,
      botNome: robo.nome,
    };
  });

  if (!eventos.length) return 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/site-metrics/eventos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-loja-token': token },
      body: JSON.stringify({ eventos }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[tracking] FlowOps recusou os eventos: HTTP ${res.status}`);
      return 0;
    }
    return eventos.length;
  } catch (err) {
    console.error('[tracking] falha ao gravar eventos no FlowOps:', err);
    return 0;
  } finally {
    clearTimeout(timer);
  }
}
