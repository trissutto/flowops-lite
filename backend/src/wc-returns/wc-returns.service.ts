import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';

/**
 * Troca/devolução de QUALQUER venda online, no balcão da loja física.
 *
 * Cenário de uso real:
 *   Cliente comprou online → recebeu (ou retirou) → tamanho errado → leva
 *   numa loja física → a loja registra a troca aqui → o estoque entra na
 *   loja QUE RECEBEU a peça.
 *
 * ⚠️ A BUSCA LÊ A TABELA `orders` DO FLOW, NÃO O WOOCOMMERCE.
 *
 * Até 21/08/2026 `search`/`getOrderForReturn` batiam 100% na API do
 * WooCommerce. Só que hoje existem QUATRO origens de venda online e três
 * delas têm `wcOrderId` SINTÉTICO — não existem no WooCommerce
 * ([[wcorderid-sintetico-guarda]]):
 *
 *   | source       | número     | faixa wcOrderId | existe no WC? |
 *   |--------------|------------|-----------------|---------------|
 *   | site         | 198143     | real            | sim (site velho) |
 *   | ecommerce    | LP-000123  | 950.000.000+    | NÃO (site novo)  |
 *   | pdv_online   | ON-000085  | 960.000.000+    | NÃO              |
 *   | live         | LIVE-74    | 900.000.000+    | NÃO              |
 *
 * Buscar essas no WC dá 404, o catch engolia e a tela dizia "nenhum pedido
 * encontrado" — falha silenciosa. Depois da virada de 19/08 o WooCommerce
 * parou de receber pedido novo, então 100% das trocas futuras cairiam nesse
 * buraco. O Flow tem TODAS as quatro origens com itens e SKU, então a busca
 * passou a ler de lá e o WC virou só rede de segurança pra pedido antigo.
 *
 * ⚠️ `wcOrderNumber` NÃO é único: a live grava o número da LIVE em toda
 * sacolinha daquela transmissão (42 números repetidos cobrindo 102 pedidos —
 * "LIVE-57" são 4 clientes diferentes). Por isso a busca devolve LISTA e quem
 * identifica o pedido é o `wcOrderId`, esse sim único.
 *
 * Prazo de troca: configurável via SystemSetting `troca.prazoDias`
 * (default 7 dias do recebimento — fallback: 30 dias do envio).
 */
@Injectable()
export class WcReturnsService {
  private readonly logger = new Logger(WcReturnsService.name);

  // Default: 7 dias úteis do envio. Configurável via SystemSetting
  private readonly DEFAULT_PRAZO_DIAS = 7;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly wc: WooCommerceService,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────

