import 'server-only';

/**
 * PEDIDOS — CLIENTE DO BACKEND FLOWOPS (Sprint 011).
 *
 * O pedido NÃO vive mais neste processo. Ele nasce, vive e morre no Postgres
 * do FlowOps, atrás de `POST /public/loja/pedido`. Este módulo é só a boca de
 * entrada: monta a chamada, autentica com `LOJA_ORDER_TOKEN` e traduz a
 * resposta pro vocabulário do ecommerce.
 *
 * POR QUE A MUDANÇA (era `InMemoryOrderStore`):
 *   1. Memória de função serverless some. A instância recicla, hiberna, ou o
 *      poll seguinte cai noutra — e o pedido "não existe". Pra dinheiro de
 *      verdade isso é inaceitável, e era o bug conhecido que esta sprint mata.
 *   2. O pedido precisa estar no Postgres pro resto da casa funcionar: CRM,
 *      roteamento pra loja, separação, NF-e. Pedido que só o ecommerce enxerga
 *      é pedido que ninguém despacha.
 *   3. Quem cobra na Pagar.me é o backend, que já tem o `PagarmeService` e a
 *      conta configurada. Dois sistemas cobrando na mesma conta seria pedir
 *      confusão (a casa já tem essa cicatriz com o token único do PagBank).
 *
 * ⚠️ SEM FALLBACK PRA MEMÓRIA, NUNCA. Se `FLOWOPS_API_URL`/`LOJA_ORDER_TOKEN`
 * não estiverem configuradas, a chamada falha com erro CLARO no log e a rota
 * devolve mensagem elegante. Cair de volta pra memória em silêncio seria
 * ressuscitar exatamente o bug que estamos matando — e pior, sem aviso.
 *
 * A interface `OrderStore` continua viva como CONTRATO: quem chama (as rotas
 * de checkout) não sabe se o pedido está no Flow, num gateway ou numa gaveta.
 * Trocar de dono é implementar três métodos.
 *
 * Por que um fetch próprio em vez de `lib/api.ts`: aquele cliente é otimizado
 * pra vitrine (cache/revalidate do Next, sem header customizado). Aqui é
 * sempre `no-store`, sempre com `x-loja-token` e com timeout mais generoso no
 * create — o backend fala com a Pagar.me no meio da requisição.
 */

import type {
  Address,
  CheckoutErrorCode,
  CustomerIdentity,
  Order,
  OrderStatus,
  PaymentMethod,
  ShippingQuote,
} from '@/types/checkout';
import { checkoutErrorCode } from './checkout-error-code';

/* ────────────────────────────────────────────────────────────────────────────
 * Contrato com o backend
 * ──────────────────────────────────────────────────────────────────────────── */

/** Item do pedido no vocabulário do backend (o `sku` é o que a separação usa). */
export interface NewOrderItem {
  productId: string;
  sku: string;
  slug: string;
  name: string;
  size: string;
  color?: string;
  quantity: number;
  unitPrice: number;
}

/** Corpo de `POST /public/loja/pedido` — já com os valores RECALCULADOS aqui. */
export interface NewOrderPayload {
  customer: CustomerIdentity;
  shippingAddress?: Address;
  shipping: ShippingQuote;
  items: NewOrderItem[];
  couponCode?: string;
  subtotal: number;
  discount: number;
  shippingPrice: number;
  total: number;
  payment: {
    method: Extract<PaymentMethod, 'pix' | 'card'>;
    installments?: number;
    /** Token da Pagar.me gerado NO NAVEGADOR — o número do cartão nunca sai de lá. */
    cardToken?: string;
  };
  tracking?: Order['tracking'];
}

/**
 * Resposta 201 do backend. Repare no que ela NÃO tem: itens, endereço,
 * cliente. O backend devolve só o que ele acabou de decidir (id, número,
 * status, total conferido e a cobrança); o resto o BFF já tem em mãos.
 */
