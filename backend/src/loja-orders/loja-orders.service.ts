import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { computePersonKeyFromCpf } from '../customers/customer-aggregation.helper';
import { montarComplementoBairroWc, montarNumeroWc } from '../common/endereco-wc';
import { CarrinhoGuardService } from './carrinho-guard.service';
import { CupomService } from './cupom.service';
import { FreteService } from './frete.service';
import { PersonIdentityService } from '../person-identity/person-identity.service';
import { PedidoEmailService } from './pedido-email.service';

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
 *     direto (síncrono) e o webhook que chega depois vira no-op.
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
  attribution?: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    id?: string;
  };
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
}

/** Resposta do POST — `ok:false` sempre vem com mensagem pronta pra cliente. */
export interface CriarPedidoResult {
  ok: boolean;
  error?: string;
  order?: any;
}

/* ─────────────────────────────── SERVICE ──────────────────────────────── */

@Injectable()
export class LojaOrdersService {
  private readonly logger = new Logger(LojaOrdersService.name);

  /** Base dos wcOrderId sintéticos da LOJA (live usa 900M, WC real usa < 1M). */
  private static readonly LOJA_WC_ID_BASE = 950_000_000;

  /** Validade do PIX. 30min é o que a cliente aguenta esperar sem desistir. */
  /**
   * Validade do PIX: 2 HORAS (dono, 04/08 — era 30 min).
   *
   * 30 minutos derrubava compra boa: cliente que abre o QR, sai pra pegar o
   * celular do banco e volta, já achava o código vencido. Duas horas cobre o
   * "vou pagar quando chegar em casa" sem segurar a peça a noite inteira.
   */
  private static readonly PIX_EXPIRA_MIN = 120;

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
  ) {}

  /* ───────────────────────── helpers de formato ───────────────────────── */

  private digits(v: any): string {
    return String(v ?? '').replace(/\D/g, '');
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
    if (this.digits(input.customer.phone).length < 10) return 'O telefone precisa vir com DDD.';

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
    | { ok: false; erro: string }
    | {
        ok: true;
        subtotal: number;
        descontoCupom: number;
        descontoPix: number;
        frete: number;
        total: number;
        couponCode: string | null;
      }
  > {
    // 1) Preço, estoque e publicação, peça a peça.
    const conferencia = await this.guard.conferir(input.items as any);
    if (!conferencia.ok) return { ok: false, erro: conferencia.erro };

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

    // 2) Cupom recalculado (item 3).
    let descontoCupom = 0;
    let couponCode: string | null = null;
    let freteGratisPorCupom = false;
    if (input.couponCode) {
      const r = await this.cupons.aplicar(input.couponCode, subtotal, {
        cpf: this.digits(input.customer.cpf),
      });
      if (!r.ok) return { ok: false, erro: r.mensagem };
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
    const baseComDesconto = Math.max(0, subtotal - descontoCupom);
    const descontoPix =
      input.payment?.method === 'pix' && pct > 0
        ? this.dinheiro((baseComDesconto * pct) / 100)
        : 0;

    // 4) Total do zero.
    const total = this.dinheiro(subtotal - descontoCupom - descontoPix + frete);
    if (total <= 0) {
      this.logger.warn(`[loja] total recalculado <= 0 (subtotal=${subtotal} cupom=${descontoCupom})`);
      return { ok: false, erro: 'O valor do pedido ficou inválido. Confira a sacola e tente de novo. 💜' };
    }

    // TETO: nunca cobrar acima do que a cliente viu.
    const informado = this.dinheiro(input.total);
    if (informado > 0 && total > informado + LojaOrdersService.TOLERANCIA) {
      this.logger.warn(
        `[loja] recálculo acima do informado: nosso=${total.toFixed(2)} site=${informado.toFixed(2)} ` +
          `(subtotal=${subtotal.toFixed(2)} cupom=${descontoCupom.toFixed(2)} pix=${descontoPix.toFixed(2)} frete=${frete.toFixed(2)})`,
      );
      return {
        ok: false,
        erro: 'Os valores da sacola mudaram desde que você abriu o checkout. Atualize a página e confira antes de pagar. 💜',
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
    input.discount = this.dinheiro(descontoCupom + descontoPix);
    input.shippingPrice = frete;
    input.shipping.price = frete;
    input.total = total;
    input.couponCode = couponCode || undefined;

    return { ok: true, subtotal, descontoCupom, descontoPix, frete, total, couponCode };
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
    const phone = this.digits(c.phone) || null;

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
  private async proximaSequencia(): Promise<number> {
    const base = LojaOrdersService.LOJA_WC_ID_BASE;
    const ultimo = await (this.prisma as any).order.findFirst({
      where: { source: 'ecommerce', wcOrderId: { gte: base } },
      orderBy: { wcOrderId: 'desc' },
      select: { wcOrderId: true },
    });
    return ultimo ? Number(ultimo.wcOrderId) - base : 0;
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
      phone: this.digits(input.customer.phone),
    };
  }

  private async criarOrder(
    input: CriarPedidoInput,
    pickup: { code: string; name: string } | null,
    conta?: { descontoCupom: number; descontoPix: number },
  ): Promise<any> {
    const base = LojaOrdersService.LOJA_WC_ID_BASE;
    const seq0 = await this.proximaSequencia();
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
          attribution: input.tracking.attribution || null,
        }
      : null;

    // Retry em colisão de wcOrderId — mesma defesa da live: dois checkouts
    // simultâneos leem a mesma sequência e um dos dois bate P2002.
    for (let tent = 0; tent < 6; tent++) {
      const seq = seq0 + 1 + tent;
      try {
        return await (this.prisma as any).order.create({
          data: {
            wcOrderId: base + seq,
            wcOrderNumber: this.numeroPedido(seq),
            source: 'ecommerce',
            // Enquanto não pagar, o pedido NÃO existe pra retaguarda: só vira
            // 'processing' (= fila de roteamento) quando o dinheiro entra.
            status: 'awaiting_payment',
            customerName: String(input.customer.name || '').trim() || null,
            customerEmail: String(input.customer.email || '').trim() || null,
            customerPhone: this.digits(input.customer.phone) || null,
            customerCpf: this.digits(input.customer.cpf) || null,
            shippingCep: this.digits(input.shippingAddress?.cep) || null,
            shippingAddress: JSON.stringify(shipping),
            totalAmount: this.dinheiro(input.total),
            isPickup: retirada,
            pickupStoreCode: retirada ? pickup?.code || null : null,
            shippingMethod: retirada
              ? `Retirada em loja${pickup?.name ? ` (${pickup.name})` : ''}`
              : input.shipping.label || 'Entrega',
            wcDateCreated: new Date(),
            utmSource: attr.source || null,
            utmMedium: attr.medium || null,
            utmCampaign: attr.campaign || null,
            utmId: attr.id || null,
            utmContent: attr.content || null,
            checkoutInfo: JSON.stringify(checkoutInfo),
            trackingInfo: trackingInfo ? JSON.stringify(trackingInfo) : null,
            items: {
              create: input.items.map((it) => ({
                sku: String(it.sku),
                productName: [it.name, it.color, it.size].filter(Boolean).join(' · '),
                // REF/COR/TAMANHO em colunas próprias: o `productName` já
                // trazia cor e tamanho grudados no nome, mas grudado não dá
                // pra destacar na separação nem imprimir em coluna.
                ref: it.ref || it.productId || null,
                cor: it.color || null,
                tamanho: it.size || null,
                quantity: Number(it.quantity),
                unitPrice: this.dinheiro(it.unitPrice),
                // No site o preço praticado JÁ é o cheio — não há tabela
                // promocional por peça como na live, então base = unitário.
                baseUnitPrice: this.dinheiro(it.unitPrice),
              })),
            },
          },
        });
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e; // P2002 = wcOrderId colidiu → próximo
      }
    }
    throw new Error('não consegui gerar o número do pedido (colisão de wcOrderId)');
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
      customerPhone: this.digits(input.customer.phone),
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
   * CARTÃO — cobrança síncrona com o token que o e-commerce já gerou no
   * navegador (o número do cartão NUNCA passa por aqui).
   * Aprovado → devolve ok; recusado → devolve o motivo já traduzido.
   */
  private async cobrarCartao(
    order: any,
    input: CriarPedidoInput,
  ): Promise<{ ok: true; gatewayOrderId: string; gatewayChargeId: string | null } | { ok: false; error: string }> {
    const storeCode = this.lojaDoDinheiro();
    const cfg = await this.configPagarme(storeCode);
    const valorCentavos = Math.round(this.dinheiro(input.total) * 100);
    const parcelas = Math.max(1, Math.min(12, Number(input.payment.installments || 1)));
    const cpf = this.digits(input.customer.cpf);
    const end = input.shippingAddress;

    const body: any = {
      code: order.wcOrderNumber,
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

    let resp: any;
    try {
      resp = await firstValueFrom(
        this.http.post(`${this.BASE_URL}/orders`, body, {
          headers: {
            Authorization: this.authHeader(cfg.apiKey),
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }),
      );
    } catch (e: any) {
      const data = e?.response?.data;
      this.logger.error(
        `[loja] cartão HTTP ${e?.response?.status} pedido=${order.wcOrderNumber}: ${JSON.stringify(data || e?.message)}`,
      );
      return { ok: false, error: this.mensagemRecusa(data) };
    }

    const gw = resp.data;
    const charge = (gw?.charges || [])[0];
    const aprovado = gw?.status === 'paid' || charge?.status === 'paid';

    // Registra no MESMO PagarmePayment do PDV/live — assim a conciliação, o
    // painel de pagamentos e o webhook público enxergam a venda do site.
    try {
      await (this.prisma as any).pagarmePayment.create({
        data: {
          saleId: order.id,
          storeCode,
          pagarmeOrderId: gw.id,
          pagarmeChargeId: charge?.id || null,
          method: 'credit_card',
          valor: this.dinheiro(input.total),
          status: aprovado ? 'paid' : 'failed',
          paidAt: aprovado ? new Date() : null,
        },
      });
    } catch (e: any) {
      this.logger.warn(`[loja] PagarmePayment não gravado (cobrança seguiu): ${e?.message || e}`);
    }

    if (!aprovado) {
      this.logger.warn(
        `[loja] cartão recusado pedido=${order.wcOrderNumber} order=${gw?.id} status=${gw?.status}/${charge?.status}`,
      );
      return { ok: false, error: this.mensagemRecusa(gw) };
    }

    return { ok: true, gatewayOrderId: gw.id, gatewayChargeId: charge?.id || null };
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
    if (erro) return { ok: false, error: erro };

    /**
     * A CONTA É REFEITA ANTES DE QUALQUER COISA (bloco A).
     *
     * Vem antes até do CRM: preço errado, peça esgotada ou despublicada não
     * viram nem lead — viram uma frase pedindo pra recarregar a página. E vem
     * antes de `criarOrder` porque o Order precisa nascer já com o valor certo
     * (é dele que a cobrança e a etiqueta saem).
     */
    const conta = await this.reprecificar(input);
    if (!conta.ok) return { ok: false, error: conta.erro };

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
      return { ok: false, error: 'Não conseguimos abrir o seu pedido agora. Tente de novo em instantes. 💜' };
    }

    // ── Cobrança ──
    let paymentInfo: any = {
      method: input.payment.method,
      installments: input.payment.method === 'card' ? Number(input.payment.installments || 1) : null,
      gatewayOrderId: null,
      gatewayChargeId: null,
      pix: null,
    };

    try {
      if (input.payment.method === 'pix') {
        const r = await this.cobrarPix(order, input);
        paymentInfo = { ...paymentInfo, gatewayOrderId: r.gatewayOrderId, pix: r.pix };
      } else {
        const r = await this.cobrarCartao(order, input);
        if (!r.ok) {
          // "Cartão recusado NÃO cria pedido": apaga o Order recém-criado (os
          // itens caem por cascade; ainda não há histórico/pick-order pendurado)
          // pra retaguarda não encher de pedido fantasma. Se o delete falhar,
          // pelo menos cancela — nunca deixa em awaiting_payment eterno.
          // O PagarmePayment status='failed' FICA (não tem FK): é registro de
          // tentativa e é justamente o que a conciliação quer enxergar.
          await this.descartarPedido(order.id);
          return { ok: false, error: r.error };
        }
        paymentInfo = {
          ...paymentInfo,
          gatewayOrderId: r.gatewayOrderId,
          gatewayChargeId: r.gatewayChargeId,
        };
      }
    } catch (e: any) {
      this.logger.error(`[loja] cobrança falhou pedido=${order.wcOrderNumber}: ${e?.message || e}`);
      await this.descartarPedido(order.id);
      return {
        ok: false,
        error: 'Não conseguimos iniciar o pagamento agora. Tente de novo em instantes. 💜',
      };
    }

    await (this.prisma as any).order.update({
      where: { id: order.id },
      data: { paymentInfo: JSON.stringify(paymentInfo) },
    });

    this.logger.log(
      `[loja] pedido ${order.wcOrderNumber} criado (${input.payment.method}) R$ ${this.dinheiro(input.total).toFixed(2)}`,
    );

    // Cartão aprovado paga na hora — o webhook que chega depois vira no-op.
    if (input.payment.method === 'card') {
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
        discount: this.dinheiro(conta.descontoCupom + conta.descontoPix),
        couponDiscount: this.dinheiro(conta.descontoCupom),
        pixDiscount: this.dinheiro(conta.descontoPix),
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
  async buscarPedido(id: string): Promise<{ ok: boolean; order?: any; error?: string }> {
    const order = await (this.prisma as any).order
      .findFirst({ where: { id, source: 'ecommerce' }, include: { items: true } })
      .catch(() => null);
    if (!order) return { ok: false, error: 'Pedido não encontrado.' };

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
              carrier: order.carrier || null,
              // Link direto dos Correios: colar o código no site deles é o
              // passo que faz a cliente desistir e ligar.
              url: `https://rastreamento.correios.com.br/app/index.php?objeto=${encodeURIComponent(order.trackingCode)}`,
            }
          : null,
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