  async getPrazoDias(): Promise<number> {
    try {
      const cfg = await (this.prisma as any).systemSetting.findUnique({
        where: { key: 'troca.prazoDias' },
      });
      const n = parseInt(cfg?.value || '', 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      // ignore — usa default
    }
    return this.DEFAULT_PRAZO_DIAS;
  }

  async setPrazoDias(dias: number): Promise<number> {
    if (!Number.isFinite(dias) || dias <= 0 || dias > 365) {
      throw new BadRequestException('Prazo inválido (1-365 dias)');
    }
    await (this.prisma as any).systemSetting.upsert({
      where: { key: 'troca.prazoDias' },
      create: { key: 'troca.prazoDias', value: String(dias) },
      update: { value: String(dias) },
    });
    return dias;
  }

  // ── Busca pedidos WC pra troca ──────────────────────────────────────

  /**
   * Busca pedidos do WC por nome do cliente OU número do pedido.
   * Retorna lista enxuta com status, prazo, itens.
   */
  async search(input: { q: string; limit?: number }) {
    const q = String(input.q || '').trim();
    if (!q || q.length < 2) {
      throw new BadRequestException('Busque por nome, CPF ou nº do pedido (mínimo 2 caracteres)');
    }

    const prazoDias = await this.getPrazoDias();
    const limit = Math.min(50, Math.max(5, input.limit || 20));
    const digitos = q.replace(/\D/g, '');

    // Nome · nº do pedido (LP-000123, ON-000085, LIVE-74, 198143) · CPF ·
    // telefone. CPF e telefone são comparados só por DÍGITOS: a mesma coluna
    // guarda '041.895.178-01' e '32721881850'.
    const rows: any[] = await (this.prisma as any).$queryRawUnsafe(
      `SELECT o.id, o.wc_order_id, o.wc_order_number, o.status, o.source,
              o.customer_name, o.customer_cpf, o.customer_email, o.customer_phone,
              o.shipping_cep, o.shipping_address, o.total_amount, o.tracking_code,
              o.is_pickup, o.pickup_store_code,
              o.wc_date_created, o.paid_at, o.delivered_at
         FROM orders o
        WHERE o.status NOT IN ('cancelled', 'payment_failed')
          AND ( o.customer_name    ILIKE $1
             OR o.wc_order_number  ILIKE $1
             OR ($2 <> '' AND regexp_replace(coalesce(o.customer_cpf, ''),   '\\D', '', 'g') = $2)
             OR ($2 <> '' AND regexp_replace(coalesce(o.customer_phone, ''), '\\D', '', 'g') LIKE $3) )
        ORDER BY o.wc_date_created DESC NULLS LAST
        LIMIT ${limit}`,
      `%${q}%`,
      digitos.length >= 8 ? digitos : '',
      `%${digitos}%`,
    );

    if (!rows.length) return [];

    const orderIds = rows.map((r) => r.id);
    const wcOrderIds = rows.map((r) => Number(r.wc_order_id)).filter(Boolean);

    const [items, previousReturns] = await Promise.all([
      (this.prisma as any).orderItem.findMany({ where: { orderId: { in: orderIds } } }),
      (this.prisma as any).wcReturnRequest.findMany({
        where: { wcOrderId: { in: wcOrderIds } },
        include: { items: true },
      }),
    ]);

    const itemsByOrder = new Map<string, any[]>();
    for (const it of items as any[]) {
      const list = itemsByOrder.get(it.orderId) || [];
      list.push(it);
      itemsByOrder.set(it.orderId, list);
    }
    const returnsByOrder = new Map<number, any[]>();
    for (const r of previousReturns as any[]) {
      const list = returnsByOrder.get(r.wcOrderId) || [];
      list.push(r);
      returnsByOrder.set(r.wcOrderId, list);
    }

    return rows.map((o) =>
      this.formatFlowOrder(
        o,
        itemsByOrder.get(o.id) || [],
        prazoDias,
        returnsByOrder.get(Number(o.wc_order_id)) || [],
      ),
    );
  }

  /**
   * Detalhe de UM pedido pra tela de troca (com itens disponíveis).
   *
   * Lê o Flow primeiro. O WooCommerce só entra como rede de segurança pra
   * pedido REAL antigo que por algum motivo não esteja na tabela `orders` —
   * e nunca pra faixa sintética, onde a chamada só produziria 404 → 500.
   */
  async getOrderForReturn(wcOrderId: number) {
    const prazoDias = await this.getPrazoDias();

    const previousReturns = await (this.prisma as any).wcReturnRequest.findMany({
      where: { wcOrderId },
      include: { items: true },
    });

    const flow = await (this.prisma as any).order.findFirst({
      where: { wcOrderId },
      include: { items: true },
    });

    if (flow) {
      const row = {
        id: flow.id,
        wc_order_id: flow.wcOrderId,
        wc_order_number: flow.wcOrderNumber,
        status: flow.status,
        source: flow.source,
        customer_name: flow.customerName,
        customer_cpf: flow.customerCpf,
        customer_email: flow.customerEmail,
        customer_phone: flow.customerPhone,
        shipping_cep: flow.shippingCep,
        shipping_address: flow.shippingAddress,
        total_amount: flow.totalAmount,
        tracking_code: flow.trackingCode,
        is_pickup: flow.isPickup,
        pickup_store_code: flow.pickupStoreCode,
        wc_date_created: flow.wcDateCreated,
        paid_at: flow.paidAt,
        delivered_at: flow.deliveredAt,
      };
      return this.formatFlowOrder(row, flow.items || [], prazoDias, previousReturns, true);
    }

    if (wcOrderId >= 900_000_000) {
      throw new NotFoundException(
        `Pedido ${wcOrderId} não está no Flow. Pedido de live/site novo/online não existe no WooCommerce — não há onde buscar.`,
      );
    }

    const o = await this.wc.getOrder(wcOrderId).catch(() => null);
    if (!o) throw new NotFoundException(`Pedido ${wcOrderId} não encontrado`);
    return this.formatOrder(o, prazoDias, previousReturns, /*detailed*/ true);
  }

  /**
   * Formata pedido da tabela `orders` do Flow no MESMO shape que a tela já
   * consumia do WooCommerce — a tela não sabe (nem precisa saber) de onde veio.
   */
  private formatFlowOrder(
    o: any,
    orderItems: any[],
    prazoDias: number,
    previousReturns: any[],
    detailed = false,
  ) {
    // Base do prazo: a ENTREGA quando o rastreio confirmou (é o que a política
    // promete — "7 dias do recebimento"), senão o pagamento, senão a data do
    // pedido. Retirada em loja não tem rastreio e cai no pagamento.
    const baseDate = o.delivered_at
      ? new Date(o.delivered_at)
      : o.paid_at
      ? new Date(o.paid_at)
      : o.wc_date_created
      ? new Date(o.wc_date_created)
      : null;
    const diasDesde = baseDate
      ? Math.floor((Date.now() - baseDate.getTime()) / 86_400_000)
      : null;

    const devolvidoBySku = new Map<string, number>();
    for (const r of previousReturns as any[]) {
      for (const it of r.items || []) {
        devolvidoBySku.set(it.sku, (devolvidoBySku.get(it.sku) || 0) + (it.qty || 0));
      }
    }

    const items = (orderItems || []).map((it: any) => {
      const sku = String(it.sku ?? '').trim();
      const qty = Number(it.quantity ?? it.qty) || 1;
      const jaDev = devolvidoBySku.get(sku) || 0;
      const precoUnit = Number(it.unitPrice ?? it.unit_price) || 0;
      const nome = it.productName ?? it.product_name ?? sku;
      const variacao = [it.cor, it.tamanho].filter(Boolean).join(' · ');
      return {
        sku,
        productName: variacao && !String(nome).includes(variacao) ? `${nome} · ${variacao}` : nome,
        qty,
        precoUnit: Math.round(precoUnit * 100) / 100,
        total: Math.round(precoUnit * qty * 100) / 100,
        jaDevolvido: jaDev,
        disponivel: Math.max(0, qty - jaDev),
      };
    });

    // shipping_address é JSON em texto — cidade/UF são só pra vendedora
    // conferir que é a cliente certa, então falha de parse não pode derrubar.
    let cidade: string | null = null;
    let uf: string | null = null;
    try {
      const end =
        typeof o.shipping_address === 'string'
          ? JSON.parse(o.shipping_address)
          : o.shipping_address || {};
      cidade = end?.city || end?.cidade || null;
      uf = end?.state || end?.uf || null;
    } catch {
      /* endereço fora do formato — segue sem cidade */
    }

    return {
      wcOrderId: Number(o.wc_order_id),
      wcOrderNumber: String(o.wc_order_number || o.wc_order_id),
      status: o.status,
      source: o.source,
      total: Number(o.total_amount) || 0,
      dateCreated: o.wc_date_created || null,
      datePaid: o.paid_at || null,
      dateCompleted: o.delivered_at || null,
      diasDesde,
      prazoDias,
      dentroDoPrazo: diasDesde != null ? diasDesde <= prazoDias : true,
      diasRestantes: diasDesde != null ? Math.max(0, prazoDias - diasDesde) : null,
      customerName: o.customer_name || null,
      customerCpf: o.customer_cpf || null,
      customerEmail: o.customer_email || null,
      customerPhone: o.customer_phone || null,
      shippingCity: cidade,
      shippingState: uf,
      items: detailed ? items : items.slice(0, 5),
      itemCount: items.length,
      previousReturnsCount: previousReturns.length,
      previousReturnsValor: (previousReturns as any[]).reduce(
        (s, r) => s + (Number(r.valorTotal) || 0),
        0,
      ),
    };
  }

  /**
   * Formata pedido WC pra resposta consistente.
   */
  private formatOrder(
    o: any,
    prazoDias: number,
    previousReturns: any[],
    detailed = false,
  ) {
    // Datas: usamos date_paid OU date_completed pra base do prazo.
    // Fallback: date_created.
    const dataBase =
      o.date_paid_gmt ||
      o.date_completed_gmt ||
      o.date_paid ||
      o.date_completed ||
      o.date_created_gmt ||
      o.date_created;
    const baseDate = dataBase ? new Date(dataBase) : null;
    const hoje = new Date();
    const diasDesde = baseDate
      ? Math.floor((hoje.getTime() - baseDate.getTime()) / 86_400_000)
      : null;
    const dentroDoPrazo =
      diasDesde != null ? diasDesde <= prazoDias : true; // sem data → assume sim

    // Quantidades já devolvidas por SKU
    const devolvidoBySku = new Map<string, number>();
    for (const r of previousReturns as any[]) {
      for (const it of r.items || []) {
        devolvidoBySku.set(it.sku, (devolvidoBySku.get(it.sku) || 0) + (it.qty || 0));
      }
    }

    const items = (o.line_items || []).map((it: any) => {
      const sku = String(it.sku || '').trim();
      const qty = Number(it.quantity) || 1;
      const jaDev = devolvidoBySku.get(sku) || 0;
      const disponivel = Math.max(0, qty - jaDev);
      // total/qty = preço unit (com desconto rateado se houver)
      const total = parseFloat(String(it.total ?? '0')) || 0;
      const precoUnit = qty > 0 ? total / qty : total;
      return {
        sku,
        productName: it.name || sku,
        qty,
        precoUnit: Math.round(precoUnit * 100) / 100,
        total: Math.round(total * 100) / 100,
        jaDevolvido: jaDev,
        disponivel,
      };
    });

    const billing = o.billing || {};
    const shipping = o.shipping || {};

    return {
      wcOrderId: Number(o.id),
      wcOrderNumber: o.number ? String(o.number) : String(o.id),
      status: o.status,
      total: parseFloat(String(o.total ?? '0')) || 0,
      // Datas
      dateCreated: o.date_created_gmt || o.date_created || null,
      datePaid: o.date_paid_gmt || o.date_paid || null,
      dateCompleted: o.date_completed_gmt || o.date_completed || null,
      diasDesde,
      prazoDias,
      dentroDoPrazo,
      diasRestantes:
        diasDesde != null ? Math.max(0, prazoDias - diasDesde) : null,
      // Cliente
      customerName: [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() || null,
      customerCpf: billing.cpf || null,
      customerEmail: billing.email || null,
      customerPhone: billing.phone || null,
      shippingCity: shipping.city || billing.city || null,
      shippingState: shipping.state || billing.state || null,
      // Itens
      items: detailed ? items : items.slice(0, 5),
      itemCount: items.length,
      // Devoluções anteriores
      previousReturnsCount: previousReturns.length,
      previousReturnsValor: (previousReturns as any[]).reduce(
        (s, r) => s + (Number(r.valorTotal) || 0),
        0,
      ),
    };
  }

  // ── Aceitar troca / devolução ───────────────────────────────────────

  private genCreditoCode(): string {
    const hex = Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    return `TROCA-${hex.padEnd(8, '0')}`;
  }

  /**
   * Aceita a troca/devolução: estorna estoque Giga DA LOJA receptora +
   * cria registro WcReturnRequest. Se modo=troca/credito, gera vale.
   */
  async accept(input: {
    wcOrderId: number;
    receivingStoreCode: string;
    modo: 'devolucao' | 'troca' | 'credito';
    items: Array<{ sku: string; qty: number; productName?: string }>;
    motivo?: string;
    obs?: string;
    creditoValidadeDias?: number;
    forceOutOfPrazo?: boolean;  // admin pode aceitar mesmo fora do prazo
    userId?: string;
    userName?: string;
  }) {
    const { wcOrderId, receivingStoreCode, modo, items, motivo, obs, userId, userName } = input;

    if (!['devolucao', 'troca', 'credito'].includes(modo)) {
      throw new BadRequestException(`Modo inválido: ${modo}`);
    }
    if (!items?.length) throw new BadRequestException('Selecione ao menos uma peça');

    // Loja receptora
    const store = await this.prisma.store.findUnique({
      where: { code: receivingStoreCode },
      select: { code: true, name: true } as any,
    });
    if (!store) {
      throw new BadRequestException(`Loja ${receivingStoreCode} não cadastrada`);
    }

    // Carrega pedido WC + valida prazo + saldo disponível
    const detail = await this.getOrderForReturn(wcOrderId);

    if (!detail.dentroDoPrazo && !input.forceOutOfPrazo) {
      throw new BadRequestException(
        `Pedido fora do prazo de troca (${detail.diasDesde} dias desde envio · prazo ${detail.prazoDias}). ` +
          `Pra forçar mesmo assim, marque "Aceitar fora do prazo".`,
      );
    }

    // Mapa de items disponíveis
    const itemBySku = new Map<string, any>();
    for (const it of detail.items) itemBySku.set(it.sku, it);

    // Valida cada item solicitado
    const itemsToCreate: any[] = [];
    let valorTotal = 0;
    for (const reqItem of items) {
      const sku = String(reqItem.sku || '').trim();
      if (!sku) throw new BadRequestException('Item sem SKU');
      const original = itemBySku.get(sku);
      if (!original) {
        throw new BadRequestException(`SKU ${sku} não está no pedido ${wcOrderId}`);
      }
      const qty = Math.max(1, Math.floor(Number(reqItem.qty) || 0));
      if (qty > original.disponivel) {
        throw new BadRequestException(
          `${original.productName} (${sku}): pediu ${qty} mas só tem ${original.disponivel} disponível pra devolução.`,
        );
      }
      const totalItem = original.precoUnit * qty;
      valorTotal += totalItem;
      itemsToCreate.push({
        sku,
        productName: reqItem.productName || original.productName,
        qty,
        precoUnit: original.precoUnit,
        total: Math.round(totalItem * 100) / 100,
      });
    }
    valorTotal = Math.round(valorTotal * 100) / 100;

    // Estorna estoque Giga na loja receptora
    const stockAttempts: Array<{ sku: string; ok: boolean; error?: string }> = [];
    try {
      const result = await this.erp.increaseStockAsync(
        itemsToCreate.map((it) => ({
          sku: it.sku,
          qty: it.qty,
          storeCode: receivingStoreCode,
        })),
      );
      if (result.success) {
        for (const it of itemsToCreate) stockAttempts.push({ sku: it.sku, ok: true });
      } else {
        for (const it of itemsToCreate)
          stockAttempts.push({ sku: it.sku, ok: false, error: result.error });
      }
    } catch (e: any) {
      for (const it of itemsToCreate)
        stockAttempts.push({ sku: it.sku, ok: false, error: e?.message || String(e) });
    }

    // Crédito (se troca/credito)
    let creditoCode: string | null = null;
    let creditoValidade: Date | null = null;
    if (modo === 'troca' || modo === 'credito') {
      creditoCode = this.genCreditoCode();
      const dias = modo === 'troca' ? 1 : Math.max(1, input.creditoValidadeDias || 90);
      creditoValidade = new Date(Date.now() + dias * 86400_000);
    }

    // Persiste
    const ret = await (this.prisma as any).wcReturnRequest.create({
      data: {
        wcOrderId,
        wcOrderNumber: detail.wcOrderNumber || String(wcOrderId),
        customerName: detail.customerName,
        customerCpf: detail.customerCpf,
        customerEmail: detail.customerEmail,
        receivingStoreCode: (store as any).code,
        receivingStoreName: (store as any).name,
        modo,
        valorTotal,
        status: 'completed',
        diasDesdeEnvio: detail.diasDesde ?? null,
        dentroDoPrazo: detail.dentroDoPrazo,
        creditoCode,
        creditoValidade,
        userId: userId || null,
        userName: userName || null,
        motivo: motivo || null,
        obs: obs || null,
        items: {
          create: itemsToCreate.map((it, idx) => ({
            sku: it.sku,
            productName: it.productName,
            qty: it.qty,
            precoUnit: it.precoUnit,
            total: it.total,
            stockReturnedAt: stockAttempts[idx]?.ok ? new Date() : null,
            stockError: stockAttempts[idx]?.ok ? null : stockAttempts[idx]?.error || null,
          })),
        },
      },
      include: { items: true },
    });

    this.logger.log(
      `[wc-return] ${ret.id.slice(0, 8)} pedido=${wcOrderId} loja=${receivingStoreCode} ` +
        `modo=${modo} R$${valorTotal.toFixed(2)} ` +
        (creditoCode ? `código=${creditoCode}` : ''),
    );

    // ── O VALE PRECISA EXISTIR ONDE A CLIENTE VAI GASTAR ──────────────
    //
    // Até 21/08/2026 o vale desta tela só virava CUPOM DO WOOCOMMERCE. Ele
    // não funcionava em lugar nenhum que importa hoje:
    //   · no PDV, `addPayment` procura em `pdv_returns` e depois em
    //     `site_cupons` com origem='troca' — nunca em `wc_return_requests`;
    //   · no site NOVO, o CupomService lê `site_cupons`;
    //   · o site VELHO (único que lia o cupom WC) parou de vender em 19/08.
    // Ou seja: a loja entregava um código que ela mesma não conseguia
    // aceitar no caixa. Agora o vale nasce em `site_cupons` — o MESMO
    // caminho do portal de trocas ([[vale-troca-so-apos-conferencia]]).
    //
    // `origem: 'troca'` é obrigatório: é o único valor que o PDV aceita.
    // O vale é NOMINAL — sem CPF na venda original ele não passa, de
    // propósito (código que vaza em print vira compra de outra pessoa).
    let valeNoCaixaOk = false;
    if (creditoCode && (modo === 'troca' || modo === 'credito')) {
      const cpfVale = String(detail.customerCpf || '').replace(/\D/g, '');
      try {
        await (this.prisma as any).siteCupom.create({
          data: {
            code: creditoCode,
            label: `Vale-troca pedido ${detail.wcOrderNumber || wcOrderId}`,
            tipo: 'fixed',
            valor: valorTotal,
            fimEm: creditoValidade,
            usoMaximo: 1,
            ativo: true,
            cpf: cpfVale.length === 11 ? cpfVale : null,
            origem: 'troca',
            atualizadoPor: `troca loja ${receivingStoreCode}`,
          },
        });
        valeNoCaixaOk = true;
      } catch (e: any) {
        // Não derruba a troca com a cliente no balcão — mas grita no log,
        // porque vale que não entra em site_cupons é promessa quebrada.
        this.logger.error(
          `[wc-return ${ret.id.slice(0, 8)}] vale ${creditoCode} NÃO entrou em site_cupons: ${e?.message || e}`,
        );
      }
      if (!cpfVale || cpfVale.length !== 11) {
        this.logger.warn(
          `[wc-return ${ret.id.slice(0, 8)}] vale ${creditoCode} sem CPF — não vai passar no caixa nem no site`,
        );
      }
    }

    // CUPOM WC: cria cupom de desconto no WooCommerce com o mesmo codigo
    // TROCA-XXXX, valido por 30 dias (independente do creditoValidadeDias
    // local — no site da pra dar mais tempo pra cliente usar). Cliente
    // aplica esse codigo no checkout do lurds.com.br pra abater o valor.
    //
    // Se a criacao falhar (WC fora, key invalida, etc), nao bloqueia a
    // troca — loga warning e segue. Admin pode criar manualmente depois.
    if (creditoCode && (modo === 'troca' || modo === 'credito')) {
      try {
        const expiresAt = new Date(Date.now() + 30 * 86400_000);
        const couponResult = await this.wc.createDiscountCoupon({
          code: creditoCode,
          amount: valorTotal,
          expiresAt,
          description: `Troca/credito pedido WC #${detail.wcOrderNumber || wcOrderId}`,
          customerEmail: detail.customerEmail || undefined,
        });
        if (couponResult.ok) {
          this.logger.log(
            `[wc-return] cupom WC criado: ${creditoCode} (id=${couponResult.couponId}) ` +
            `R$${valorTotal.toFixed(2)} valido ate ${expiresAt.toISOString().slice(0, 10)}`,
          );
        } else {
          this.logger.warn(
            `[wc-return] FALHA ao criar cupom WC ${creditoCode}: ${couponResult.error}. ` +
            `Vale-troca local funciona normal, mas cliente nao pode usar no site ate criar manualmente.`,
          );
        }
      } catch (e: any) {
        this.logger.warn(`[wc-return] Erro inesperado ao criar cupom WC: ${e?.message || e}`);
      }
    }

    // `valeNoCaixaOk` sobe pra tela avisar a vendedora ANTES de ela mandar a
    // cliente pro caixa com um código que não vai passar.
    return { ...ret, valeNoCaixaOk };
  }

  // ── Listagem ────────────────────────────────────────────────────────

  async list(input: {
    storeCode?: string;
    customerCpf?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }) {
    const where: any = {};
    if (input.storeCode) where.receivingStoreCode = input.storeCode;
    if (input.customerCpf) where.customerCpf = input.customerCpf;
    if (input.from || input.to) {
      where.createdAt = {};
      if (input.from) where.createdAt.gte = input.from;
      if (input.to) where.createdAt.lte = input.to;
    }
    return (this.prisma as any).wcReturnRequest.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, input.limit || 50)),
    });
  }
}
