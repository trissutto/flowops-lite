/**
 * LINK DE PAGAMENTO DO PDV PELO PAGBANK — a régua, num lugar só (21/09/2026).
 *
 * ── O CASO ──
 *
 * 21/09, 15:17: a Pagar.me passou a recusar TODO link do PDV com
 * `HTTP 412 "The checkout payment method is not available for this account"`
 * — o "checkout" foi desligado na conta, do lado deles (último link bom às
 * 11:16; nada mudou no Flow no intervalo). A loja 05 tentou ~20 vezes a mesma
 * venda. Decisão do dono: "enquanto a Pagar.me não volta, o link do PDV sai
 * pelo PagBank".
 *
 * O link PRONTO do PagBank (`POST /checkouts`) também não serve: a conta
 * responde `403 allowlist_access_required` (teste autorizado pelo dono no
 * mesmo dia — as 8 lojas com config própria usam o MESMO token da matriz).
 * Então o link é NOSSO: a página `/pague/<token>` cobra pela Orders API do
 * PagBank — PIX (`createPixCharge`) ou cartão criptografado no navegador
 * (`createCardCharge`, o mesmo caminho do site desde 16/09).
 *
 * ── COMO O LINK EXISTE NO BANCO (sem tabela nova) ──
 *
 * O link é um PIX de venda online com `origem = 'venda_online_link'` — a
 * "âncora". O `linkToken` dela é o token da página. Tudo que a cliente paga
 * pela página nasce com a MESMA origem e o MESMO `saleId`: o PIX novo (o
 * código vale 1h; a página gera outro quando o anterior vence) e cada
 * tentativa de cartão (`method='credit_card'`). Assim os reconciliadores que
 * já existem fecham a venda sem saber que link é link: PIX pago ou cartão
 * pago da venda aberta → `venda_online` registrada → finalize.
 */

/** A origem de TUDO que nasce do link de pagamento do PDV (âncora, PIX e cartão). */
export const ORIGEM_LINK_PAGBANK = 'venda_online_link';

/**
 * ── OS OUTROS DOIS QUE USAVAM O CHECKOUT DA PAGAR.ME (22/09/2026) ──
 *
 * O cartão da LIVE (página `/pagar/<carrinho>`) e o link da DIFERENÇA da troca
 * de peça também saíam pelo checkout da Pagar.me desligado em 21/09 — os dois
 * estavam sem cobrar cartão. Dono: "pode fazer sim" (passar pro PagBank).
 *
 * - LIVE: o cartão é cobrado NA PRÓPRIA página da live (que já tem endereço,
 *   CPF e celular da cliente) — cada tentativa nasce com `saleId` = id do
 *   carrinho e esta origem. Quem fecha o carrinho é o `checkPayment` da live.
 * - TROCA: o link é a MESMA página `/pague/<token>` do PDV, com `saleId =
 *   troca:<id da troca>`. Quem libera a separação é a trava da diferença
 *   (`common/diferenca-troca.ts`), que agora também lê o PagBank.
 */
export const ORIGEM_LIVE_CARTAO = 'live_cartao';
export const ORIGEM_TROCA_LINK = 'troca_link';

/** Origens cuja ÂNCORA abre a página pública `/pague/<token>`. */
export const ORIGENS_PAGINA_PAGUE: readonly string[] = [ORIGEM_LINK_PAGBANK, ORIGEM_TROCA_LINK];

/**
 * Cartões que o `PagbankPixReconcileService` pergunta ao PagBank quando ficam
 * EM ANÁLISE (o webhook pode não chegar). O cartão do site tem reconciliador
 * próprio (`LojaPagamentoReconcileService`) e fica fora.
 */
export const ORIGENS_CARTAO_RECONCILIADAS: readonly string[] = [
  ORIGEM_LINK_PAGBANK,
  ORIGEM_TROCA_LINK,
  ORIGEM_LIVE_CARTAO,
];

