import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { computePersonKeyFromCpf } from '../customers/customer-aggregation.helper';
import { montarComplementoBairroWc, montarNumeroWc } from '../common/endereco-wc';
import { transportadoraParaCliente } from '../common/transportadora-cliente';
import { localBrPhone } from '../lib/phone-br';
import { CarrinhoGuardService, ItemRecusado, MotivoRecusa } from './carrinho-guard.service';
import { CupomService } from './cupom.service';
import { FreteService } from './frete.service';
import { PersonIdentityService } from '../person-identity/person-identity.service';
import { PedidoEmailService } from './pedido-email.service';
import { ProgressiveDiscountService, DiscountResult } from '../progressive-discount/progressive-discount.service';
import { RiscoChavesService } from '../risco/risco-chaves.service';
import { RiscoService } from '../risco/risco.service';
import { EscudoCheckoutService } from './escudo-checkout.service';

/**
 * PEDIDO DO E-COMMERCE NOVO (sprint 011).
 *
 * O pedido da loja nasce AQUI, no Postgres do Flow, no MESMO trilho do pedido
 * do site/live: vira um `Order` com `source='ecommerce'`, cai na tela Pedidos &
 * Separação quando o pagamento confirma, e a matriz roteia igual a qualquer
 * outro. Nada de tabela paralela — quem já sabe ler Order (roteamento,
 * separação, etiqueta, NF-e, DRE, faturamento) passa a ver o e-commerce novo
 * de graça.
 *
 * DECISÕES QUE VALEM COMENTÁRIO:
 *
 *  1. `wcOrderId` é sintético na faixa 950M+ (LOJA_WC_ID_BASE). O campo é
 *     `@unique Int` herdado do WooCommerce e a casa já resolveu isso pra live
 *     (900M+). Faixas separadas = dá pra saber a origem só olhando o número,
 *     e nenhum sync do WC nunca vai colidir (pedido real do WC é < 1M).
 *
 *  2. Sequência tirada do MAIOR wcOrderId da faixa, não de `count()`. A live
 *     usa count() porque nunca apaga pedido; aqui o cartão RECUSADO apaga o
 *     Order (a spec manda "não cria pedido"), e count() regrediria — o
 *     próximo pedido reusaria o número LP-xxxx do apagado. max+1 é monotônico.
 *
 *  3. Pagamento: reusa o `PagarmeService` que já roda o PDV/live. PIX sai
 *     inteiro pelo `createPixCharge` (inclusive o polling do QR, que a API v5
 *     gera async). Cartão não tem método pronto lá, então a cobrança é montada
 *     aqui — mas grava o MESMO `PagarmePayment`, então o webhook público que
 *     já existe (`POST /pagarme/webhook`, HMAC) enxerga os dois.
 *
 *  4. Confirmação de pagamento é SEMPRE por `confirmarPagamento()` —
 *     idempotente. Webhook repete, e repete MESMO. Cartão aprovado chama
 *     direto (síncrono) e o webhook que chega depois vira no-op. Cartão EM
 *     ANÁLISE (antifraude) NÃO chama: fica `awaiting_payment` como um PIX e o
 *     webhook/reconcile fecha — nunca é tratado como recusa (17/08).
 *
 *  5. **O DINHEIRO É RECALCULADO AQUI, DO ZERO** (bloco A da lista de
 *     lançamento, 04/08). Nada que chega no corpo do POST vira cobrança sem
 *     passar pelo `reprecificar()`: preço vem do catálogo (`CarrinhoGuard`),
 *     desconto vem da regra do banco (`CupomService`), o Pix ganha os 5% que
 *     a vitrine anuncia e o total é somado de novo. O que o site mandou serve
 *     só de TETO — se a nossa conta der mais que a dele, ninguém é cobrado a
 *     mais: o pedido é recusado e a cliente recarrega a página.
 */

/* ─────────────────────────────── CONTRATO ─────────────────────────────── */

export interface LojaCustomerInput {
  name: string;
  email: string;
  /** Só dígitos. */
  cpf: string;
  /** Só dígitos, com DDD. */
  phone: string;
}

export interface LojaAddressInput {
  cep: string;
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  uf: string;
}

export interface LojaShippingInput {
  id: string;
  /** correios | transportadora | expressa | retirada */
  kind: string;
  label: string;
  /** Em REAIS. 0 = grátis. */
  price: number;
  etaDays?: { min: number; max: number };
  /** Slug da loja quando kind='retirada'. */
  storeSlug?: string;
  storeLabel?: string;
}

export interface LojaItemInput {
  productId: string;
  sku: string;
  slug: string;
  name: string;
  size: string;
  color?: string;
  quantity: number;
  /** Em REAIS. */
  unitPrice: number;
  /**
   * REF da peça, preenchida pelo GUARD (não vem do carrinho). É o que a loja
   * usa pra achar a peça na arara — o `sku` vira o código do ERP logo abaixo.
   */
  ref?: string;
}

export interface LojaTrackingInput {
  anonymous_id?: string;
  session_id?: string;
  fbp?: string;
  fbc?: string;
  /**
   * Cookies do gtag do GA4 (`_ga` e `_ga_<sufixo>`) — o `fbp`/`fbc` do Google.
   *
   * Guardados no pedido porque o `purchase` é emitido pelo site QUANDO O
   * PAGAMENTO CONFIRMA, e nessa hora não há navegador aberto pra ler cookie.
   * Sem eles o GA4 abre um usuário novo, a compra vira tráfego direto e a
   * importação pro Google Ads não acha clique nenhum pra creditar — foi o que
   * deixou a conta 10 dias com zero compras medidas depois de 19/08/2026.
   * Mesmo tipo de buraco do `gclid` e do `recovery_consent` abaixo: o dado
   * viaja, o tipo não o conhece, e a feature nunca liga.
   */
  ga4_client_id?: string;
  ga4_session_id?: string;
  attribution?: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    id?: string;
    /**
     * `gclid` — o id do clique do Google Ads. Chegava desde sempre dentro deste
     * mesmo objeto (o `captureAttribution()` do site já o inclui) e sumia aqui,
     * porque a interface não o declarava. Mesmo tipo de buraco do
     * `recovery_consent` logo abaixo: o dado viaja, o tipo não o conhece, e a
     * feature que depende dele nunca liga — sem erro nenhum.
     */
    gclid?: string;
  };
  /**
   * Opt-in de WhatsApp, vindo da etapa 1 do checkout.
   *
   * ELE NÃO EXISTIA AQUI, e isso desligou uma feature inteira em silêncio:
   * `PixResgateCron.temConsentimento()` exige
   * `JSON.parse(trackingInfo).recovery_consent === true` pra mandar o
   * lembrete de PIX não pago. Como o campo nunca era copiado pro
   * `trackingInfo`, a condição era SEMPRE falsa — zero lembretes enviados
   * desde 15/08, quando a feature nasceu. O BFF já tinha sido consertado
   * pra não podar essa chave; o backend repodava logo depois.
   */
  recovery_consent?: boolean;
}

export interface CriarPedidoInput {
  customer: LojaCustomerInput;
  shippingAddress?: LojaAddressInput;
  /** CEP digitado na cotação — vem mesmo na retirada (sem endereço completo). */
  cep?: string;
  shipping: LojaShippingInput;
  items: LojaItemInput[];
  couponCode?: string;
  /** Todos em REAIS. */
  subtotal: number;
  discount: number;
  shippingPrice: number;
  total: number;
  payment: {
    method: 'pix' | 'card';
    installments?: number;
    cardToken?: string;
  };
  tracking?: LojaTrackingInput;
  /**
   * IP REAL DA CLIENTE, repassado pelo controller (`x-cliente-ip`).
   *
   * Sempre existiu no caminho e morria no rate-limit. Guardar é o que
   * permite responder "estes dois pedidos com CPF diferente saíram da mesma
   * conexão" — ver `Order.clienteIp`.
   */
  clienteIp?: string;
  /**
   * PAÍS DO IP (`x-cliente-pais`, BFF ← `x-vercel-ip-country` da Vercel).
   * Sinal do escudo anti-teste-de-cartão: a loja só entrega no Brasil e a
   * botnet de 28/08 era ~toda estrangeira. Ausente = passa (site antigo).
   */
  clientePais?: string;
}

/**
 * O QUE SOBRA DA COBRANÇA NO CARTÃO — sem PAN, sem CVV, sem validade.
 *
 * Vai pra dentro do `Order.paymentInfo` (chave `transacao`), que é a
 * convenção da casa pra dado de gateway. Serve a dois donos: o dossiê de
 * contestação (que precisa de autorização/NSU/antifraude) e o módulo de
 * risco (que cruza cartão e titular entre pedidos).
 */
export interface DadosTransacao {
  ultimos4: string | null;
  bandeira: string | null;
  titular: string | null;
  tid: string | null;
  nsu: string | null;
  autorizacao: string | null;
  status: string | null;
  codigoRetorno: string | null;
  antifraudeStatus: string | null;
  antifraudeScore: number | null;
  capturadoEm: string;
}

/** Resposta do POST — `ok:false` sempre vem com mensagem pronta pra cliente. */
export type CheckoutErrorCode =
  | 'card_declined'
  | 'catalog_unavailable'
  | 'coupon_invalid'
  | 'shipping_invalid'
  | 'shipping_changed'
  | 'validation_error'
  | 'rate_limited'
  | 'payment_unavailable'
  | 'internal_error';

export interface CriarPedidoResult {
  ok: boolean;
  error?: string;
  code?: CheckoutErrorCode;
  order?: any;
  /**
   * Só em `catalog_unavailable` por PREÇO: a linha da sacola que subiu e o
   * preço que vale agora, pra o site corrigir a linha e a cliente não cair no
   * loop "atualize a página" (que não atualizava o preço congelado no
   * localStorage). Opcional — site antigo ignora, site novo tolera ausência.
   */
  item?: ItemRecusado;
  /**
   * Só em `shipping_changed`: a cotação que vale agora (só o frete subiu entre
   * a tela e o pedido). O site atualiza a entrega e pede pra confirmar — em
   * vez do beco "atualize a página". Opcional pelo mesmo motivo do `item`.
   */
  quote?: { id: string; label: string; price: number; etaDays: { min: number; max: number } | null };
  /**
   * POR QUE recusou, em código — e em qual REF (22/08).
   *
   * O `code` diz a FAMÍLIA do erro: `catalog_unavailable` sozinho cobre SETE
   * causas (preço zerado, preço que subiu, cor sumiu, tamanho sumiu, peça
   * despublicada, esgotou, estoque insuficiente). O `motivo` diz qual delas.
   *
   * Vai pro `checkout_error` do funil, NÃO pra tela da cliente — a frase dela
   * já vem pronta em `error`. Sem isto, a tela de Alertas mostra "Produto,
   * estoque ou preço alterado" e ninguém consegue dizer o que aconteceu:
   * descobrir que a causa era reserva velha de pedido parado exigiu refazer a
   * conta do guard na mão, direto no banco (22/08).
   */
  motivo?: MotivoRecusa;
  ref?: string;
  /**
   * Só em `estoque_insuficiente`: QUANTAS peças sobraram.
   *
   * O site usa pra oferecer "deixar N e continuar" DENTRO do checkout, em vez
   * de mandar a cliente sair, abrir a sacola, achar a peça e ajustar na mão —
   * o caminho que produziu 151 tentativas de pagar em 41 sessões (31/08).
   */
  disponivel?: number;
}

/* ─────────────────────────────── SERVICE ──────────────────────────────── */

@Injectable()
export class LojaOrdersService {
  private readonly logger = new Logger(LojaOrdersService.name);

  /** Base dos wcOrderId sintéticos da LOJA (live usa 900M, WC real usa < 1M). */
  private static readonly LOJA_WC_ID_BASE = 950_000_000;

  /** Validade do PIX. 30min é o que a cliente aguenta esperar sem desistir. */
  /**
   * Validade do PIX: 24 HORAS (dono, 17/08 — era 2h, e antes 30 min).
   *
   * 30 minutos derrubava compra boa: cliente que abre o QR, sai pra pegar o
   * celular do banco e volta, já achava o código vencido. As 2 horas de
   * 04/08 cobriam o "pago quando chegar em casa", mas não o caso mais comum
   * da loja: quem monta a sacola à noite e paga no dia seguinte.
   *
   * ⚠️ A VALIDADE TAMBÉM SEGURA ESTOQUE. O `CarrinhoGuardService` reserva a
   * peça de quem gerou PIX enquanto o código vale (ver `HORAS_PENDENTE`).
   * Em 24h, um PIX gerado e nunca pago tira a peça da vitrine por um dia.
   * É a troca aceita: PIX não pago é recuperável (temos nome, telefone e
   * CPF); venda perdida por código vencido não é. Se começar a faltar peça
   * na vitrine com estoque na arara, é aqui que se mexe.
   *
   * Por env pra poder voltar sem deploy.
   */
  private static readonly PIX_EXPIRA_MIN = Number(process.env.PIX_EXPIRA_MIN) || 1440;

  /** Tolerância do recálculo: 1 centavo (arredondamento de float no front). */
  private static readonly TOLERANCIA = 0.011;

  /**
   * DESCONTO DO PIX — 5% (dono, 06/08).
   *
   * O site anuncia "no Pix por R$ X" no card, na PDP, na busca e com a badge
   * "5% off já aplicado" no checkout — e até aqui NINGUÉM aplicava: a cliente
   * lia o preço Pix e pagava o cheio. Agora o abate é feito no servidor, sobre
   * o subtotal já descontado do cupom, e vai discriminado na resposta pra tela
   * mostrar a mesma conta que a cobrança.
   *
   * `SITE_PIX_DESCONTO_PCT=0` desliga sem deploy.
   */
  private static pixDescontoPct(): number {
    const raw = process.env.SITE_PIX_DESCONTO_PCT;
    const n = raw == null || raw === '' ? 5 : Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 50 ? n : 5;
  }

  /** Teto de sanidade do frete: acima disso é erro de cotação, não entrega. */
  private static readonly FRETE_TETO = 400;

  /**
   * Cartão que NÃO chegou na operadora (erro de integração com a Pagar.me).
   * A frase NÃO manda trocar de cartão — o cartão não tem culpa — e diz o que
   * acontece se a cobrança tiver passado mesmo assim: como a order é
   * procurada pelo `code` antes de desistir (`procurarOrderPagarmePorCode`),
   * a que existir fica registrada e o webhook/reconcile confirma sozinho.
   */
  private static readonly MSG_CARTAO_INDISPONIVEL =
    'Não conseguimos processar o cartão agora — foi uma falha na comunicação com a operadora, não no seu cartão. ' +
    'Tente de novo em instantes ou pague com PIX. Se aparecer uma cobrança no seu extrato, o pedido é confirmado automaticamente. 💜';

  private readonly BASE_URL = 'https://api.pagar.me/core/v5';

