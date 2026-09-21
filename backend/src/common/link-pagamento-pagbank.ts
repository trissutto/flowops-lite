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