/** O `saleId` da cobrança da diferença de uma troca de peça — nos dois gateways. */
export function saleIdDaTroca(swapId: string): string {
  return `troca:${swapId}`;
}

/** O id da troca por trás de um `saleId` de cobrança — ou null se não for de troca. */
export function swapIdDoSaleId(saleId: string | null | undefined): string | null {
  const s = String(saleId || '').trim();
  if (!s.startsWith('troca:')) return null;
  const id = s.slice('troca:'.length).trim();
  return id || null;
}

/**
 * A troca vista como "venda" pela régua do link: aberta enquanto espera a
 * cliente pagar; paga ou desfeita, o link se encerra (`estadoDoLinkPagbank`).
 */
export function statusDaTrocaComoVenda(statusDaTroca: string | null | undefined): 'open' | 'finalized' | 'cancelled' {
  const s = String(statusDaTroca || '').trim().toLowerCase();
  if (s === 'pending') return 'open';
  if (s === 'cancelled' || s === 'canceled') return 'cancelled';
  return 'finalized';
}

/** `details.tipo` do pagamento que a venda ganha quando o link é pago. */
export const TIPO_LINK_PAGBANK = 'pagbank_link';

/**
 * A cobrança nasceu na VENDA ONLINE do PDV? ('Gerar PIX' ou link.)
 * É o que faz o reconciliador fechar a venda como `venda_online` (pedido de
 * separação, sem NFC-e) em vez de `pix` de balcão.
 */
export function ehOrigemVendaOnline(origem: string | null | undefined): boolean {
  const o = String(origem || '').trim();
  return o === 'venda_online' || o === ORIGEM_LINK_PAGBANK;
}

/**
 * Validade do LINK (não do código PIX, que vale 1h e é regerado na página).
 * `PAGBANK_LINK_HORAS`, padrão 72h — a mesma validade do link da Pagar.me —,
 * teto de 7 dias.
 */
export function horasDoLinkPagbank(): number {
  const n = Number(process.env.PAGBANK_LINK_HORAS);
  if (!Number.isFinite(n) || n <= 0) return 72;
  return Math.min(168, Math.max(1, Math.round(n)));
}

/** Até quando o link aceita pagamento, contado de quando a loja gerou. */
export function linkPagbankVenceEm(criadoEm: Date | string, horas = horasDoLinkPagbank()): Date {
  return new Date(new Date(criadoEm).getTime() + horas * 3600_000);
}

/**
 * Teto de tentativas de CARTÃO por venda, pela página pública.
 *
 * Medição de 01/08 (link da Pagar.me): 1ª tentativa aprova 69%, 2ª 35%, da 3ª
 * em diante ZERO (0 de 21). E a página é aberta — sem teto, um link vazado
 * vira máquina de testar cartão roubado (ataque de 28/08 no site). 4 deixa a
 * cliente corrigir um CVV errado e ainda trava o abuso.
 */
export function maxTentativasCartaoLink(): number {
  const n = Number(process.env.PAGBANK_LINK_MAX_CARTAO);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return Math.min(10, Math.round(n));
}

/** Parcelas sem juros oferecidas no link (a loja absorve a taxa, igual ao site). */
export function maxParcelasLink(): number {
  const n = Number(process.env.PAGBANK_LINK_MAX_PARCELAS || process.env.PAGARME_MAX_PARCELAS);
  if (!Number.isFinite(n) || n <= 0) return 12;
  return Math.min(12, Math.max(1, Math.round(n)));
}

/**
 * Por qual gateway o botão "link de pagamento" do PDV sai.
 * `PDV_LINK_GATEWAY=pagarme` volta a Pagar.me quando ela religar o checkout;
 * sem a env, PagBank (decisão do dono, 21/09).
 */
export function gatewayDoLinkPdv(): 'pagbank' | 'pagarme' {
  return String(process.env.PDV_LINK_GATEWAY || '').trim().toLowerCase() === 'pagarme'
    ? 'pagarme'
    : 'pagbank';
}