  /** Cache das lojas pra resolver storeSlug→code sem bater no banco a cada pedido. */
  private lojasCache: { at: number; rows: Array<{ code: string; name: string; city: string | null }> } | null = null;
  private static readonly LOJAS_CACHE_TTL = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly pagarme: PagarmeService,
    private readonly guard: CarrinhoGuardService,
    private readonly cupons: CupomService,
    private readonly frete: FreteService,
    private readonly identity: PersonIdentityService,
    private readonly pedidoEmail: PedidoEmailService,
    private readonly progressiveDiscount: ProgressiveDiscountService,
    private readonly riscoChaves: RiscoChavesService,
    private readonly risco: RiscoService,
    private readonly escudo: EscudoCheckoutService,
  ) {}

  /* ───────────────────────── helpers de formato ───────────────────────── */

  private digits(v: any): string {
    return String(v ?? '').replace(/\D/g, '');
  }

  /**
   * Telefone SEM o DDI 55 — em tudo que o pedido guarda. A cliente que colava
   * "+55 11 …" no checkout gravava "55119959582" (a máscara antiga cortava em
   * 11 dígitos e o DDI engolia o fim do número). A máscara do site foi
   * consertada, mas aba velha aberta ainda manda o formato antigo por dias.
   */
  private fone(v: any): string {
    return localBrPhone(v);
  }

  private dinheiro(v: any): number {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  /**
   * Máscara de CPF do GET público: `***.***.**9-10`. Só os 3 últimos dígitos
   * aparecem — o suficiente pra cliente reconhecer o próprio pedido, longe de
   * ser um documento reutilizável por quem pescar a URL.
   */
  private mascararCpf(cpf?: string | null): string | null {
    const d = this.digits(cpf);
    if (d.length !== 11) return null;
    return `***.***.**${d[8]}-${d.slice(9)}`;
  }

  /** Slug canônico: sem acento, minúsculo, não-alfanumérico vira hífen. */
  private slugify(v: any): string {
    return String(v ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // marcas de acento soltas pelo NFD
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private parseJson<T>(raw: any, fallback: T): T {
    if (!raw) return fallback;
    try {
      return JSON.parse(String(raw)) as T;
    } catch {
      return fallback;
    }
  }

  /* ─────────────────────── validação e recálculo ──────────────────────── */

  /**
   * FORMATO — só o que dá pra conferir sem sair do processo: dados da cliente,
   * itens com quantidade, endereço, meio de pagamento.
   *
   * O DINHEIRO NÃO SE DECIDE AQUI. Preço, desconto e total são refeitos do
   * zero em `reprecificar()`, contra o catálogo e a tabela de cupons. Esta
   * função só garante que o pedido tem forma de pedido antes de gastar uma ida
   * ao banco.
   *
   * Retorna a mensagem de erro (elegante) ou null se está tudo certo.
   */
  private validar(input: CriarPedidoInput): string | null {
    if (!input?.customer) return 'Faltaram os seus dados de contato — pode preencher de novo?';
    const cpf = this.digits(input.customer.cpf);
    if (cpf.length !== 11) return 'O CPF informado não parece completo. Confere pra gente?';
    if (!String(input.customer.name || '').trim()) return 'Faltou o seu nome no cadastro.';
    /**
     * E-mail de verdade, não `includes('@')`.
     *
     * A checagem antiga aceitava "a@b": passava no checkout e a confirmação de
     * compra nunca chegava — a cliente pagava e ficava sem nada no e-mail. E é
     * o mesmo endereço que vai pro antifraude do cartão, que pontua endereço
     * malformado como sinal de fraude.
     */
    const email = String(input.customer.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email) || email.length > 120) {
      return 'O e-mail informado não parece válido.';
    }
    if (this.fone(input.customer.phone).length < 10) return 'O telefone precisa vir com DDD.';

    if (!Array.isArray(input.items) || input.items.length === 0) {
      return 'Sua sacola está vazia.';
    }
    for (const it of input.items) {
      if (!it?.sku || !Number(it.quantity) || Number(it.quantity) < 1) {
        return 'Um dos itens da sacola veio incompleto. Pode montar a sacola de novo?';
      }
      if (!(Number(it.unitPrice) > 0)) {
        return 'Um dos itens está sem preço. Atualize a página e tente de novo.';
      }
    }

    if (!input.shipping?.id || !input.shipping?.kind) return 'Escolha uma forma de entrega.';
    const retirada = input.shipping.kind === 'retirada';
    if (!retirada) {
      const e = input.shippingAddress;
      if (!e || this.digits(e.cep).length !== 8 || !String(e.street || '').trim() || !String(e.city || '').trim()) {
        return 'Precisamos do endereço completo pra entregar o seu pedido.';
      }
    }

    if (input.payment?.method !== 'pix' && input.payment?.method !== 'card') {
      return 'Forma de pagamento não disponível.';
    }
    if (input.payment.method === 'card' && !String(input.payment.cardToken || '').trim()) {
      return 'Não conseguimos ler os dados do cartão. Tente preencher novamente.';
    }

    const T = LojaOrdersService.TOLERANCIA;
    const frete = this.dinheiro(input.shippingPrice);

    // O frete cotado tem que ser o mesmo que entra no total.
    if (Math.abs(this.dinheiro(input.shipping.price) - frete) > T) {
      return 'O frete mudou desde a cotação. Recalcule a entrega e tente de novo.';
    }
    // Frete negativo ou absurdo é erro de cotação, não entrega cara.
    if (frete < 0 || frete > LojaOrdersService.FRETE_TETO) {
      this.logger.warn(`[loja] frete fora da faixa: ${frete.toFixed(2)}`);
      return 'Não conseguimos confirmar o valor do frete. Recalcule a entrega e tente de novo. 💜';
    }
    if (this.dinheiro(input.total) <= 0) return 'O valor do pedido ficou inválido. Confira a sacola.';

    return null;
  }

  /* ─────────────────────────── REPRECIFICAÇÃO ─────────────────────────── */

  /**
   * REFAZ O PEDIDO INTEIRO com os números da casa (itens 1 a 6).
   *
   * Ordem, e o porquê de cada passo:
   *
   *  1. **Catálogo** (`CarrinhoGuard`) — preço, estoque e publicação de cada
   *     peça. É aqui que morre o "token vazado compra por R$ 1".
   *  2. **Cupom** (`CupomService`) — recalculado do banco, nunca aceito pronto.
   *     Cupom de frete zera o econômico (`kind='correios'`), igual à sacola.
   *  3. **Pix** — os 5% que a vitrine anuncia, sobre o subtotal já descontado.
   *  4. **Total** — somado do zero.
   *
   * TETO, NÃO ESPELHO: o total que o site mandou não precisa bater na vírgula,
   * mas a NOSSA conta nunca pode passar dele. Cobrar mais do que a cliente leu
   * na tela é o erro que não se desfaz com pedido de desculpas.
   */
  private async reprecificar(input: CriarPedidoInput): Promise<
    | { ok: false; erro: string; code: CheckoutErrorCode; item?: ItemRecusado; motivo?: MotivoRecusa; ref?: string; disponivel?: number; quote?: CriarPedidoResult['quote'] }
    | {
        ok: true;
        subtotal: number;
        descontoCupom: number;
        descontoPix: number;
        descontoPromocao: number;
        frete: number;
        total: number;
        couponCode: string | null;
        promocao: DiscountResult | null;
      }
  > {
    // 1) Preço, estoque e publicação, peça a peça.
    const conferencia = await this.guard.conferir(input.items as any);
    if (!conferencia.ok) {
      // `item` só existe na recusa por preço — vai junto pro site corrigir a
      // linha da sacola (ver `ItemRecusado` no guard).
      return {
        ok: false,
        erro: conferencia.erro,
        code: 'catalog_unavailable',
        // A causa exata e a peça, pro funil (22/08) — `code` sozinho junta
        // sete recusas diferentes num rótulo só.
        motivo: conferencia.motivo,
        ...(conferencia.ref ? { ref: conferencia.ref } : {}),
        ...(typeof conferencia.disponivel === 'number' ? { disponivel: conferencia.disponivel } : {}),
        ...(conferencia.item ? { item: conferencia.item } : {}),
      };
    }

    for (const c of conferencia.itens) {
      // O preço COBRADO passa a ser o do catálogo, item a item — inclusive no
      // snapshot que vai pro OrderItem e pro evento de compra.
      input.items[c.indice].unitPrice = c.precoCatalogo;

      /**
       * 🔴 O SKU VIRA O CÓDIGO DO ERP (corrigido 06/08, com o primeiro pedido
       * real na tela de separação).
       *
       * O carrinho manda `sku = product.id`, que é a **REF** ("VOGUE"). REF
       * não é código de peça: o estoque, a etiqueta e o bipe da loja falam
       * `codigo` — o número que identifica REF+COR+TAMANHO. Resultado no
       * pedido `#LP-000002`: **"faltam 1 SKU(s) sem estoque em nenhuma loja"**
       * numa peça que TINHA estoque. O roteamento procurou por "VOGUE" e não
       * achou, porque esse código não existe em lugar nenhum.
       *
       * O guard já resolvia a variação exata pra conferir preço e estoque —
       * faltava gravar o código que ele encontrou. Sem isso, todo pedido do
       * site nasce impossível de separar.
       *
       * `codigo` vem nulo quando a variação não é única (peça sem cor
       * escolhida): aí mantemos a REF, que pelo menos é rastreável na mão.
       */
      if (c.codigo) input.items[c.indice].sku = c.codigo;

      /**
       * A REF vem junto (13/08). O `sku` acima é o CÓDIGO — sete dígitos que
       * ninguém lê na loja. Quem separa procura pela REF, e o pedido do site
       * era o único canal que não mostrava a dela em lugar nenhum.
       */
      if (c.ref) input.items[c.indice].ref = c.ref;
    }
    const subtotal = this.dinheiro(conferencia.subtotal);

    // A promoção é calculada somente depois da conferência autoritativa de
    // preço e estoque. O cliente nunca informa qual peça deve ficar grátis.
    const promocao = await this.progressiveDiscount.calculate(
      input.items.map((item) => ({
        productId: item.productId,
        qty: Number(item.quantity) || 1,
        unitPrice: this.dinheiro(item.unitPrice),
      })),
    );
    const descontoPromocao = promocao.applied ? this.dinheiro(promocao.discountValue) : 0;

    // 2) Cupom recalculado (item 3).
    let descontoCupom = 0;
    let couponCode: string | null = null;
    let freteGratisPorCupom = false;
    if (input.couponCode) {
      if (promocao.applied) {
        return {
          ok: false,
          erro: 'A promoção Leve 4, Pague 3 já oferece a peça de menor valor grátis e não acumula com cupom.',
          code: 'coupon_invalid',
        };
      }
      const r = await this.cupons.aplicar(input.couponCode, subtotal, {
        cpf: this.digits(input.customer.cpf),
      });
      if (!r.ok) return { ok: false, erro: r.mensagem, code: 'coupon_invalid' };
      descontoCupom = this.dinheiro(r.desconto);
      couponCode = r.code;
      freteGratisPorCupom = r.tipo === 'shipping';
    }

    /**
     * FRETE RECOTADO AQUI (item 2 — "revalidar o frete no servidor").
     *
     * Retirada é sempre grátis e não tem o que conferir. Entrega recota pela
     * MESMA tabela que a tela mostrou: se a opção escolhida não existe mais
     * (id inventado, promoção que venceu entre o carrinho e o pagamento), o
     * pedido não fecha; se o preço mudou, vale o NOSSO.
     *
     * Cotação fora do ar não derruba a venda: o `FreteService` já cai na
     * estimativa interna, então `conferir` só devolve null quando a opção
     * realmente não existe.
     */
    let frete = this.dinheiro(input.shippingPrice);
    // O frete que a TELA mostrou — guardado antes de recotar, pro TETO lá
    // embaixo distinguir "só o frete subiu" de "peça/cupom mudou".
    const freteInformado = frete;
    if (input.shipping.kind !== 'retirada') {
      const pecas = input.items.reduce((s, it) => s + (Number(it.quantity) || 1), 0);
      const opcao = await this.frete
        .conferir({
          cep: this.digits(input.shippingAddress?.cep),
          subtotal,
          pecas,
          quoteId: input.shipping.id,
        })
        .catch(() => null);

      if (!opcao) {
        this.logger.warn(`[loja] opção de frete "${input.shipping.id}" não existe mais na cotação`);
        return {
          ok: false,
          erro: 'A opção de entrega que você escolheu não está mais disponível. Volte uma etapa e escolha de novo. 💜',
          code: 'shipping_invalid',
        };
      }
      if (Math.abs(opcao.price - frete) > LojaOrdersService.TOLERANCIA) {
        this.logger.warn(
          `[loja] frete divergente: site=${frete.toFixed(2)} nosso=${opcao.price.toFixed(2)} (${input.shipping.id})`,
        );
      }
      frete = opcao.price;
      input.shipping.label = opcao.label || input.shipping.label;
      input.shipping.etaDays = opcao.etaDays;
    } else {
      frete = 0;
    }

    // Cupom de frete zera o ECONÔMICO — quem escolheu expresso paga expresso.
    if (freteGratisPorCupom && input.shipping.kind === 'correios') frete = 0;

    // 3) Pix — o desconto que a vitrine já anunciava.
    const pct = LojaOrdersService.pixDescontoPct();
    const baseComDesconto = Math.max(0, subtotal - descontoCupom - descontoPromocao);
    const descontoPix =
      input.payment?.method === 'pix' && pct > 0 && !promocao.applied
        ? this.dinheiro((baseComDesconto * pct) / 100)
        : 0;

    // 4) Total do zero.
    const total = this.dinheiro(subtotal - descontoCupom - descontoPix - descontoPromocao + frete);
    if (total <= 0) {
      this.logger.warn(`[loja] total recalculado <= 0 (subtotal=${subtotal} cupom=${descontoCupom})`);
      return {
        ok: false,
        erro: 'O valor do pedido ficou inválido. Confira a sacola e tente de novo. 💜',
        code: 'validation_error',
      };
    }

    // TETO: nunca cobrar acima do que a cliente viu.
    const informado = this.dinheiro(input.total);
    if (informado > 0 && total > informado + LojaOrdersService.TOLERANCIA) {
      this.logger.warn(
        `[loja] recálculo acima do informado: nosso=${total.toFixed(2)} site=${informado.toFixed(2)} ` +
          `(subtotal=${subtotal.toFixed(2)} cupom=${descontoCupom.toFixed(2)} pix=${descontoPix.toFixed(2)} frete=${frete.toFixed(2)})`,
      );
      /**
       * SÓ O FRETE SUBIU (17/08) — é troca de frete, não sacola mudada.
       *
       * Caso: o BFF cotou pela tabela local (backend lento/429 → `estimado`)
       * com PAC 14,90; aqui a recotação real deu 17,90. Peças e cupom batem
       * — a diferença é TODA do frete. Responder "os valores da sacola
       * mudaram, atualize a página" era beco sem saída: F5 recotava igual e
       * recusava de novo. Agora devolve `shipping_changed` com a cotação nova
       * — o site já trata esse code (atualiza a entrega e pede pra confirmar)
       * e o próximo Finalizar passa. Compara a parte SEM frete dos dois lados
       * com a mesma tolerância; se a peça/cupom também mudou, cai no
       * `catalog_unavailable` de sempre.
       */
      const nossoSemFrete = this.dinheiro(total - frete);
      const informadoSemFrete = this.dinheiro(informado - freteInformado);
      const soFreteSubiu =
        input.shipping.kind !== 'retirada' &&
        frete > freteInformado + LojaOrdersService.TOLERANCIA &&
        Math.abs(nossoSemFrete - informadoSemFrete) <= LojaOrdersService.TOLERANCIA;
      if (soFreteSubiu) {
        return {
          ok: false,
          erro:
            `O frete pro seu CEP ficou R$ ${frete.toFixed(2).replace('.', ',')} ` +
            `(era R$ ${freteInformado.toFixed(2).replace('.', ',')}). Confira a entrega e finalize de novo — nada foi cobrado. 💜`,
          code: 'shipping_changed',
          quote: {
            id: input.shipping.id,
            label: input.shipping.label,
            price: frete,
            etaDays: input.shipping.etaDays ?? null,
          },
        };
      }
      return {
        ok: false,
        erro: 'Os valores da sacola mudaram desde que você abriu o checkout. Atualize a página e confira antes de pagar. 💜',
        code: 'catalog_unavailable',
        motivo: 'total_acima',
      };
    }
    if (informado > 0 && Math.abs(total - informado) > LojaOrdersService.TOLERANCIA) {
      this.logger.log(
        `[loja] cobrando MENOS que o informado: nosso=${total.toFixed(2)} site=${informado.toFixed(2)}`,
      );
    }

    // O input passa a carregar a conta da casa — cobrança, Order e resposta
    // leem daqui pra frente uma coisa só.
    input.subtotal = subtotal;
    input.discount = this.dinheiro(descontoCupom + descontoPix + descontoPromocao);
    input.shippingPrice = frete;
    input.shipping.price = frete;
    input.total = total;
    input.couponCode = couponCode || undefined;

    return {
      ok: true,
      subtotal,
      descontoCupom,
      descontoPix,
      descontoPromocao,
      frete,
      total,
      couponCode,
      promocao: promocao.applied ? promocao : null,
    };
  }

  /* ───────────────────────────── CRM ──────────────────────────────────── */

  /**
   * Cliente entra no CRM deduplicado por PESSOA (personKey = `cpf:<digits>`).
   *
   * REGRA DA CASA (clientes-pessoa-vs-cadastro): CPF é a PESSOA, cadastro é
   * POR LOJA. Então NUNCA fundimos Customers fisicamente — se a pessoa já tem
   * cadastro (feito na loja física, no Giga), a gente só COMPLETA o que está
   * vazio. Cadastro de loja física foi digitado por vendedora olhando
   * documento; formulário de site é a cliente com pressa. O da loja ganha.
   *
   * Falha aqui NUNCA derruba a venda (email é @unique no Customer e colisão é
   * plausível) — o pedido carrega os dados denormalizados de qualquer jeito.
   */
  private async upsertCustomer(c: LojaCustomerInput): Promise<string | null> {
    const cpf = this.digits(c.cpf);
    const personKey = computePersonKeyFromCpf(cpf);
    const nome = String(c.name || '').trim();
    const email = String(c.email || '').trim().toLowerCase() || null;
    const phone = this.fone(c.phone) || null;

    try {
      // CPF pode estar gravado com ou sem máscara (base histórica do Giga).
      const cpfFmt = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
      const existentes = await (this.prisma as any).customer.findMany({
        where: {
          OR: [
            ...(personKey ? [{ personKey }] : []),
            { cpf },
            { cpf: cpfFmt },
          ],
        },
        orderBy: { createdAt: 'asc' },
      });

      if (existentes.length) {
        // Preferência pelo cadastro de loja física (originSource='giga'), que é
        // o mais confiável; senão o mais antigo.
        const alvo = existentes.find((x: any) => x.originSource === 'giga') || existentes[0];
        const patch: any = {};
        if (!String(alvo.name || '').trim() && nome) patch.name = nome;
        if (!String(alvo.email || '').trim() && email) patch.email = email;
        if (!String(alvo.phone || '').trim() && phone) patch.phone = phone;
        if (!String(alvo.cpf || '').trim()) patch.cpf = cpf;
        if (!alvo.personKey && personKey) patch.personKey = personKey;
        if (Object.keys(patch).length) {
          await (this.prisma as any).customer.update({ where: { id: alvo.id }, data: patch });
        }
        await this.identity.linkCustomer(alvo.id).catch((error) =>
          this.logger.warn(`[loja] identidade pendente: ${error?.message || error}`),
        );
        return alvo.id;
      }

      /**
       * E-MAIL DE OUTRA PESSOA NÃO PODE CUSTAR O CADASTRO (10/08/2026).
       *
       * `Customer.email` é `@unique`, mas o CPF deixou de ser em jun/2026
       * porque a regra da casa é "CPF é a PESSOA". As duas coisas se
       * contradizem: duas pessoas de verdade dividem e-mail (família, e-mail
       * de trabalho), e quando dividem o `create` estourava violação de
       * unicidade, caía no catch e o cadastro simplesmente não acontecia. O
       * pedido seguia, então ninguém percebia.
       *
       * Foi o caso da primeira cliente de verdade a comprar no site novo: o
       * e-mail dela já pertencia a outro cadastro, e ela nunca entrou no CRM.
       *
       * Entre gravar a cliente SEM o e-mail e não gravar a cliente, o certo é
       * gravar: nome, CPF e telefone são o que faz o CRM valer, e o e-mail
       * continua no pedido (`orders.customer_email`), que é de onde ele sai
       * pra qualquer contato. Perder a pessoa é irreversível; perder o campo,
       * não.
       */
      const donoDoEmail = email
        ? await (this.prisma as any).customer.findUnique({ where: { email }, select: { id: true, name: true } })
        : null;
      if (donoDoEmail) {
        this.logger.warn(
          `[loja] e-mail ${email} já é de outro cadastro (${donoDoEmail.name || donoDoEmail.id}) — ` +
            `${nome || cpf} entra no CRM SEM e-mail`,
        );
      }

      const criado = await (this.prisma as any).customer.create({
        data: {
          name: nome || null,
          email: donoDoEmail ? null : email,
          phone,
          cpf,
          personKey,
          originSource: 'site',
        },
      });
      await this.identity.linkCustomer(criado.id).catch((error) =>
        this.logger.warn(`[loja] identidade pendente: ${error?.message || error}`),
      );
      return criado.id;
    } catch (e: any) {
      /**
       * Rede de segurança pra corrida (dois checkouts no mesmo segundo) e pra
       * qualquer OUTRO campo único que apareça no futuro: tenta de novo com o
       * mínimo. Só depois disso é que desistir vira aceitável.
       */
      if (e?.code === 'P2002') {
        try {
          const minimo = await (this.prisma as any).customer.create({
            data: { name: nome || null, phone, cpf, personKey, originSource: 'site' },
          });
          this.logger.warn(`[loja] cliente criado sem e-mail após colisão (${e?.meta?.target ?? 'unique'})`);
          return minimo.id;
        } catch (e2: any) {
          this.logger.error(`[loja] cliente NÃO entrou no CRM nem no modo mínimo: ${e2?.message || e2}`);
          return null;
        }
      }
      this.logger.error(`[loja] cliente não gravado no CRM (pedido segue): ${e?.message || e}`);
      return null;
    }
  }

  /* ──────────────────────── retirada em loja ──────────────────────────── */

  /**
   * storeSlug do e-commerce ('analia-franco', 'itanhaem'...) → `Store.code`.
   * A tabela Store não tem slug: o e-commerce nasceu com os slugs em
   * `src/data/stores.ts` e o Flow identifica loja por code/nome. Casamos por
   * slug do NOME e, como rede, por slug da CIDADE.
   * Sem match → null (o pedido vira entrega normal e a matriz resolve; melhor
   * do que travar a venda por causa de um slug novo).
   */
  private async resolvePickupStoreCode(slug?: string): Promise<{ code: string; name: string } | null> {
    const alvo = this.slugify(slug);
    if (!alvo) return null;

    if (!this.lojasCache || Date.now() - this.lojasCache.at > LojaOrdersService.LOJAS_CACHE_TTL) {
      try {
        const rows = await (this.prisma as any).store.findMany({
          where: { active: true },
          select: { code: true, name: true, city: true },
        });
        this.lojasCache = { at: Date.now(), rows };
      } catch (e: any) {
        this.logger.warn(`[loja] não consegui listar lojas pra retirada: ${e?.message || e}`);
        return null;
      }
    }

    const rows = this.lojasCache.rows;
    const porNome = rows.find((s) => this.slugify(s.name) === alvo);
    if (porNome) return { code: porNome.code, name: porNome.name };
    const porCidade = rows.find((s) => this.slugify(s.city) === alvo);
    if (porCidade) return { code: porCidade.code, name: porCidade.name };
    // Último recurso: slug contido no nome (ex.: 'moema' em "LURDS MOEMA").
    const parcial = rows.find((s) => this.slugify(s.name).includes(alvo));
    if (parcial) return { code: parcial.code, name: parcial.name };

    this.logger.warn(`[loja] storeSlug "${slug}" não casou com nenhuma loja ativa`);
    return null;
  }

  /* ─────────────────────── criação do Order ───────────────────────────── */

  /**
   * Próxima sequência da faixa da loja. Pega o MAIOR wcOrderId já usado (ver
   * decisão 2 no topo do arquivo) — não `count()`.
   */
  /**
   * O PRÓXIMO NÚMERO, E ELE NUNCA VOLTA.
   *
   * Era `MAX(wcOrderId)` dos pedidos existentes. Cartão recusado dá rollback e
   * o pedido não persiste — então o número voltava pra fila e a cliente
   * seguinte recebia o MESMO: em 14/08 o `LP-000012` apareceu no painel da
   * Pagar.me em três pessoas diferentes. Procurar por esse código num
   * atendimento ou numa contestação devolvia a pessoa errada.
   *
   * Agora o contador é uma linha própria, incrementada em transação e FORA da
   * vida do pedido: tentativa recusada QUEIMA o número. Buraco na numeração é
   * barato; código repetido entre clientes não é.
   *
   * A primeira chamada semeia o contador a partir do maior pedido já gravado,
   * pra numeração continuar de onde parou em vez de recomeçar do zero.
   */
  private async proximaSequencia(): Promise<number> {
    const base = LojaOrdersService.LOJA_WC_ID_BASE;

    return (this.prisma as any).$transaction(async (tx: any) => {
      const atual = await tx.lojaPedidoSequence.findFirst({ where: { id: 1 } });
      if (atual) {
        const proximo = Number(atual.lastSeq) + 1;
        await tx.lojaPedidoSequence.update({ where: { id: 1 }, data: { lastSeq: proximo } });
        return proximo;
      }

      const ultimo = await tx.order.findFirst({
        where: { source: 'ecommerce', wcOrderId: { gte: base } },
        orderBy: { wcOrderId: 'desc' },
        select: { wcOrderId: true },
      });
      const proximo = (ultimo ? Number(ultimo.wcOrderId) - base : 0) + 1;
      await tx.lojaPedidoSequence.create({ data: { id: 1, lastSeq: proximo } });
      return proximo;
    });
  }

  private numeroPedido(seq: number): string {
    return `LP-${String(seq).padStart(6, '0')}`;
  }

  /** Endereço no formato do WooCommerce — é o shape que os cards da loja e a
   *  impressão de etiqueta/separação já sabem ler (mesmo da live). */
  private montarShippingWc(input: CriarPedidoInput) {
    const e = input.shippingAddress;
    const partesNome = String(input.customer.name || '').trim().split(/\s+/);
    return {
      first_name: partesNome[0] || '',
      last_name: partesNome.slice(1).join(' '),
      address_1: e ? [e.street, e.number].filter(Boolean).join(', ') : '',
      // Complemento e bairro em campos SEPARADOS. Juntos no `address_2` (como
      // era), a etiqueta dos Correios saía com "Apto 42 - Centro" no
      // complemento e o bairro vazio.
      ...montarComplementoBairroWc(e?.complement, e?.neighborhood),
      ...montarNumeroWc(e?.number),
      city: e?.city || '',
      state: (e?.uf || '').toUpperCase().slice(0, 2),
      postcode: this.digits(e?.cep),
      phone: this.fone(input.customer.phone),
    };
  }

  private async criarOrder(
    input: CriarPedidoInput,
    pickup: { code: string; name: string } | null,
    conta?: {
      descontoCupom: number;
      descontoPix: number;
      descontoPromocao?: number;
      promocao?: DiscountResult | null;
    },
  ): Promise<any> {
    const base = LojaOrdersService.LOJA_WC_ID_BASE;
    const shipping = this.montarShippingWc(input);
    const retirada = input.shipping.kind === 'retirada';
    const attr = input.tracking?.attribution || {};

    // Snapshot comercial: o que OrderItem/Order não têm campo pra guardar mas
    // o GET do pedido e o evento purchase precisam de volta, item a item.
    const checkoutInfo = {
      shipping: {
        id: input.shipping.id,
        kind: input.shipping.kind,
        label: input.shipping.label,
        price: this.dinheiro(input.shipping.price),
        etaDays: input.shipping.etaDays || null,
        storeSlug: input.shipping.storeSlug || null,
        storeLabel: input.shipping.storeLabel || pickup?.name || null,
      },
      // Endereço no formato do E-COMMERCE, não do WC. O `shippingAddress` do
      // Order é o shape do WooCommerce (address_1 = "rua, número") porque é o
      // que a separação/etiqueta lê — desmontar aquilo de volta em rua+número
      // quebra em endereço com vírgula no nome. Aqui fica o original.
      address: input.shippingAddress
        ? {
            cep: this.digits(input.shippingAddress.cep),
            street: input.shippingAddress.street,
            number: input.shippingAddress.number,
            complement: input.shippingAddress.complement || null,
            neighborhood: input.shippingAddress.neighborhood,
            city: input.shippingAddress.city,
            uf: (input.shippingAddress.uf || '').toUpperCase().slice(0, 2),
          }
        : null,
      subtotal: this.dinheiro(input.subtotal),
      discount: this.dinheiro(input.discount),
      // Desconto DISCRIMINADO: sem isto, "R$ 42,30 off" no pedido não diz se
      // foi cupom ou Pix — e é a primeira pergunta de quem confere caixa.
      descontoCupom: this.dinheiro(conta?.descontoCupom ?? 0),
      descontoPix: this.dinheiro(conta?.descontoPix ?? 0),
      descontoPromocao: this.dinheiro(conta?.descontoPromocao ?? 0),
      promocao: conta?.promocao
        ? {
            campaignCode: conta.promocao.campaignCode,
            headline: conta.promocao.tierLabel,
            freeItem: conta.promocao.freeItem,
          }
        : null,
      shippingPrice: this.dinheiro(input.shippingPrice),
      couponCode: input.couponCode || null,
      items: input.items.map((it) => ({
        productId: it.productId,
        sku: it.sku,
        ref: it.ref || it.productId || null,
        slug: it.slug,
        name: it.name,
        size: it.size,
        color: it.color || null,
        quantity: Number(it.quantity),
        unitPrice: this.dinheiro(it.unitPrice),
      })),
    };

    const trackingInfo = input.tracking
      ? {
          anonymous_id: input.tracking.anonymous_id || null,
          session_id: input.tracking.session_id || null,
          fbp: input.tracking.fbp || null,
          fbc: input.tracking.fbc || null,
          // Ver `ga4_client_id` em LojaTrackingInput: sem estas duas linhas o
          // cookie do gtag chega do site e é descartado aqui, e o purchase
          // volta a nascer sem dono.
          ga4_client_id: input.tracking.ga4_client_id || null,
          ga4_session_id: input.tracking.ga4_session_id || null,
          attribution: input.tracking.attribution || null,
          // Ver `recovery_consent` em LojaTrackingInput: sem esta linha o
          // cron de resgate do PIX não acha ninguém pra avisar.
          recovery_consent: input.tracking.recovery_consent === true,
        }
      : null;

    /**
     * FECHA O CICLO DO CARRINHO ABANDONADO.
     *
     * `checkout_recoveries.status` e `converted_at` NUNCA eram escritos —
     * o upsert da captura exclui os dois de propósito e não havia nenhum
     * outro escritor no backend inteiro. Consequência: a linha ficava
     * `active` pra sempre, e a única forma de o relatório saber que a
     * cliente comprou era um dedup em memória por `session_id`. Quando a
     * sessão virava (30 min de inatividade), a dedup não casava e quem
     * PAGOU continuava listada como abandono — a loja cobrando cliente que
     * já comprou é o pior alarme falso possível.
     *
     * Marca por sessão E por telefone: a sessão pode ter virado, o telefone
     * não muda. `updateMany` não estoura se não achar nada, e o try/catch
     * garante que uma falha aqui não derrube a criação do pedido.
     */
    const marcarCarrinhoRecuperado = async () => {
      const sessao = trackingInfo?.session_id || null;
      const fone = this.fone(input.customer?.phone);
      const alvos: any[] = [];
      if (sessao) alvos.push({ sessionId: sessao });
      if (fone.length >= 10) alvos.push({ telefone: fone });
      if (!alvos.length) return;
      try {
        await (this.prisma as any).checkoutRecovery.updateMany({
          where: { OR: alvos, status: { not: 'converted' } },
          data: { status: 'converted', convertedAt: new Date() },
        });
      } catch (e: any) {
        this.logger.warn(`[loja] não consegui marcar carrinho recuperado: ${e?.message ?? e}`);
      }
    };

    // PEÇA É PEÇA (caso LP-001005, 29/08): 2× do mesmo SKU numa linha só
    // quebrava tudo que opera POR LINHA — troca, cancelamento, rateio do
    // split entre lojas e a leitura do card. A linha de quantidade N vira N
    // linhas de 1 já no nascimento do pedido.
    const itensCreate = input.items.flatMap((it) => {
      const qtd = Math.max(1, Math.floor(Number(it.quantity) || 1));
      const linha = {
        sku: String(it.sku),
        productName: [it.name, it.color, it.size].filter(Boolean).join(' · '),
        // REF/COR/TAMANHO em colunas próprias: o `productName` já trazia cor e
        // tamanho grudados no nome, mas grudado não dá pra destacar na separação
        // nem imprimir em coluna.
        ref: it.ref || it.productId || null,
        cor: it.color || null,
        tamanho: it.size || null,
        quantity: 1,
        unitPrice: this.dinheiro(it.unitPrice),
        // No site o preço praticado JÁ é o cheio — não há tabela promocional por
        // peça como na live, então base = unitário.
        baseUnitPrice: this.dinheiro(it.unitPrice),
      };
      return Array.from({ length: qtd }, () => ({ ...linha }));
    });

    /**
     * Tudo o que descreve a COMPRA — vale igual pro pedido que nasce agora e
     * pro pedido recusado que a cliente está retentando. Fora daqui ficam só as
     * três coisas que são da PRIMEIRA tentativa e não se repetem: `wcOrderId`,
     * `wcOrderNumber` e `wcDateCreated`.
     */
    const dados: any = {
      source: 'ecommerce',
      // Enquanto não pagar, o pedido NÃO existe pra retaguarda: só vira
      // 'processing' (= fila de roteamento) quando o dinheiro entra.
      status: 'awaiting_payment',
      customerName: String(input.customer.name || '').trim() || null,
      customerEmail: String(input.customer.email || '').trim() || null,
      customerPhone: this.fone(input.customer.phone) || null,
      customerCpf: this.digits(input.customer.cpf) || null,
      shippingCep: this.digits(input.shippingAddress?.cep) || null,
      shippingAddress: JSON.stringify(shipping),
      totalAmount: this.dinheiro(input.total),
      isPickup: retirada,
      pickupStoreCode: retirada ? pickup?.code || null : null,
      shippingMethod: retirada
        ? `Retirada em loja${pickup?.name ? ` (${pickup.name})` : ''}`
        : input.shipping.label || 'Entrega',
      utmSource: attr.source || null,
      utmMedium: attr.medium || null,
      utmCampaign: attr.campaign || null,
      utmId: attr.id || null,
      utmContent: attr.content || null,
      // O `gclid` viajava no MESMO objeto de atribuição desde sempre e morria
      // aqui, porque só o `attr.id` era lido. É ele que permite devolver a
      // venda ao Google pelo servidor (`GoogleAdsConversaoService`), sem
      // depender do import do GA4 — o caminho que secou sozinho em 19/08/2026.
      gclid: attr.gclid || null,
      checkoutInfo: JSON.stringify(checkoutInfo),
      trackingInfo: trackingInfo ? JSON.stringify(trackingInfo) : null,
      // Sinal de risco, não de métrica — ver `Order.clienteIp`.
      clienteIp: input.clienteIp || null,
    };

    // RETENTATIVA RECOBRA O MESMO PEDIDO (dono, 24/08) — ver `reaproveitarRecusado`.
    const reaproveitado = await this.reaproveitarRecusado(input, dados, itensCreate);
    if (reaproveitado) {
      void marcarCarrinhoRecuperado();
      return reaproveitado;
    }

    // Retry em colisão de wcOrderId — rede de segurança que ficou de pé mesmo
    // com o contador transacional: número gravado à mão em produção ou
    // importação antiga ainda podem ocupar a faixa.
    for (let tent = 0; tent < 6; tent++) {
      // Cada tentativa pede um número NOVO ao contador — inclusive a que
      // colidiu. Somar +1 no número anterior traria de volta o problema que o
      // contador resolve: dois checkouts simultâneos chegando no mesmo LP.
      const seq = await this.proximaSequencia();
      try {
        const criado = await (this.prisma as any).order.create({
          data: {
            wcOrderId: base + seq,
            wcOrderNumber: this.numeroPedido(seq),
            wcDateCreated: new Date(),
            ...dados,
            items: { create: itensCreate },
          },
        });
        // Fora do caminho crítico: a marcação do carrinho recuperado não pode
        // atrasar nem derrubar o pedido que já existe.
        void marcarCarrinhoRecuperado();
        return criado;
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e; // P2002 = wcOrderId colidiu → próximo
      }
    }
    throw new Error('não consegui gerar o número do pedido (colisão de wcOrderId)');
  }

  /**
   * Janela em que a próxima tentativa ainda é A MESMA COMPRA.
   *
   * Curta de propósito. O `createdAt` do pedido reaproveitado NÃO é reescrito —
   * ele continua marcando quando a cliente começou — então uma janela larga
   * penduraria a venda de hoje num pedido de ontem e o relatório dataria a
   * receita no dia errado. 30 min cobre com folga a retentativa real (as 4 da
   * HELEMAR levaram 1min13s) e o caminho "recusou no cartão, paguei no Pix".
   *
   * É o MESMO número do piso da aba Carrinhos (`PIX_RESGATE_MIN`), e isso não é
   * coincidência: enquanto o pedido é reaproveitável ele está escondido da
   * lista; quando aparece lá como abandono, já não é mais retentativa. As duas
   * telas param de discordar sobre o que é "ainda tentando".
   */
  private static readonly RETRY_JANELA_MIN = 30;

  /**
   * RETENTATIVA RECOBRA O MESMO PEDIDO (dono, 24/08/2026: "RECOBRE O MESMO").
   *
   * O checkout criava um pedido NOVO a cada tentativa de pagamento. Cartão
   * recusado 3× e aprovado na 4ª deixava 3 LPs órfãos em `payment_failed` — que
   * furavam a numeração, inflavam o "não pagos" do relatório e apareciam como
   * carrinho abandonado de uma venda que TINHA fechado (HELEMAR VALIM,
   * LP-000195/196/197 → paga em LP-000198, 24/08).
   *
   * Agora a tentativa seguinte da MESMA cliente reaproveita o pedido recusado:
   * mesmo LP, dados sobrescritos pelo checkout novo (ela pode ter trocado o
   * cartão, mudado pra Pix — que muda o total pelo `descontoPix` — ou tirado uma
   * peça), e o histórico do que já falhou guardado em `paymentInfo`.
   *
   * ── AS TRÊS TRAVAS ──
   *
   * 1. SÓ `payment_failed`. Pedido `awaiting_payment` tem cobrança VIVA (Pix
   *    aberto ou cartão em análise) — recobrar por cima é o caminho da cobrança
   *    dupla, que é justamente o que a classificação em 3 estados evita.
   * 2. CLAIM ATÔMICO (`updateMany` com o status na cláusula): entre achar e
   *    reaproveitar, o webhook pode ter confirmado o pagamento daquele mesmo
   *    pedido. Se o claim não pegar 1 linha, cria pedido novo como antes.
   * 3. IDENTIDADE POR CPF. O checkout exige CPF completo (`validar`), e é a
   *    única chave que não muda entre tentativas — e-mail e telefone a cliente
   *    redigita (e erra).
   *
   * Kill-switch: `LOJA_RETRY_MESMO_PEDIDO=0` volta a criar pedido por tentativa.
   */
  private async reaproveitarRecusado(
    input: CriarPedidoInput,
    dados: any,
    itensCreate: any[],
  ): Promise<any | null> {
    if (process.env.LOJA_RETRY_MESMO_PEDIDO === '0') return null;
    const cpf = this.digits(input.customer.cpf);
    if (cpf.length !== 11) return null;

    const janelaMin = Number(process.env.LOJA_RETRY_MIN) || LojaOrdersService.RETRY_JANELA_MIN;
    const desde = new Date(Date.now() - janelaMin * 60_000);

    try {
      const alvo = await (this.prisma as any).order.findFirst({
        where: {
          source: 'ecommerce',
          status: 'payment_failed',
          paidAt: null,
          customerCpf: cpf,
          createdAt: { gte: desde },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, wcOrderNumber: true, paymentInfo: true },
      });
      if (!alvo) return null;

      let anterior: any = {};
      try {
        anterior = JSON.parse(alvo.paymentInfo || '{}');
      } catch {
        /* paymentInfo corrompido não impede a retentativa */
      }
      const tentativa = Number(anterior.tentativa || 1) + 1;
      /**
       * O histórico é o que os 3 LPs órfãos guardavam sem querer: quantas vezes
       * ela tentou e por quê falhou. Sem isto, juntar as tentativas num pedido
       * só APAGARIA a informação — o conserto viraria outro buraco.
       */
      const tentativasAnteriores = [
        ...(Array.isArray(anterior.tentativasAnteriores) ? anterior.tentativasAnteriores : []),
        {
          em: anterior.falhaEm || new Date().toISOString(),
          method: anterior.method ?? null,
          installments: anterior.installments ?? null,
          falha: anterior.falha ?? null,
          falhaTipo: anterior.falhaTipo ?? null,
          gatewayOrderId: anterior.gatewayOrderId ?? null,
        },
      ].slice(-10);

      const claim = await (this.prisma as any).order.updateMany({
        where: { id: alvo.id, status: 'payment_failed', paidAt: null },
        data: { status: 'awaiting_payment' },
      });
      if (claim.count !== 1) return null;

      // `wcDateCreated` fica com a PRIMEIRA tentativa: é quando a cliente fez o
      // pedido. Idem `createdAt`, que nem entra em `dados`.
      const { wcDateCreated: _ignora, ...dadosSemData } = dados;
      let atualizado: any;
      try {
        atualizado = await (this.prisma as any).order.update({
          where: { id: alvo.id },
          data: {
            ...dadosSemData,
            paymentInfo: JSON.stringify({ tentativa, tentativasAnteriores }),
            items: { deleteMany: {}, create: itensCreate },
          },
        });
      } catch (e: any) {
        // Devolve o pedido ao estado em que estava — senão ele fica
        // `awaiting_payment` com dados velhos, some da aba Carrinhos e espera
        // um pagamento que ninguém vai fazer.
        await (this.prisma as any).order
          .updateMany({
            where: { id: alvo.id, status: 'awaiting_payment', paidAt: null },
            data: { status: 'payment_failed' },
          })
          .catch(() => undefined);
        throw e;
      }

      this.logger.log(
        `[loja] retentativa ${tentativa} do pedido ${alvo.wcOrderNumber} (${input.payment.method}) — recobrando o MESMO pedido`,
      );
      // Viajam junto com o objeto (não são colunas): `criarPedido` os costura no
      // `paymentInfo` final e `codigoCobranca` usa a tentativa pra não repetir o
      // `code` na Pagar.me.
      atualizado.tentativa = tentativa;
      atualizado.tentativasAnteriores = tentativasAnteriores;
      return atualizado;
    } catch (e: any) {
      // Reaproveitar é otimização, não requisito: qualquer tropeço aqui volta
      // pro caminho de sempre (pedido novo) em vez de derrubar a venda.
      this.logger.warn(`[loja] retentativa no mesmo pedido falhou (${e?.message || e}) — criando pedido novo`);
      return null;
    }
  }

  /* ───────────────────────────── PAGAMENTO ────────────────────────────── */

  /**
   * Loja pela qual o dinheiro do site entra. Cai no `PagarmeStoreConfig` dessa
   * loja se houver; senão o próprio PagarmeService desce pro singleton da
   * matriz. 'SITE' é o code que a casa já usa pro canal (customers-app/DRE).
   */
  private lojaDoDinheiro(): string {
    return process.env.LOJA_PAGARME_STORE_CODE || 'SITE';
  }

  /** Config Pagar.me pra montar a cobrança de CARTÃO (o PIX vai pelo service).
   *  Duplicado de propósito: o módulo `pagarme/` é caminho crítico de PDV e
   *  live — a sprint só estende o webhook de lá, não mexe no resto. */
  private async configPagarme(storeCode: string): Promise<{ apiKey: string; recipientId?: string }> {
    try {
      const sc = await (this.prisma as any).pagarmeStoreConfig.findUnique({ where: { storeCode } });
      if (sc?.enabled && sc?.apiKey) return { apiKey: sc.apiKey, recipientId: sc.recipientId || undefined };
    } catch {
      /* tabela pode não existir em ambiente antigo — cai no singleton */
    }
    const cfg = await (this.prisma as any).pagarmeConfig.findUnique({ where: { id: 'singleton' } });
    if (!cfg?.enabled || !cfg?.apiKey) throw new Error('Pagar.me não configurado/habilitado');
    return { apiKey: cfg.apiKey, recipientId: cfg.recipientId || undefined };
  }

  private authHeader(apiKey: string): string {
    return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  }

  /** DDD + número no formato que a Pagar.me exige. */
  private telefonePagarme(raw: string): { area_code: string; number: string } {
    const d = this.digits(raw);
    if (d.length === 13 && d.startsWith('55')) return { area_code: d.slice(2, 4), number: d.slice(4) };
    if (d.length === 11 || d.length === 10) return { area_code: d.slice(0, 2), number: d.slice(2) };
    /**
     * SEM TELEFONE INVENTADO (dono, 04/08).
     *
     * Aqui devolvia `13 996218277` — o celular da matriz — pra qualquer
     * telefone que não casasse. Medido no link de pagamento das lojas em
     * 01/08: cliente sintético levou a aprovação de cartão de 63% pra 22,8%,
     * porque centenas de compras com o MESMO telefone é assinatura de fraude
     * pro modelo da Pagar.me.
     *
     * Neste caminho o `validar()` já exige telefone com DDD antes de chegar
     * aqui, então isto é caminho morto — e é justamente por isso que tinha que
     * sair: caminho morto com dado falso é mina esperando um chamador novo que
     * pule a validação. Agora estoura, alto e claro.
     */
    throw new Error(`Telefone inválido pra cobrança: "${raw}" — o checkout deveria ter barrado antes.`);
  }

  /**
   * PIX pelo `PagarmeService` (reuso puro): ele já faz split rule, retry do
   * QR (a v5 gera o charge async) e grava o `PagarmePayment` que o webhook lê.
   * `saleId` = Order.id — é essa chave que volta no webhook.
   */
  private async cobrarPix(order: any, input: CriarPedidoInput) {
    const pix = await this.pagarme.createPixCharge({
      saleId: order.id,
      valor: this.dinheiro(input.total),
      storeCode: this.lojaDoDinheiro(),
      storeName: 'SITE',
      customerName: String(input.customer.name || '').trim(),
      customerCpf: this.digits(input.customer.cpf),
      customerEmail: String(input.customer.email || '').trim(),
      customerPhone: this.fone(input.customer.phone),
      expiresInMinutes: LojaOrdersService.PIX_EXPIRA_MIN,
    });
    return {
      gatewayOrderId: pix.pagarmeOrderId,
      pix: {
        // `qrCode` vem como URL da imagem hospedada pela Pagar.me — o backend
        // NÃO gera dataURL (a dep `qrcode` não está instalada e não vale
        // adicionar por isso). Quem quiser desenhar o QR localmente usa o
        // `copyPaste`, que é o payload EMV completo.
        qrCode: pix.qrCodeImageUrl || null,
        copyPaste: pix.qrCodeText,
        expiresAt: pix.expiresAt.toISOString(),
      },
    };
  }

  /**
   * O que a operadora respondeu, em TRÊS estados — não dois.
   *
   * Até 17/08 era `aprovado = paid`, e tudo que não fosse `paid` virava
   * "cartão recusado": inclusive a cobrança EM ANÁLISE (antifraude assíncrono /
   * revisão manual, que esta conta usa e reprova bastante). A cliente lia
   * "não aprovado, tente outro cartão", pagava por PIX, e minutos depois o
   * antifraude aprovava a primeira → webhook `charge.paid` → o pedido
   * "recusado" virava pago. Duas cobranças pra uma sacola.
   *
   *  - `paid`    → dinheiro entrou; confirma na hora.
   *  - `recusa`  → a operadora DISSE não: charge `failed`/`canceled`, ou a
   *                transação em not_authorized/with_error/failed/voided.
   *  - `pending` → tudo o mais (`pending`, `processing`, análise). O pedido
   *                fica `awaiting_payment` e quem fecha é o webhook ou o
   *                `LojaPagamentoReconcileService` — nunca uma segunda
   *                cobrança da cliente.
   */
  private classificarCartao(gw: any): 'paid' | 'recusa' | 'pending' {
    const charge = (gw?.charges || [])[0];
    const orderStatus = String(gw?.status || '').toLowerCase();
    const chargeStatus = String(charge?.status || '').toLowerCase();
    const txStatus = String(charge?.last_transaction?.status || '').toLowerCase();

    if (orderStatus === 'paid' || chargeStatus === 'paid') return 'paid';
    if (['failed', 'canceled'].includes(chargeStatus)) return 'recusa';
    if (['failed', 'canceled'].includes(orderStatus)) return 'recusa';
    if (['not_authorized', 'with_error', 'failed', 'voided'].includes(txStatus)) return 'recusa';
    return 'pending';
  }

  /**
   * A ORDER QUE A GENTE NÃO VIU NASCER.
   *
   * Timeout (30s) ou 5xx no POST /orders é resposta AMBÍGUA: a Pagar.me pode
   * ter criado e cobrado — só a resposta não chegou. Declarar "falhou" nesse
   * ponto e mandar a cliente pagar por PIX é o caminho mais curto pra cobrança
   * dupla, e como o `PagarmePayment` nunca foi gravado, o webhook que chegasse
   * depois cairia em "order desconhecida".
   *
   * O corpo do POST já leva um `code` ÚNICO POR TENTATIVA (`codigoCobranca`),
   * então dá pra perguntar de volta: `GET /orders?code=`. Achou → segue
   * exatamente como se a resposta tivesse chegado. Não achou, ou o GET também
   * falhou → aí sim é erro de integração, sem cobrança do nosso lado.
   *
   * ⚠️ A unicidade do `code` é o que faz esta busca valer. Quando a retentativa
   * passou a recobrar o MESMO pedido (24/08), o LP deixou de ser único por
   * tentativa — daí o sufixo `-T2`, `-T3`. Sem ele, esta pergunta traria de
   * volta a order RECUSADA da tentativa anterior e a gente marcaria como
   * recusada uma cobrança que pode ter sido aprovada.
   *
   * Confere `code` de novo no resultado (e o `flowops_order_id` do metadata,
   * quando vier): se o filtro da API for ignorado um dia, isto não pode pegar
   * a order de outra cliente.
   */
  private async procurarOrderPagarmePorCode(apiKey: string, code: string, flowopsOrderId: string): Promise<any | null> {
    try {
      const resp = await firstValueFrom(
        this.http.get(`${this.BASE_URL}/orders`, {
          params: { code },
          headers: { Authorization: this.authHeader(apiKey), Accept: 'application/json' },
          // 3s (era 8s): esta busca roda DEPOIS do POST ambíguo e a soma tem
          // que caber nos 15s do BFF (store.ts TIMEOUT_CREATE_MS) — senão o
          // site desiste antes e a cliente lê "conexão falhou" de um pedido
          // que o backend ainda vai decidir. 10s (POST) + 3s (GET) < 15s.
          timeout: 3000,
        }),
      );
      const lista: any[] = Array.isArray(resp?.data?.data) ? resp.data.data : [];
      const achada = lista.find(
        (o) =>
          String(o?.code || '') === code &&
          (!o?.metadata?.flowops_order_id || String(o.metadata.flowops_order_id) === flowopsOrderId),
      );
      return achada || null;
    } catch (e: any) {
      this.logger.warn(`[loja] busca da order por code=${code} também falhou: ${e?.response?.status || ''} ${e?.message || e}`);
      return null;
    }
  }

  /**
   * O `code` que vai pra Pagar.me — ÚNICO POR TENTATIVA, mesmo com o pedido
   * sendo o mesmo.
   *
   * Tentativa 1 é o LP puro (é o que a cliente vê na fatura e o que a matriz
   * procura no painel do gateway). Da segunda em diante ganha `-T<n>`, porque
   * `procurarOrderPagarmePorCode` — a rede que salva o POST ambíguo — busca por
   * `code` e pegaria a tentativa velha.
   */
  private codigoCobranca(order: any): string {
    const t = Number(order?.tentativa || 1);
    return t > 1 ? `${order.wcOrderNumber}-T${t}` : String(order.wcOrderNumber);
  }

  /**
   * CARTÃO — cobrança síncrona com o token que o e-commerce já gerou no
   * navegador (o número do cartão NUNCA passa por aqui).
   *
   * Três saídas, e a diferença entre elas é dinheiro:
   *
   *  - `ok:true, status:'paid'`    → aprovado; `criarPedido` confirma na hora.
   *  - `ok:true, status:'pending'` → em análise; o pedido fica aguardando e o
   *                                  webhook/reconcile fecha (ver
   *                                  `classificarCartao`).
   *  - `ok:false, kind:'recusa'`   → a operadora disse NÃO, com transação real.
   *                                  Só aqui a cliente ouve "tente outro cartão".
   *  - `ok:false, kind:'integracao'` → falha NOSSA ou da Pagar.me (401 chave,
   *                                  422 payload, 5xx, timeout). Até 17/08 isto
   *                                  saía como "cartão recusado": no incidente
   *                                  do billing_address (14/08) 4 de 4 clientes
   *                                  leram "confira os dados do cartão" pra um
   *                                  erro de payload nosso — trocaram de cartão,
   *                                  tentaram 3×, e ninguém do nosso lado viu
   *                                  que era a gente. Agora vira
   *                                  `payment_unavailable` + log de ALERTA.
   */
  private async cobrarCartao(
    order: any,
    input: CriarPedidoInput,
  ): Promise<
    | {
        ok: true;
        status: 'paid' | 'pending';
        gatewayOrderId: string;
        gatewayChargeId: string | null;
        transacao: DadosTransacao | null;
      }
    | {
        ok: false;
        kind: 'recusa' | 'integracao';
        error: string;
        /** Motivo técnico pro `paymentInfo.falha` (nunca vai pra tela). */
        detalhe: string;
        gatewayOrderId?: string | null;
        gatewayChargeId?: string | null;
      }
  > {
    const storeCode = this.lojaDoDinheiro();
    const cfg = await this.configPagarme(storeCode);
    const codigo = this.codigoCobranca(order);
    const valorCentavos = Math.round(this.dinheiro(input.total) * 100);
    const parcelas = Math.max(1, Math.min(12, Number(input.payment.installments || 1)));
    const cpf = this.digits(input.customer.cpf);
    const end = input.shippingAddress;

    const body: any = {
      code: codigo,
      items: [
        {
          amount: valorCentavos,
          description: `Pedido ${order.wcOrderNumber} — lurdsplussize.com.br`,
          quantity: 1,
          code: order.id.slice(-12),
        },
      ],
      customer: {
        name: String(input.customer.name || '').trim().slice(0, 64),
        email: String(input.customer.email || '').trim(),
        type: 'individual',
        document: cpf,
        document_type: 'cpf',
        phones: { mobile_phone: { country_code: '55', ...this.telefonePagarme(input.customer.phone) } },
        ...(end
          ? {
              address: {
                line_1: [end.number, end.street, end.neighborhood].filter(Boolean).join(', '),
                line_2: end.complement || '',
                zip_code: this.digits(end.cep),
                city: end.city,
                state: (end.uf || '').toUpperCase().slice(0, 2),
                country: 'BR',
              },
            }
          : {}),
      },
      payments: [
        {
          payment_method: 'credit_card',
          credit_card: {
            installments: parcelas,
            statement_descriptor: 'LURDS',
            card_token: String(input.payment.cardToken),
            /**
             * BILLING_ADDRESS OBRIGATÓRIO (incidente 14/08): a Pagar.me passou
             * a exigir o endereço de cobrança no cartão — 4 de 4 tentativas do
             * dia morreram com `validation_error | billing | "value" is
             * required` SEM nenhum deploy nosso no caminho (cartão pagava às
             * 03:44, quebrou até as 13:22 com o mesmo código). O endereço de
             * entrega é o proxy padrão do titular; retirada na loja (sem
             * endereço) cai pro CEP digitado + matriz.
             */
            card: { billing_address: this.billingAddressPagarme(end, input.cep) },
          },
          ...(cfg.recipientId
            ? {
                split: [
                  {
                    recipient_id: cfg.recipientId,
                    amount: valorCentavos,
                    type: 'flat',
                    options: { charge_processing_fee: true, charge_remainder_fee: true, liable: true },
                  },
                ],
              }
            : {}),
        },
      ],
      // CHAVE DO WEBHOOK: é por aqui que o `POST /pagarme/webhook` sabe que o
      // pagamento é de um pedido do e-commerce novo (além do PagarmePayment).
      metadata: {
        flowops_order_id: order.id,
        order_number: order.wcOrderNumber,
        saleId: order.id,
        storeCode,
        source: 'lurds-loja',
      },
    };

    let gw: any = null;
    try {
      const resp = await firstValueFrom(
        this.http.post(`${this.BASE_URL}/orders`, body, {
          headers: {
            Authorization: this.authHeader(cfg.apiKey),
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          /**
           * 10s (era 30s) — 17/08. O BFF do site desiste em 15s
           * (store.ts TIMEOUT_CREATE_MS): com 30s aqui a cliente lia "a
           * conexão falhou, nada foi cobrado" enquanto o backend AINDA ia
           * receber o `paid` da Pagar.me e confirmar o pedido — ela tentava de
           * novo e nascia o segundo pedido. Estourou 10s? Cai no
           * `procurarOrderPagarmePorCode` (3s), que existe exatamente pra
           * recuperar o POST ambíguo: 10 + 3 < 15, o backend SEMPRE responde
           * antes do site desistir. A Pagar.me v5 costuma responder em 1-4s;
           * quem passa de 10s é incidente do gateway, e nesse caso a busca por
           * code é a rede.
           */
          timeout: 10000,
        }),
      );
      gw = resp?.data ?? null;
    } catch (e: any) {
      const httpStatus: number | undefined = e?.response?.status;
      const data = e?.response?.data;
      const resumo = JSON.stringify(data ?? e?.message ?? String(e)).slice(0, 400);

      /**
       * ERRO HTTP NÃO É RECUSA. 4xx/5xx/timeout aqui é problema entre a gente e
       * a Pagar.me (chave, payload, indisponibilidade) — a operadora do cartão
       * nem foi consultada. Classificar isso como "cartão recusado" mandava a
       * cliente trocar de cartão pra um erro que ela não tem como consertar.
       *
       * Não vale tentar separar "422 do payload" de "422 do cartão": a
       * tokenização é por submit e a recusa de verdade na v5 vem 2xx com
       * charge `failed` — tratada abaixo. Custa menos rotular um 4xx raro de
       * dado do cartão como "indisponível" do que o inverso.
       *
       * Sem resposta (timeout/rede) ou 5xx a Pagar.me PODE ter cobrado:
       * procura a order pelo `code` antes de declarar qualquer coisa. Achou →
       * segue o fluxo normal com ela.
       */
      const ambigua = !e?.response || (typeof httpStatus === 'number' && httpStatus >= 500);
      if (ambigua) {
        gw = await this.procurarOrderPagarmePorCode(cfg.apiKey, codigo, order.id);
        if (gw) {
          this.logger.warn(
            `[loja] cartão pedido=${order.wcOrderNumber}: POST sem resposta (HTTP ${httpStatus ?? 'timeout/rede'}) ` +
              `mas a order ${gw.id} EXISTE na Pagar.me (status=${gw.status}) — seguindo com ela`,
          );
        }
      }

      if (!gw) {
        // ERROR com marcador fixo: é o que alguém filtra no Railway pra
        // perceber que o cartão caiu POR NOSSA CAUSA, não por recusa.
        this.logger.error(
          `[loja][ALERTA] cartão: erro de integração HTTP ${httpStatus ?? 'sem resposta (timeout/rede)'} ` +
            `pedido=${order.wcOrderNumber}: ${resumo}`,
        );
        return {
          ok: false,
          kind: 'integracao',
          error: LojaOrdersService.MSG_CARTAO_INDISPONIVEL,
          detalhe: `HTTP ${httpStatus ?? 'timeout/rede'}: ${resumo}`,
        };
      }
    }

    // 2xx sem `id` de order não é resposta — sem ele o webhook e o reconcile
    // não têm por onde achar a cobrança, e "pending" viraria pedido preso.
    if (!gw?.id) {
      this.logger.error(
        `[loja][ALERTA] cartão: resposta da Pagar.me sem id de order pedido=${order.wcOrderNumber}: ${JSON.stringify(gw).slice(0, 400)}`,
      );
      return {
        ok: false,
        kind: 'integracao',
        error: LojaOrdersService.MSG_CARTAO_INDISPONIVEL,
        detalhe: `resposta sem id de order: ${JSON.stringify(gw).slice(0, 300)}`,
      };
    }

    const charge = (gw?.charges || [])[0];
    const classe = this.classificarCartao(gw);

    // Registra no MESMO PagarmePayment do PDV/live — assim a conciliação, o
    // painel de pagamentos e o webhook público enxergam a venda do site. Em
    // análise fica `pending` (não `failed`): é o que o PASSO 2 do reconcile
    // e a conciliação diária precisam ver pra ir atrás do desfecho.
    try {
      await (this.prisma as any).pagarmePayment.create({
        data: {
          saleId: order.id,
          storeCode,
          pagarmeOrderId: gw.id,
          pagarmeChargeId: charge?.id || null,
          method: 'credit_card',
          valor: this.dinheiro(input.total),
          status: classe === 'paid' ? 'paid' : classe === 'pending' ? 'pending' : 'failed',
          paidAt: classe === 'paid' ? new Date() : null,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[loja] PagarmePayment não gravado (cobrança seguiu): ${e?.message || e}`);
    }

    if (classe === 'recusa') {
      const tx = charge?.last_transaction || {};
      this.logger.warn(
        `[loja] cartão recusado pedido=${order.wcOrderNumber} order=${gw?.id} status=${gw?.status}/${charge?.status}/${tx?.status}`,
      );
      return {
        ok: false,
        kind: 'recusa',
        error: this.mensagemRecusa(gw),
        detalhe: `recusa: order=${gw?.status} charge=${charge?.status} tx=${tx?.status} ${String(tx?.acquirer_message || tx?.acquirer_return_code || '').slice(0, 120)}`.trim(),
        gatewayOrderId: gw?.id || null,
        gatewayChargeId: charge?.id || null,
      };
    }

    if (classe === 'pending') {
      this.logger.warn(
        `[loja] cartão EM ANÁLISE pedido=${order.wcOrderNumber} order=${gw?.id} status=${gw?.status}/${charge?.status}/${charge?.last_transaction?.status} ` +
          `— pedido fica awaiting_payment; webhook/reconcile fecham`,
      );
    }

    return {
      ok: true,
      status: classe,
      gatewayOrderId: gw.id,
      gatewayChargeId: charge?.id || null,
      transacao: this.extrairTransacao(charge),
    };
  }

  /**
   * Endereço de cobrança pro cartão da Pagar.me (exigido desde 14/08).
   *
   * Entrega em casa → o endereço de entrega é o proxy do titular (padrão do
   * varejo). Retirada na loja → não existe endereço digitado; vai o CEP que a
   * cliente usou na cotação com a cidade da matriz como âncora — a Pagar.me
   * valida presença dos campos, e recusar TODO cartão de retirada por falta
   * de um formulário a mais seria pior que a aproximação.
   */
  private billingAddressPagarme(
    end: CriarPedidoInput['shippingAddress'],
    cepCotacao?: string,
  ): Record<string, string> {
    if (end) {
      return {
        line_1: [end.number, end.street, end.neighborhood].filter(Boolean).join(', '),
        zip_code: this.digits(end.cep),
        city: end.city,
        state: (end.uf || '').toUpperCase().slice(0, 2),
        country: 'BR',
      };
    }
    return {
      line_1: 'Retirada em loja',
      zip_code: this.digits(cepCotacao || '') || '08710000',
      city: 'Mogi das Cruzes',
      state: 'SP',
      country: 'BR',
    };
  }

  /**
   * O QUE A PAGAR.ME DEVOLVE E A GENTE JOGAVA FORA.
   *
   * `charge.last_transaction` sempre veio inteiro na resposta da cobrança —
   * a gente lia só o `status` e a mensagem de recusa e descartava o resto.
   * Nele estão os quatro últimos dígitos, a bandeira, o titular digitado por
   * ela, o NSU, o TID, o código de autorização e o retorno do adquirente:
   * exatamente a lista que o dossiê de contestação precisa e que hoje é
   * remontada à mão no painel do gateway, com prazo correndo.
   *
   * ⚠️ PAN E CVV NÃO PASSAM POR AQUI e não podem passar. O cartão é
   * tokenizado no navegador da cliente (ver `CardForm.tsx`); o que chega ao
   * backend é o que a Pagar.me devolve DEPOIS de cobrar — máscara e
   * metadados. Guardar isto não muda o nosso escopo de PCI.
   */
  private extrairTransacao(charge: any): DadosTransacao | null {
    const tx = charge?.last_transaction;
    if (!tx) return null;
    const card = tx.card || {};
    const anti = tx.antifraud_response || {};
    const limpo = (v: any, max = 60) => {
      const s = String(v ?? "").trim();
      return s ? s.slice(0, max) : null;
    };
    const dados: DadosTransacao = {
      ultimos4: limpo(card.last_four_digits, 4),
      bandeira: limpo(card.brand, 30),
      titular: limpo(card.holder_name, 80),
      tid: limpo(tx.acquirer_tid, 60),
      nsu: limpo(tx.acquirer_nsu, 60),
      autorizacao: limpo(tx.acquirer_auth_code, 60),
      status: limpo(tx.status, 30),
      codigoRetorno: limpo(tx.acquirer_return_code ?? tx.gateway_response?.code, 30),
      // O antifraude só vem quando está ativo na conta. Ausente = ausente:
      // campo vazio no dossiê é honesto, campo inventado perde a disputa.
      antifraudeStatus: limpo(anti.status, 30),
      antifraudeScore: Number.isFinite(Number(anti.score)) ? Number(anti.score) : null,
      capturadoEm: new Date().toISOString(),
    };
    // Tudo nulo = a Pagar.me não mandou nada útil; não suja o paymentInfo.
    const temAlgo = Object.entries(dados).some(([k, v]) => k !== "capturadoEm" && v != null);
    return temAlgo ? dados : null;
  }

  /**
   * Motivo técnico da recusa → frase que a cliente pode ler.
   * REGRA: nunca vazar código de adquirente, nome de gateway nem stack. A
   * cliente precisa saber o que FAZER, não o que quebrou.
   */
  private mensagemRecusa(gw: any): string {
    const charge = (gw?.charges || [])[0];
    const tx = charge?.last_transaction || {};
    const cru = [
      tx.acquirer_message,
      tx.gateway_response?.errors?.map((e: any) => e?.message).join(' '),
      gw?.message,
      typeof gw?.errors === 'object' ? JSON.stringify(gw.errors) : '',
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

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
    return 'O pagamento não foi aprovado pela operadora do cartão. Tente outro cartão ou pague com PIX — leva 1 minutinho. 💜';
  }

  /* ─────────────────────────── POST /pedido ───────────────────────────── */

  async criarPedido(input: CriarPedidoInput): Promise<CriarPedidoResult> {
    const erro = this.validar(input);
    if (erro) return { ok: false, error: erro, code: 'validation_error' };

    /**
     * ESCUDO ANTI-TESTE-DE-CARTÃO — ANTES de qualquer efeito (28/08).
     *
     * Vem antes do `reprecificar` (não gasta catálogo com bot), antes do
     * `upsertCustomer` (bot não vira lead no CRM) e antes do `criarOrder`
     * (bloqueado NÃO ganha LP — os ~650 pedidos-lixo do ataque nasceram
     * porque não existia este degrau). PIX passa sempre.
     */
    const bloqueio = await this.escudo.avaliar({
      metodo: input.payment?.method,
      ip: input.clienteIp,
      pais: input.clientePais,
      nome: input.customer?.name,
      email: input.customer?.email,
      cpf: input.customer?.cpf,
      fone: input.customer?.phone,
      total: input.total,
    });
    if (bloqueio) return { ok: false, error: bloqueio.error, code: bloqueio.code };

    /**
     * A CONTA É REFEITA ANTES DE QUALQUER COISA (bloco A).
     *
     * Vem antes até do CRM: preço errado, peça esgotada ou despublicada não
     * viram nem lead — viram uma frase pedindo pra recarregar a página. E vem
     * antes de `criarOrder` porque o Order precisa nascer já com o valor certo
     * (é dele que a cobrança e a etiqueta saem).
     */
    const conta = await this.reprecificar(input);
    if (!conta.ok) {
      return {
        ok: false,
        error: conta.erro,
        code: conta.code,
        // Causa exata + peça: é o que o `checkout_error` grava pra tela de
        // Alertas parar de ser cega (22/08).
        ...(conta.motivo ? { motivo: conta.motivo } : {}),
        ...(conta.ref ? { ref: conta.ref } : {}),
        ...(typeof conta.disponivel === 'number' ? { disponivel: conta.disponivel } : {}),
        ...(conta.item ? { item: conta.item } : {}),
        ...(conta.quote ? { quote: conta.quote } : {}),
      };
    }

    // CRM antes da cobrança de propósito: mesmo que o cartão seja recusado, a
    // cliente fica cadastrada (é lead, não venda) e a próxima tentativa dela
    // já cai no mesmo cadastro em vez de duplicar.
    await this.upsertCustomer(input.customer);

    const pickup =
      input.shipping.kind === 'retirada'
        ? await this.resolvePickupStoreCode(input.shipping.storeSlug)
        : null;

    let order: any;
    try {
      order = await this.criarOrder(input, pickup, conta);
    } catch (e: any) {
      this.logger.error(`[loja] falha ao criar pedido: ${e?.message || e}`);
      return {
        ok: false,
        error: 'Não conseguimos abrir o seu pedido agora. Tente de novo em instantes. 💜',
        code: 'internal_error',
      };
    }

    // ── Cobrança ──
    let paymentInfo: any = {
      method: input.payment.method,
      installments: input.payment.method === 'card' ? Number(input.payment.installments || 1) : null,
      gatewayOrderId: null,
      gatewayChargeId: null,
      pix: null,
      // Retentativa no MESMO pedido (`reaproveitarRecusado`): a contagem e as
      // falhas anteriores viajam daqui pra frente em TODOS os caminhos — os três
      // `update` abaixo espalham este objeto. É o histórico que os LPs órfãos
      // guardavam sem querer, e que juntar as tentativas apagaria.
      ...(Number(order.tentativa || 1) > 1
        ? {
            tentativa: Number(order.tentativa),
            tentativasAnteriores: order.tentativasAnteriores ?? [],
          }
        : {}),
    };
    /** Cartão aprovado NA HORA — só ele chama `confirmarPagamento` abaixo. */
    let cartaoPago = false;

    try {
      if (input.payment.method === 'pix') {
        const r = await this.cobrarPix(order, input);
        paymentInfo = { ...paymentInfo, gatewayOrderId: r.gatewayOrderId, pix: r.pix };
      } else {
        const r = await this.cobrarCartao(order, input);
        if (!r.ok) {
          // Recusa REAL da operadora arma o escudo anti-teste-de-cartão: é a
          // contagem dela que separa "uma cliente sem limite" (1/dia) de
          // "bot com lista de cartões" (dezenas/minuto).
          if (r.kind === 'recusa') this.escudo.registrarRecusa();
          /**
           * CARTÃO RECUSADO VIRA CARRINHO RESGATÁVEL (dono, 14/08).
           *
           * Até hoje o pedido recusado era APAGADO — e com ele o nome e o
           * telefone da cliente mais quente que existe: a que JÁ tentou
           * pagar. No incidente do billing_address (4 recusas em 25min) as
           * duas clientes sumiram do banco sem deixar rastro na aba
           * Carrinhos. Agora o pedido fica com `status='payment_failed'`:
           *
           *  - NÃO entra em nenhuma fila (roteamento/separação/reconcile/
           *    resgate PIX filtram por status explícito, e este não está em
           *    nenhuma lista);
           *  - NÃO segura estoque (a baixa só acontece no bipe da separação);
           *  - APARECE na aba Carrinhos (abandoned = sem pagamento e não
           *    cancelado) com botão de WhatsApp.
           *
           * Tentou de novo e passou? Nasce outro pedido — o recusado fica
           * como registro da tentativa, mesmo papel do PagarmePayment
           * status='failed' que sempre ficou.
           *
           * O MOTIVO vai junto em `paymentInfo.falha` (17/08): só o status
           * não dizia se foi limite, cartão vencido ou a Pagar.me fora — e a
           * próxima investigação (como a de 14/08) precisa disso sem abrir o
           * painel do gateway.
           *
           * `kind` decide o CÓDIGO que o site lê: recusa da operadora →
           * `card_declined` ("tente outro cartão"); falha de integração →
           * `payment_unavailable` (o texto do site pra esse código não manda
           * trocar de cartão — porque o cartão não tem culpa).
           */
          await (this.prisma as any).order
            .update({
              where: { id: order.id },
              data: {
                status: 'payment_failed',
                paymentInfo: JSON.stringify({
                  ...paymentInfo,
                  gatewayOrderId: r.gatewayOrderId ?? null,
                  gatewayChargeId: r.gatewayChargeId ?? null,
                  falha: r.detalhe,
                  falhaTipo: r.kind,
                  falhaEm: new Date().toISOString(),
                }),
              },
            })
            .catch(async (e: any) => {
              this.logger.warn(`[loja] recusa não persistiu (${e?.message || e}) — descartando como antes`);
              await this.descartarPedido(order.id);
            });
          return {
            ok: false,
            error: r.error,
            code: r.kind === 'integracao' ? 'payment_unavailable' : 'card_declined',
          };
        }
        cartaoPago = r.status === 'paid';
        paymentInfo = {
          ...paymentInfo,
          gatewayOrderId: r.gatewayOrderId,
          gatewayChargeId: r.gatewayChargeId,
          // Bandeira, 4 últimos, titular, NSU, TID, autorização e antifraude.
          // Sempre estiveram na resposta da cobrança e eram descartados —
          // ver `extrairTransacao`. Sem PAN e sem CVV.
          ...(r.transacao ? { transacao: r.transacao } : {}),
          /**
           * EM ANÁLISE (17/08): a operadora ainda não disse sim nem não. O
           * pedido fica `awaiting_payment` como um PIX que ainda não caiu, e
           * quem fecha é o webhook `charge.paid` ou o reconcile de 1 min
           * (PASSO 2 consulta o gateway pelo `gatewayOrderId`). Marca aqui pra
           * quem abrir o pedido saber que NÃO é PIX esperando a cliente — é
           * cartão esperando a Pagar.me.
           */
          ...(r.status === 'pending' ? { cartaoEmAnalise: true, emAnaliseDesde: new Date().toISOString() } : {}),
        };
      }
    } catch (e: any) {
      const motivo = e?.message || String(e);
      this.logger.error(
        `[loja] cobrança falhou pedido=${order.wcOrderNumber} (${input.payment.method}): ${motivo}`,
      );
      /**
       * COBRANÇA QUE ESTOUROU TAMBÉM VIRA CARRINHO RESGATÁVEL (dono, 15/08).
       *
       * Mesma razão do cartão recusado logo acima: a cliente que tentou pagar
       * é a mais quente que existe, e o `descartarPedido` a apagava sem deixar
       * rastro — nem na aba Carrinhos, nem pra gente diagnosticar POR QUE. Foi
       * o que aconteceu em 15/08: duas clientes tentaram Pix num carrinho de
       * R$209 (bmm-100, com estoque de sobra), o Pix não gerou 8× seguidas, e
       * as duas — mais o motivo real — sumiram junto com o pedido descartado.
       *
       * Agora o pedido fica `payment_failed` (não segura estoque, não entra em
       * fila nenhuma — todas filtram esse status) e o motivo técnico vai pro
       * `paymentInfo.falha`, pra próxima falha ter nome em vez de "recusado".
       */
      await (this.prisma as any).order
        .update({
          where: { id: order.id },
          data: {
            status: 'payment_failed',
            paymentInfo: JSON.stringify({ ...paymentInfo, falha: motivo, falhaEm: new Date().toISOString() }),
          },
        })
        .catch(async (err: any) => {
          this.logger.warn(`[loja] falha de cobrança não persistiu (${err?.message || err}) — descartando`);
          await this.descartarPedido(order.id);
        });
      return {
        ok: false,
        error:
          input.payment.method === 'pix'
            ? 'Não conseguimos gerar o seu Pix agora. Tente de novo em instantes — ou finalize no cartão, que aprova na hora. 💜'
            : 'Não conseguimos iniciar o pagamento agora. Tente de novo em instantes. 💜',
        code: 'payment_unavailable',
      };
    }

    await (this.prisma as any).order.update({
      where: { id: order.id },
      data: { paymentInfo: JSON.stringify(paymentInfo) },
    });

    /**
     * ANÁLISE DE RISCO — depois do pagamento, e NUNCA no caminho crítico.
     *
     * Depois porque só aqui o `paymentInfo.transacao` existe: antes, o
     * pedido nasceria sem chave de cartão nem de titular. `void` + `catch`
     * porque risco é OBSERVAÇÃO — um erro aqui não pode, em hipótese
     * nenhuma, virar pedido que a cliente não consegue fechar. O que falhar
     * aqui, o backfill e a abertura do pedido recuperam.
     *
     * E, de novo: isto só CALCULA e ALERTA. Não bloqueia, não cancela e não
     * segura estoque — ordem do dono (27/08).
     */
    void this.riscoChaves
      .gravarChavesSeguro(order.id)
      .then(() => this.risco.analisar(order.id))
      .catch((e: any) =>
        this.logger.warn(
          `[loja] análise de risco falhou pedido=${order.wcOrderNumber}: ${e?.message || e}`,
        ),
      );

    this.logger.log(
      `[loja] pedido ${order.wcOrderNumber} criado (${input.payment.method}) R$ ${this.dinheiro(input.total).toFixed(2)}`,
    );

    // Cartão aprovado paga na hora — o webhook que chega depois vira no-op.
    // Cartão EM ANÁLISE não passa aqui: confirmar sem `paid` seria liberar
    // separação de um pagamento que o antifraude ainda pode reprovar.
    if (input.payment.method === 'card' && cartaoPago) {
      await this.confirmarPagamento(order.id);
    }

    const fresh = await (this.prisma as any).order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });

    /**
     * "RECEBEMOS SEU PEDIDO" (12/08). Fire-and-forget: a cliente está olhando
     * a tela do Pix agora, e segurar a resposta esperando webhook de mensagem
     * é atrasar justamente o momento em que ela precisa do QR code.
     */
    void this.pedidoEmail.aoCriarPedido(fresh);

    return {
      ok: true,
      order: {
        id: fresh.id,
        number: fresh.wcOrderNumber,
        status: this.statusPublico(fresh),
        total: this.dinheiro(fresh.totalAmount),
        /**
         * A CONTA DA CASA volta discriminada. O BFF do site montava o resumo
         * com os números DELE (subtotal/desconto/frete calculados lá) e só
         * trocava o total pelo nosso — o que dava resumo que não somava o
         * total exibido assim que a reprecificação mexesse em qualquer linha.
         * Agora tem de onde ler a conta certa.
         */
        subtotal: this.dinheiro(conta.subtotal),
        discount: this.dinheiro(conta.descontoCupom + conta.descontoPix + conta.descontoPromocao),
        couponDiscount: this.dinheiro(conta.descontoCupom),
        pixDiscount: this.dinheiro(conta.descontoPix),
        promotionDiscount: this.dinheiro(conta.descontoPromocao),
        promotion: conta.promocao
          ? {
              campaignCode: conta.promocao.campaignCode,
              headline: conta.promocao.tierLabel,
              freeItem: conta.promocao.freeItem,
            }
          : null,
        shippingPrice: this.dinheiro(conta.frete),
        couponCode: conta.couponCode,
        items: input.items.map((it) => ({
          sku: it.sku,
          size: it.size,
          color: it.color ?? null,
          quantity: Number(it.quantity),
          unitPrice: this.dinheiro(it.unitPrice),
        })),
        payment: {
          method: paymentInfo.method,
          ...(paymentInfo.installments ? { installments: paymentInfo.installments } : {}),
          ...(paymentInfo.pix ? { pix: paymentInfo.pix } : {}),
        },
      },
    };
  }

  /** Remove o pedido que não virou venda. Falhou o delete → marca cancelado. */
  private async descartarPedido(orderId: string): Promise<void> {
    try {
      await (this.prisma as any).order.delete({ where: { id: orderId } });
    } catch (e: any) {
      this.logger.warn(`[loja] pedido ${orderId} não pôde ser apagado, cancelando: ${e?.message || e}`);
      await (this.prisma as any).order
        .update({ where: { id: orderId }, data: { status: 'cancelled' } })
        .catch(() => undefined);
    }
  }

  /* ───────────────────── status público do pedido ─────────────────────── */

  /**
   * Traduz o status interno (vocabulário da retaguarda) pro vocabulário do
   * e-commerce: awaiting_payment | paid | expired | cancelled.
   * Tudo que já passou pelo pagamento (processing, routing, separating,
   * shipped, delivered...) é `paid` pra cliente — o rastreio detalhado é outra
   * tela.
   */
  private statusPublico(order: any): 'awaiting_payment' | 'paid' | 'expired' | 'cancelled' {
    const s = String(order?.status || '');
    if (s === 'cancelled' || s === 'canceled') return 'cancelled';
    // Cartão recusado (14/08): pro público lê como cancelado — a cliente que
    // abrir o link não pode ver "aguardando pagamento" de uma cobrança que
    // não existe mais.
    if (s === 'payment_failed') return 'cancelled';
    if (s === 'awaiting_payment') {
      // PIX vencido sem pagamento vira `expired` (o pedido segue no banco pra
      // eventual pagamento tardio — o webhook ainda confirma se cair).
      const pi = this.parseJson<any>(order?.paymentInfo, null);
      const exp = pi?.pix?.expiresAt ? new Date(pi.pix.expiresAt).getTime() : 0;
      if (exp && Date.now() > exp) return 'expired';
      return 'awaiting_payment';
    }
    return order?.paidAt ? 'paid' : 'awaiting_payment';
  }

  /** GET /public/loja/pedido/:id — sem PII inteira, sem tracking, sem gateway. */
  /**
   * OS VOLUMES DO PEDIDO, COM O RASTREIO QUE O FLOW JÁ TEM (22/08/2026).
   *
   * A página de acompanhamento mandava a cliente pro site dos Correios — "a
   * consulta abre em outra aba" — enquanto o `RastreioSyncCron` mantém a
   * tabela `rastreio_objetos` atualizada de 30 em 30 minutos, com cascata
   * Correios → Mais Envios → LinkeTrack. O dado estava em casa e a cliente
   * ansiosa ia procurar fora.
   *
   * PEDIDO DIVIDIDO ENTRA AQUI TAMBÉM. Quando as peças saem de lojas
   * diferentes, cada `PickOrder` vira uma caixa com código próprio, e a
   * cliente recebia duas mensagens sem nenhuma tela que juntasse as duas —
   * parecia pedido errado. Agora é "caixa 1 de 2" e "caixa 2 de 2", cada uma
   * com o status dela.
   *
   * ⚠️ SÓ O CACHE, NUNCA A API AO VIVO: esta rota é pública e a cliente
   * atualiza a página várias vezes por dia. Consultar o SRO por visita
   * queimaria a cota do contrato — o cron é quem consulta.
   */
  private async volumesDoPedido(order: any): Promise<any[]> {
    const caixas: Array<{ codigo: string; carrier: string | null; loja: string | null }> = [];

    // Pedido inteiro numa caixa só: o código está no próprio Order.
    if (order.trackingCode) {
      caixas.push({ codigo: String(order.trackingCode).trim(), carrier: order.carrier ?? null, loja: null });
    }

    // Pedido dividido: uma caixa por ordem de separação com código.
    try {
      const picks: any[] = await (this.prisma as any).pickOrder.findMany({
        where: { orderId: order.id, trackingCode: { not: null } },
        select: { trackingCode: true, carrier: true, store: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      });
      for (const p of picks) {
        const codigo = String(p.trackingCode || '').trim();
        if (codigo && !caixas.some((c) => c.codigo.toUpperCase() === codigo.toUpperCase())) {
          caixas.push({ codigo, carrier: p.carrier ?? null, loja: p.store?.name ?? null });
        }
      }
    } catch {
      // Sem as caixas o pedido continua exibível com o código principal.
    }

    if (!caixas.length) return [];

    let cache = new Map<string, any>();
    try {
      const linhas: any[] = await (this.prisma as any).rastreioObjeto.findMany({
        where: { codigo: { in: caixas.map((c) => c.codigo.toUpperCase()) } },
      });
      cache = new Map(linhas.map((l) => [String(l.codigo).toUpperCase(), l]));
    } catch {
      // Cache fora do ar: devolve os códigos sem status em vez de sumir com
      // a seção — o código é o mínimo que a cliente precisa ter na mão.
    }

    return caixas.map((c, i) => {
      const r = cache.get(c.codigo.toUpperCase());
      return {
        codigo: c.codigo,
        // Nome amigável: "Mais Envios" é contrato, não transportadora — pra
        // cliente é Correios (ver common/transportadora-cliente).
        carrier: transportadoraParaCliente(c.carrier),
        loja: c.loja,
        posicao: i + 1,
        total: caixas.length,
        status: r?.status ?? null,
        local: r?.local ?? null,
        eventoEm: r?.eventoEm?.toISOString?.() ?? null,
        previsaoEm: r?.previsaoEm?.toISOString?.() ?? null,
        entregue: !!r?.entregue,
        entregueEm: r?.entregueEm?.toISOString?.() ?? null,
        atualizadoEm: r?.consultadoEm?.toISOString?.() ?? null,
        url: `https://rastreamento.correios.com.br/app/index.php?objeto=${encodeURIComponent(c.codigo)}`,
      };
    });
  }

  async buscarPedido(id: string): Promise<{ ok: boolean; order?: any; error?: string }> {
    const order = await (this.prisma as any).order
      .findFirst({ where: { id, source: 'ecommerce' }, include: { items: true } })
      .catch(() => null);
    if (!order) return { ok: false, error: 'Pedido não encontrado.' };

    const volumes = await this.volumesDoPedido(order).catch(() => []);

    const ck = this.parseJson<any>(order.checkoutInfo, {});
    const pi = this.parseJson<any>(order.paymentInfo, {});
    const end = this.parseJson<any>(order.shippingAddress, {});

    return {
      ok: true,
      order: {
        id: order.id,
        number: order.wcOrderNumber,
        status: this.statusPublico(order),
        createdAt: order.createdAt?.toISOString?.() ?? null,
        ...(order.paidAt ? { paidAt: order.paidAt.toISOString() } : {}),
        customer: {
          name: order.customerName,
          email: order.customerEmail,
          // CPF MASCARADO — a URL do pedido é um link que a cliente
          // compartilha sem pensar; documento inteiro nunca sai daqui.
          cpf: this.mascararCpf(order.customerCpf),
          phone: order.customerPhone,
        },
        // Endereço sai do snapshot do checkout (original, sem round-trip pelo
        // formato do WC). Pedido antigo/sem snapshot cai no melhor esforço.
        ...(order.isPickup
          ? {}
          : {
              shippingAddress: ck.address || {
                cep: order.shippingCep,
                street: String(end.address_1 || '').split(',')[0]?.trim() || '',
                number: String(end.address_1 || '').split(',').slice(1).join(',').trim(),
                complement: String(end.address_2 || '').split(' - ')[0]?.trim() || '',
                neighborhood: String(end.address_2 || '').split(' - ').slice(1).join(' - ').trim(),
                city: end.city || '',
                uf: end.state || '',
              },
            }),
        shipping: ck.shipping || {
          id: 'entrega',
          kind: order.isPickup ? 'retirada' : 'correios',
          label: order.shippingMethod || 'Entrega',
          price: 0,
        },
        items: Array.isArray(ck.items) && ck.items.length
          ? ck.items
          : (order.items || []).map((it: any) => ({
              sku: it.sku,
              name: it.productName,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
            })),
        /**
         * RASTREIO (itens 76 e 77) — a resposta do GET público não trazia o
         * código, então a página de acompanhamento só sabia dizer "pago".
         * Quem quer saber ONDE está a peça tinha que abrir o WhatsApp.
         */
        tracking: order.trackingCode
          ? {
              code: order.trackingCode,
              // Nome amigável — ver common/transportadora-cliente.
              carrier: transportadoraParaCliente(order.carrier),
              // Link direto dos Correios: colar o código no site deles é o
              // passo que faz a cliente desistir e ligar.
              url: `https://rastreamento.correios.com.br/app/index.php?objeto=${encodeURIComponent(order.trackingCode)}`,
            }
          : null,
        /**
         * AS CAIXAS, COM O STATUS QUE JÁ ESTÁ NO FLOW (ver `volumesDoPedido`).
         * Vazio = ainda não postado. `tracking` acima fica pra não quebrar
         * quem já lia de lá.
         */
        volumes,
        subtotal: ck.subtotal ?? null,
        discount: ck.discount ?? 0,
        // Discriminado quando o pedido nasceu depois do bloco A; pedido antigo
        // devolve 0 nos dois e o total continua certo.
        couponDiscount: ck.descontoCupom ?? 0,
        pixDiscount: ck.descontoPix ?? 0,
        ...(ck.couponCode ? { couponCode: ck.couponCode } : {}),
        shippingPrice: ck.shippingPrice ?? 0,
        total: this.dinheiro(order.totalAmount),
        payment: {
          method: pi.method || 'pix',
          ...(pi.installments ? { installments: pi.installments } : {}),
          // Só o que a cliente usa pra pagar. gatewayOrderId NÃO sai.
          ...(pi.pix ? { pix: pi.pix } : {}),
        },
      },
    };
  }

  /** GET /public/loja/pedido/:id/status — o poll do PIX bate aqui. */
  async statusPedido(id: string): Promise<{ ok: boolean; status?: string; paidAt?: string; error?: string }> {
    const order = await (this.prisma as any).order
      .findFirst({
        where: { id, source: 'ecommerce' },
        select: { id: true, status: true, paidAt: true, paymentInfo: true },
      })
      .catch(() => null);
    if (!order) return { ok: false, error: 'Pedido não encontrado.' };
    return {
      ok: true,
      status: this.statusPublico(order),
      ...(order.paidAt ? { paidAt: order.paidAt.toISOString() } : {}),
    };
  }

  /* ────────────────── confirmação de pagamento (webhook) ──────────────── */

  /**
   * O ÚNICO caminho que marca um pedido da loja como pago.
   *
   * IDEMPOTENTE: já pago → no-op. O webhook da Pagar.me repete, e repete
   * MESMO; cartão aprovado ainda chama daqui direto e o webhook chega depois.
   *
   * `status='processing'` é o que faz o pedido cair na tela Pedidos &
   * Separação da retaguarda pro roteamento — exatamente como o pedido da live
   * (handoffToSiteFlow). NÃO roteia aqui: roteamento é 100% da matriz.
   *
   * Recebe qualquer id (o webhook devolve o `saleId` do PagarmePayment, que
   * também pode ser venda de PDV ou carrinho de live) — id que não é pedido da
   * loja sai em silêncio.
   */
  async confirmarPagamento(orderId: string): Promise<{ ok: boolean; already?: boolean; reason?: string }> {
    if (!orderId) return { ok: false, reason: 'sem id' };

    const order = await (this.prisma as any).order
      .findFirst({ where: { id: orderId, source: 'ecommerce' }, include: { items: true } })
      .catch(() => null);
    if (!order) return { ok: false, reason: 'não é pedido da loja' };

    if (order.paidAt) return { ok: true, already: true };
    if (order.status === 'cancelled') return { ok: false, reason: 'pedido cancelado' };

    /**
     * TRAVA ATÔMICA, não só o `if` acima (item 8).
     *
     * O `if (order.paidAt)` resolve a repetição SEQUENCIAL — o webhook que
     * chega de novo cinco minutos depois. Não resolve a SIMULTÂNEA: a Pagar.me
     * entrega `order.paid` e `charge.paid` praticamente juntos, e o reconcile
     * pode estar no mesmo pedido no mesmo segundo. Os dois leem `paidAt: null`,
     * os dois passam, e o resultado é histórico duplicado e o evento `purchase`
     * disparado duas vezes — ou seja, faturamento dobrado no Meta e no GA4.
     *
     * `updateMany` com `paidAt: null` no WHERE resolve no banco: quem chegar
     * segundo atualiza 0 linhas e sai como `already`.
     */
    const paidAt = new Date();
    const trava = await (this.prisma as any).order.updateMany({
      where: { id: order.id, paidAt: null },
      data: { paidAt, status: 'processing' },
    });
    if (trava.count === 0) return { ok: true, already: true };

    /**
     * PAGO DEPOIS DE "RECUSADO" É CASO DE CONCILIAÇÃO, não de silêncio.
     *
     * Só chega aqui com `payment_failed` quando a cobrança que a gente deu
     * como perdida entrou mesmo assim (timeout em que a Pagar.me cobrou, ou
     * o antigo caminho que marcava análise como recusa). A cliente ouviu
     * "não aprovado" e pode ter pago DE NOVO por outro caminho — quem
     * concilia precisa olhar esse pedido e procurar a cobrança dobrada.
     */
    if (order.status === 'payment_failed') {
      this.logger.warn(
        `[loja][CONCILIAR] pedido ${order.wcOrderNumber} estava payment_failed e RECEBEU pagamento — ` +
          `a cliente pode ter pago duas vezes (procurar outro pedido/cobrança dela). Liberado pra separação mesmo assim.`,
      );
    }

    const atualizado = await (this.prisma as any).order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });

    await (this.prisma as any).orderHistory
      .create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: 'processing',
          note: 'Pagamento confirmado (e-commerce)',
        },
      })
      .catch(() => undefined);

    this.logger.log(`[loja] pedido ${order.wcOrderNumber} PAGO — aguardando roteamento na retaguarda`);

    /**
     * Cupom com limite de uso só é QUEIMADO quando o dinheiro entra. Contar na
     * criação do pedido gastaria a cota em PIX que expirou sem pagamento — e a
     * campanha morreria antes de vender. Como este caminho é idempotente (sai
     * em `already` acima), não conta duas vezes no reenvio do webhook.
     */
    const ck = this.parseJson<any>(order.checkoutInfo, {});
    if (ck?.couponCode) void this.cupons.registrarUso(ck.couponCode);

    // Tracking nunca desfaz pagamento — fire-and-forget DE VERDADE (sem await):
    // quem chama isto é o webhook da Pagar.me, e segurar o ack esperando o
    // e-commerce responder é convite pro gateway dar timeout e reenfileirar.
    // `notificarEcommerce` engole os próprios erros, então nunca rejeita.
    void this.notificarEcommerce(atualizado);

    /**
     * O E-MAIL DE "PAGAMENTO CONFIRMADO" (12/08). Até aqui o e-commerce não
     * mandava e-mail NENHUM: a cliente pagava e ficava sem nada na caixa de
     * entrada. Fire-and-forget pela mesma razão do tracking — o dinheiro já
     * entrou, e SMTP fora do ar não pode segurar o ack do webhook.
     */
    void this.pedidoEmail.aoConfirmarPagamento(atualizado);

    return { ok: true };
  }

  /**
   * O OUTRO LADO DA ANÁLISE: a operadora disse NÃO depois de a gente ter
   * deixado o pedido aguardando.
   *
   * Desde 17/08 o cartão em análise fica `awaiting_payment` (ver
   * `classificarCartao`). Se o antifraude reprovar, ninguém mais mexe nesse
   * pedido: o webhook grava `failed` no PagarmePayment e para aí, e o
   * reconcile só confirma — nunca desfaz. O pedido ficaria "em processamento"
   * pra sempre na tela da cliente e fora da aba Carrinhos.
   *
   * Este é o caminho pra fechar essa ponta. Quem chama: o webhook da Pagar.me
   * (`charge.payment_failed`, `charge.antifraud_reproved`, `order.canceled`)
   * e o reconcile quando `checkOrderStatus` voltar failed/canceled — SEMPRE
   * com o `saleId` que veio do PagarmePayment, nunca com id vindo do payload.
   *
   * SÓ MEXE EM CARTÃO aguardando e sem `paidAt`, e faz isso num `updateMany`
   * condicionado: chegou `paid` no meio do caminho, atualiza 0 linhas e sai.
   * PIX não passa aqui de propósito — PIX vencido já vira `expired` no
   * `statusPublico`, e "canceled" de PIX é a cliente que não pagou, não uma
   * recusa.
   */
  async registrarRecusaTardia(orderId: string, motivo: string): Promise<{ ok: boolean; reason?: string }> {
    if (!orderId) return { ok: false, reason: 'sem id' };

    const order = await (this.prisma as any).order
      .findFirst({
        where: { id: orderId, source: 'ecommerce' },
        select: { id: true, wcOrderNumber: true, status: true, paidAt: true, paymentInfo: true },
      })
      .catch(() => null);
    if (!order) return { ok: false, reason: 'não é pedido da loja' };
    if (order.paidAt) return { ok: false, reason: 'já pago' };
    if (order.status !== 'awaiting_payment') return { ok: false, reason: `status ${order.status}` };

    const pi = this.parseJson<any>(order.paymentInfo, {});
    if (pi?.method !== 'card') return { ok: false, reason: 'não é cartão' };

    const trava = await (this.prisma as any).order.updateMany({
      where: { id: order.id, paidAt: null, status: 'awaiting_payment' },
      data: {
        status: 'payment_failed',
        paymentInfo: JSON.stringify({
          ...pi,
          falha: String(motivo || 'recusa tardia').slice(0, 300),
          falhaTipo: 'recusa',
          falhaEm: new Date().toISOString(),
        }),
      },
    });
    if (trava.count === 0) return { ok: false, reason: 'mudou no meio do caminho' };

    await (this.prisma as any).orderHistory
      .create({
        data: {
          orderId: order.id,
          fromStatus: 'awaiting_payment',
          toStatus: 'payment_failed',
          note: `Cartão recusado após análise (${String(motivo || '').slice(0, 120)})`,
        },
      })
      .catch(() => undefined);

    this.logger.warn(`[loja] pedido ${order.wcOrderNumber}: cartão em análise foi RECUSADO (${motivo}) — volta pra aba Carrinhos`);
    return { ok: true };
  }

  /**
   * Avisa o e-commerce que o dinheiro entrou, pra ele disparar o `purchase`
   * server-side (Meta CAPI / GA4) com os sinais do navegador que só ele tem.
   *
   * FIRE-AND-FORGET: falha de tracking NUNCA desfaz pagamento (o pedido já
   * está pago no banco). Sem `ECOMMERCE_URL`/`PAYMENT_WEBHOOK_SECRET`
   * configuradas, pula em silêncio (debug) — é o caso do ambiente que ainda
   * não subiu o site novo.
   */
  private async notificarEcommerce(order: any): Promise<void> {
    const url = (process.env.ECOMMERCE_URL || '').replace(/\/+$/, '');
    const secret = process.env.PAYMENT_WEBHOOK_SECRET || '';
    if (!url || !secret) {
      this.logger.debug(`[loja] purchase não notificado (ECOMMERCE_URL/PAYMENT_WEBHOOK_SECRET ausentes)`);
      return;
    }

    try {
      const ck = this.parseJson<any>(order.checkoutInfo, {});
      const pi = this.parseJson<any>(order.paymentInfo, {});
      const tr = this.parseJson<any>(order.trackingInfo, {});
      const itensSnapshot: any[] = Array.isArray(ck.items) ? ck.items : [];

      const items = itensSnapshot.length
        ? itensSnapshot.map((it) => ({
            product_id: it.productId,
            sku: it.sku,
            name: it.name,
            cor: it.color || undefined,
            tamanho: it.size || undefined,
            quantidade: it.quantity,
            valor: it.unitPrice,
          }))
        : (order.items || []).map((it: any) => ({
            product_id: it.sku,
            sku: it.sku,
            name: it.productName,
            quantidade: it.quantity,
            valor: it.unitPrice,
          }));

      const payload = {
        orderId: order.id,
        status: 'paid' as const,
        paidAt: order.paidAt?.toISOString?.() ?? new Date().toISOString(),
        purchase: {
          number: order.wcOrderNumber,
          total: this.dinheiro(order.totalAmount),
          ...(ck.couponCode ? { coupon: ck.couponCode } : {}),
          payment_method: pi.method === 'card' ? 'credit_card' : 'pix',
          items,
          customer: {
            email: order.customerEmail,
            phone: order.customerPhone,
            cpf: order.customerCpf,
          },
          tracking: {
            anonymous_id: tr.anonymous_id || undefined,
            session_id: tr.session_id || undefined,
            fbp: tr.fbp || undefined,
            fbc: tr.fbc || undefined,
            // Ida e volta completa do cookie do gtag: navegador → BFF → aqui →
            // `trackingInfo` → de volta ao site no purchase. Qualquer elo que
            // esqueça a chave desliga a medição do Google inteira, em silêncio.
            ga4_client_id: tr.ga4_client_id || undefined,
            ga4_session_id: tr.ga4_session_id || undefined,
            attribution: tr.attribution || undefined,
          },
          // Retirada em loja: o slug segue junto pro evento de compra carimbar
          // a loja física. É o que liga a venda online ao acerto entre lojas —
          // sem ele, a peça sai da loja e a venda fica só "do site".
          ...(ck.storeSlug ? { store_slug: ck.storeSlug } : {}),
        },
      };

      await firstValueFrom(
        this.http.post(`${url}/api/webhooks/payment`, payload, {
          headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret },
          timeout: 8000,
        }),
      );
      this.logger.log(`[loja] purchase notificado ao e-commerce (pedido ${order.wcOrderNumber})`);
    } catch (e: any) {
      // Só loga: o pedido está pago, a Meta que espere o retry manual.
      this.logger.warn(
        `[loja] purchase NÃO notificado (pedido ${order?.wcOrderNumber} segue pago): ${e?.response?.status || ''} ${e?.message || e}`,
      );
    }
  }
}