export interface CreatedOrderAck {
  id: string;
  number: string;
  status: OrderStatus;
  total: number;
  /**
   * A CONTA DA CASA, discriminada (bloco A, 06/08). O backend passou a
   * reprecificar o carrinho inteiro contra o catálogo antes de cobrar: preço
   * de peça que mudou, cupom recalculado e o desconto do Pix nascem LÁ. Sem
   * estes campos o BFF montaria o resumo com os números dele e trocaria só o
   * total — resumo que não soma o total exibido.
   *
   * Opcionais porque o backend antigo não mandava: sem eles, cai no cálculo
   * local de sempre.
   */
  subtotal?: number;
  discount?: number;
  couponDiscount?: number;
  pixDiscount?: number;
  shippingPrice?: number;
  couponCode?: string;
  payment: {
    method: PaymentMethod;
    installments?: number;
    /** `qrCode` é opcional: se o backend não mandar, o BFF gera do copia-e-cola. */
    pix?: { copyPaste: string; expiresAt: string; qrCode?: string };
  };
}

/** Resposta de `GET /public/loja/pedido/:id/status`. */
export interface OrderStatusSnapshot {
  status: OrderStatus;
  paidAt?: string;
}

/**
 * Opções do `create` que NÃO fazem parte do pedido.
 *
 * `clientIp` é o IP real da cliente: sem ele o backend enxerga só o IP de
 * saída da Vercel e o limite de 20 pedidos/min vira um balde só pra loja
 * inteira — a 21ª cliente do minuto lia "muitas tentativas seguidas" na hora
 * de pagar (o `chamar` já aceitava o header desde a sprint 011, mas nenhum
 * chamador repassava; ver `ipDe` no `loja-orders.controller.ts`).
 */
export interface CreateOrderOptions {
  clientIp?: string;
}

/**
 * A peça que o guard do backend recusou por PREÇO, com o preço de agora.
 * Vem em `body.item` da recusa `catalog_unavailable` (backend novo); com o
 * backend antigo simplesmente não vem — quem lê tem que tolerar `undefined`.
 */
export interface CatalogItemHint {
  productId: string;
  /** Vazio quando o backend não tinha tamanho (manda `null`) — o site casa só por produto. */
  size: string;
  color?: string;
  precoAtual: number;
}