/**
 * A CLIENTE PODE TENTAR O CARTÃO AGORA? Régua do cartão da live (22/09), a
 * mesma defesa da página do link: dinheiro já entrou → não cobra de novo;
 * cartão EM ANÁLISE → espera o banco (outra tentativa viraria cobrança em
 * dobro se a primeira aprovar depois); teto de tentativas por compra.
 */
export function situacaoDoCartao(
  cobrancas: Array<{ method?: string | null; status?: string | null }>,
  max = maxTentativasCartaoLink(),
): { pode: boolean; motivo?: 'pago' | 'analise' | 'tentativas'; usadas: number; restantes: number } {
  const cartoes = cobrancas.filter((c) => String(c.method || '') === 'credit_card');
  const usadas = cartoes.length;
  const restantes = Math.max(0, max - usadas);
  if (cobrancas.some((c) => String(c.status || '') === 'paid')) return { pode: false, motivo: 'pago', usadas, restantes };
  if (cartoes.some((c) => String(c.status || '') === 'pending')) return { pode: false, motivo: 'analise', usadas, restantes };
  if (usadas >= max) return { pode: false, motivo: 'tentativas', usadas, restantes };
  return { pode: true, usadas, restantes };
}

/** `reference_id` de cada tentativa de cartão — único por tentativa (máx. 64). */
export function referenciaCartaoLink(saleId: string, storeCode: string, tentativa: number): string {
  return `${saleId}:${storeCode}:C${tentativa}`.slice(0, 64);
}

/**
 * A frase que a CLIENTE lê quando o cartão não passa na página do link — a
 * mesma régua de frases do checkout do site (`LojaOrdersService`). Nunca o
 * código cru da operadora.
 */
export function mensagemRecusaCartaoLink(texto: string | null | undefined): string {
  const cru = String(texto || '').toLowerCase();
  if (/insufficient|saldo|limite/.test(cru)) {
    return 'O cartão não tinha limite disponível pra esse valor. Tente outro cartão ou pague com PIX. 💜';
  }
  if (/expired|expir/.test(cru)) {
    return 'Esse cartão parece estar vencido. Confira a validade ou use outro. 💜';
  }
  if (/cvv|security code|invalid.*card|card.*invalid|numero|number/.test(cru)) {
    return 'Confira os dados do cartão (número, validade e código de segurança) e tente de novo. 💜';
  }
  if (/timeout|indispon|unavailable|try again/.test(cru)) {
    return 'A operadora do cartão não respondeu agora. Tente novamente em instantes ou pague com PIX. 💜';
  }
  return 'O pagamento não foi aprovado pela operadora do cartão. Tente outro cartão ou pague com PIX. 💜';
}

export type EstadoLinkPagbank = 'aberto' | 'pago' | 'vencido' | 'encerrado';

/**
 * O que a página diz pra cliente — e o que decide se ela ainda pode pagar.
 *
 * - `pago`: QUALQUER cobrança do link paga. Dinheiro na conta ganha de tudo.
 * - `encerrado`: a venda não está mais aberta (a loja cancelou, ou fechou por
 *   outro meio). Link de venda fechada que aceita dinheiro é cobrança em dobro.
 * - `vencido`: passou da validade do LINK.
 * - `aberto`: pode pagar.
 */
export function estadoDoLinkPagbank(input: {
  statusDasCobrancas: string[];
  statusDaVenda: string | null | undefined;
  venceEm: Date;
  agora?: number;
}): EstadoLinkPagbank {
  if (input.statusDasCobrancas.some((s) => String(s) === 'paid')) return 'pago';
  const venda = String(input.statusDaVenda || '');
  if (venda !== 'open' && venda !== 'paused') return 'encerrado';
  const agora = input.agora ?? Date.now();
  if (input.venceEm.getTime() <= agora) return 'vencido';
  return 'aberto';
}