export interface OrderStore {
  /** Cria o pedido no Postgres do Flow e devolve o que o backend decidiu. */
  create(payload: NewOrderPayload, opts?: CreateOrderOptions): Promise<CreatedOrderAck>;
  /** Pedido completo pra tela de confirmação. `undefined` = não existe. */
  get(id: string): Promise<Order | undefined>;
  /** Só "pagou ou não pagou" — é o que o poll do PixPanel pergunta. */
  status(id: string): Promise<OrderStatusSnapshot | undefined>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Erro com duas caras: uma pra cliente, outra pro log
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `message` é técnico (vai pro log); `publico` é a frase que a cliente lê.
 * Separar os dois é o que impede status HTTP e nome de env de vazarem pra tela.
 */
export class OrderStoreError extends Error {
  constructor(
    tecnico: string,
    readonly publico: string,
    readonly status = 502,
    readonly code: CheckoutErrorCode = 'internal_error',
    /**
     * Só em `catalog_unavailable` por preço: qual peça e quanto custa agora.
     * A rota repassa pro navegador, que reescreve o preço na sacola em vez de
     * mandar a cliente "atualizar a página" (que não atualizava o preço).
     */
    readonly item?: CatalogItemHint,
    /**
     * Só em `shipping_changed` vindo do BACKEND (só o frete subiu entre a
     * tela e a recotação): a cotação nova. A rota repassa e a página atualiza
     * a entrega — mesmo tratamento do `shipping_changed` que o próprio BFF já
     * emite antes de criar o pedido.
     */
    readonly quote?: QuoteAtualizada,
  ) {
    super(tecnico);
    this.name = 'OrderStoreError';
  }
}

const ERRO_PADRAO = 'Não conseguimos concluir seu pedido agora. Fica tranquila: nada foi cobrado — tente de novo em instantes.';

/* ────────────────────────────────────────────────────────────────────────────
 * Implementação
 * ──────────────────────────────────────────────────────────────────────────── */

/** Timeout do create: o backend cria a cobrança na Pagar.me dentro da chamada. */
const TIMEOUT_CREATE_MS = 15_000;
/** Leitura é barata — se demorar mais que isso, alguma coisa está errada. */
const TIMEOUT_LEITURA_MS = 8_000;

interface Config {
  baseUrl: string;
  token: string;
}

/**
 * Lê a configuração ou explode. Lido a cada chamada de propósito: na Vercel a
 * env pode entrar sem redeploy do processo, e cachear numa const de módulo
 * esconderia a correção até o próximo cold start.
 */
function config(): Config {
  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';

  if (!baseUrl || !token) {
    const faltando = [!baseUrl && 'FLOWOPS_API_URL', !token && 'LOJA_ORDER_TOKEN']
      .filter(Boolean)
      .join(' + ');
    // Log GRITADO: sem isso configurado o checkout inteiro está fora do ar, e
    // a única pista seria uma mensagem elegante na tela da cliente.
    console.error(
      `[orders] CHECKOUT FORA DO AR — ${faltando} não configurada(s). O pedido NASCE no backend FlowOps; sem essas envs não há onde criá-lo (e não existe fallback em memória, de propósito). Defina no projeto da Vercel.`,
    );
    throw new OrderStoreError(
      `env ausente: ${faltando}`,
      'Nosso checkout está em manutenção neste instante. Tente de novo em alguns minutos — sua sacola continua guardada.',
      503,
    );
  }

  return { baseUrl, token };
}

/** Resposta do backend em qualquer um dos três endpoints. */
type BackendEnvelope = {
  ok?: boolean;
  error?: string;
  code?: unknown;
  order?: unknown;
  status?: unknown;
  paidAt?: unknown;
  /** Recusa por preço: `{ productId, size, color?, precoAtual }` — ver `CatalogItemHint`. */
  item?: unknown;
  /** `shipping_changed` do backend (só o frete subiu): a cotação que vale agora. */
  quote?: unknown;
};

/** `body.quote` de `shipping_changed` → cotação nova, ou `undefined` sem o shape. */
export interface QuoteAtualizada {
  id: string;
  label: string;
  price: number;
  /** Mesmo shape da `ShippingQuote.etaDays` do site: prazo do transportador + separação. */
  etaDays: { min: number; max: number } | null;
}
function quoteAtualizada(raw: unknown): QuoteAtualizada | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const price = typeof o.price === 'number' && Number.isFinite(o.price) ? o.price : NaN;
  const id = asString(o.id);
  if (!id || !(price >= 0)) return undefined;
  const eta = o.etaDays as { min?: unknown; max?: unknown } | null | undefined;
  const etaDays =
    eta && typeof eta === 'object' && typeof eta.min === 'number' && typeof eta.max === 'number'
      ? { min: eta.min, max: eta.max }
      : null;
  return { id, label: asString(o.label) || id, price, etaDays };
}

/** `body.item` da recusa → `CatalogItemHint`, ou `undefined` se não tiver o shape. */
function itemRecusado(raw: unknown): CatalogItemHint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const productId = asString(o.productId);
  const precoAtual = typeof o.precoAtual === 'number' && Number.isFinite(o.precoAtual) ? o.precoAtual : NaN;
  if (!productId || !(precoAtual > 0)) return undefined;
  return {
    productId,
    // O backend manda `null` quando não tem — vira '' e o site casa só por produto.
    size: asString(o.size),
    color: typeof o.color === 'string' && o.color ? o.color : undefined,
    precoAtual,
  };
}

async function chamar(
  path: string,
  init: {
    method: 'GET' | 'POST';
    body?: unknown;
    timeoutMs: number;
    /**
     * IP real da cliente. O backend limita por IP, mas quem chega lá é esta
     * função — server-to-server —, então sem repassar isto o limite vale pra
     * loja INTEIRA somada e a 21ª cliente do minuto leva 429. Ver `ipDe` no
     * `loja-orders.controller.ts`.
     */
    clientIp?: string;
  },
): Promise<{ httpStatus: number; body: BackendEnvelope }> {
  const { baseUrl, token } = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        'x-loja-token': token,
        ...(init.clientIp ? { 'x-cliente-ip': init.clientIp } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      // Pedido NUNCA entra em cache — nem o do Next, nem o de ninguém.
      cache: 'no-store',
    });

    const body = (await res.json().catch(() => ({}))) as BackendEnvelope;
    return { httpStatus: res.status, body };
  } catch (err) {
    // AbortError e falha de rede caem aqui iguais: pra quem chama, o backend
    // não respondeu. A distinção interessa ao log, não à cliente.
    const motivo = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'rede';
    throw new OrderStoreError(
      `${motivo} em ${path}: ${err instanceof Error ? err.message : err}`,
      ERRO_PADRAO,
      502,
      'network_error',
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────────────────────────────────── normalização do GET */

const STATUS_VALIDOS: OrderStatus[] = ['awaiting_payment', 'paid', 'cancelled', 'expired'];

function asStatus(v: unknown, fallback: OrderStatus = 'awaiting_payment'): OrderStatus {
  return STATUS_VALIDOS.includes(v as OrderStatus) ? (v as OrderStatus) : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Backend → `Order` do ecommerce, TOLERANTE a campo faltando.
 *
 * Não é preciosismo: a tela de confirmação lê `order.shipping.kind` e
 * `order.items.map` direto. Um campo ausente numa resposta de backend em
 * evolução viraria tela branca no pior momento possível — logo depois de a
 * cliente pagar. Preferimos exibir o pedido com um pedaço vazio a não exibir
 * nada. (Mesma lição da ficha do CRM que travava em "Carregando...".)
 */
function normalizarOrder(raw: unknown): Order | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const id = asString(o.id);
  if (!id) return undefined;

  const customer = (o.customer ?? {}) as Record<string, unknown>;
  const shipping = (o.shipping ?? {}) as Record<string, unknown>;
  const pagamento = (o.payment ?? {}) as Record<string, unknown>;
  const pix = pagamento.pix as Record<string, unknown> | undefined;

  return {
    id,
    number: asString(o.number, id.slice(0, 8).toUpperCase()),
    status: asStatus(o.status),
    createdAt: asString(o.createdAt, new Date().toISOString()),
    paidAt: typeof o.paidAt === 'string' ? o.paidAt : undefined,
    customer: {
      name: asString(customer.name),
      email: asString(customer.email),
      cpf: asString(customer.cpf),
      phone: asString(customer.phone),
    },
    shippingAddress: o.shippingAddress as Address | undefined,
    shipping: {
      id: asString(shipping.id, 'entrega'),
      kind: (shipping.kind as ShippingQuote['kind']) ?? 'correios',
      label: asString(shipping.label, 'Entrega'),
      price: asNumber(shipping.price),
      etaDays: shipping.etaDays as ShippingQuote['etaDays'],
      readyInHours: typeof shipping.readyInHours === 'number' ? shipping.readyInHours : undefined,
      storeSlug: typeof shipping.storeSlug === 'string' ? shipping.storeSlug : undefined,
      storeLabel: typeof shipping.storeLabel === 'string' ? shipping.storeLabel : undefined,
    },
    items: Array.isArray(o.items) ? (o.items as Order['items']) : [],
    subtotal: asNumber(o.subtotal),
    discount: asNumber(o.discount),
    couponCode: typeof o.couponCode === 'string' ? o.couponCode : undefined,
    shippingPrice: asNumber(o.shippingPrice),
    total: asNumber(o.total),
    payment: {
      method: (pagamento.method as PaymentMethod) ?? 'pix',
      installments: typeof pagamento.installments === 'number' ? pagamento.installments : undefined,
      pix: pix
        ? {
            qrCode: asString(pix.qrCode),
            copyPaste: asString(pix.copyPaste),
            expiresAt: asString(pix.expiresAt),
          }
        : undefined,
    },
    // `tracking` fica de fora de propósito: é sinal interno do checkout, e a
    // única coisa que o lê (o purchase) agora chega pelo corpo do webhook.
  };
}

/* ───────────────────────────────────────────────────────────────── o store */

class BackendOrderStore implements OrderStore {
  async create(payload: NewOrderPayload, opts?: CreateOrderOptions): Promise<CreatedOrderAck> {
    const { httpStatus, body } = await chamar('/public/loja/pedido', {
      method: 'POST',
      body: payload,
      timeoutMs: TIMEOUT_CREATE_MS,
      clientIp: opts?.clientIp,
    });

    // `ok:false` com 200 é o "recusa elegante" do contrato: cupom morto,
    // cartão negado, estoque acabou. A frase dele já vem pronta pra tela.
    if (body.ok === false) {
      const code = checkoutErrorCode(body.code);
      throw new OrderStoreError(
        `backend recusou o pedido (${httpStatus}): ${body.error ?? 'sem motivo'}`,
        body.error || ERRO_PADRAO,
        400,
        code,
        // Só faz sentido na recusa por preço; qualquer outro `item` é ignorado.
        code === 'catalog_unavailable' ? itemRecusado(body.item) : undefined,
        // Idem: cotação nova só acompanha `shipping_changed`.
        code === 'shipping_changed' ? quoteAtualizada(body.quote) : undefined,
      );
    }

    if (httpStatus < 200 || httpStatus >= 300 || !body.order) {
      throw new OrderStoreError(
        `backend respondeu ${httpStatus} sem pedido`,
        ERRO_PADRAO,
        502,
        'invalid_response',
      );
    }

    const raw = body.order as Record<string, unknown>;
    const id = asString(raw.id);
    if (!id) {
      throw new OrderStoreError('backend devolveu pedido sem id', ERRO_PADRAO, 502, 'invalid_response');
    }

    const pagamento = (raw.payment ?? {}) as Record<string, unknown>;
    const pix = pagamento.pix as Record<string, unknown> | undefined;

    /** Só entra no ack o que o backend REALMENTE mandou — 0 vindo de campo
     *  ausente viraria "subtotal zero" no resumo. */
    const numeroOpcional = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;

    const ack: CreatedOrderAck = {
      id,
      number: asString(raw.number, id.slice(0, 8).toUpperCase()),
      status: asStatus(raw.status),
      total: asNumber(raw.total),
      subtotal: numeroOpcional(raw.subtotal),
      discount: numeroOpcional(raw.discount),
      couponDiscount: numeroOpcional(raw.couponDiscount),
      pixDiscount: numeroOpcional(raw.pixDiscount),
      shippingPrice: numeroOpcional(raw.shippingPrice),
      couponCode: typeof raw.couponCode === 'string' ? raw.couponCode : undefined,
      payment: {
        method: (pagamento.method as PaymentMethod) ?? payload.payment.method,
        installments: typeof pagamento.installments === 'number' ? pagamento.installments : undefined,
        pix: pix
          ? {
              copyPaste: asString(pix.copyPaste),
              expiresAt: asString(pix.expiresAt),
              qrCode: typeof pix.qrCode === 'string' ? pix.qrCode : undefined,
            }
          : undefined,
      },
    };

    logPedido({ evento: 'criado', order_id: ack.id, number: ack.number, status: ack.status, total: ack.total, method: ack.payment.method });
    return ack;
  }

  async get(id: string): Promise<Order | undefined> {
    const { httpStatus, body } = await chamar(`/public/loja/pedido/${encodeURIComponent(id)}`, {
      method: 'GET',
      timeoutMs: TIMEOUT_LEITURA_MS,
    });

    if (httpStatus === 404 || body.ok === false) return undefined;
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new OrderStoreError(`backend respondeu ${httpStatus} ao buscar pedido`, ERRO_PADRAO);
    }
    return normalizarOrder(body.order);
  }

  async status(id: string): Promise<OrderStatusSnapshot | undefined> {
    const { httpStatus, body } = await chamar(`/public/loja/pedido/${encodeURIComponent(id)}/status`, {
      method: 'GET',
      timeoutMs: TIMEOUT_LEITURA_MS,
    });

    if (httpStatus === 404 || body.ok === false) return undefined;
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new OrderStoreError(`backend respondeu ${httpStatus} ao consultar status`, ERRO_PADRAO);
    }

    return {
      status: asStatus(body.status),
      paidAt: typeof body.paidAt === 'string' ? body.paidAt : undefined,
    };
  }
}

/**
 * Trilha estruturada no stdout — o Vercel guarda de forma durável e é como se
 * cruza "a cliente diz que pagou" com "o pedido existe lá". Sem PII: id,
 * número e valor bastam; nome, e-mail e CPF NUNCA entram em log de aplicação.
 */
function logPedido(dados: Record<string, unknown>): void {
  console.log(JSON.stringify({ tag: 'order_event', at: new Date().toISOString(), ...dados }));
}

const store: OrderStore = new BackendOrderStore();

export function getOrderStore(): OrderStore {
  return store;
}
