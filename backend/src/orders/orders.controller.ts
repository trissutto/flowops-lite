import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { startOfDayBR } from '../lib/date-br';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OrderStatus } from '../common/enums';
import { StockService } from '../stock/stock.service';
import { RoutingService } from '../routing/routing.service';
import { PrismaService } from '../prisma/prisma.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { ErpService } from '../erp/erp.service';
import { extractAttribution } from '../woocommerce/attribution.util';
import { extractCpf, detectPickup, extractVariantFromLineItem } from '../woocommerce/wc-order-extract.util';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly stock: StockService,
    private readonly routing: RoutingService,
    private readonly prisma: PrismaService,
    private readonly wc: WooCommerceService,
    private readonly erp: ErpService,
  ) {}

  // ---------- Rotas estáticas PRIMEIRO (senão o `:id` come) ----------

  @Get('stats/counts')
  counts() {
    return this.orders.countByStatus();
  }

  /**
   * Financeiro/analítico: KPIs + breakdowns no intervalo [from, to].
   * Ex: GET /orders/analytics?from=2026-04-01&to=2026-04-21
   * Sem defaults: se um dos dois faltar, retorna 400.
   */
  @Get('analytics')
  async analytics(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('Parâmetros "from" e "to" são obrigatórios (YYYY-MM-DD).');
    }
    try {
      return await this.orders.analytics(from, to);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Falha ao gerar analítico');
    }
  }

  /**
   * Lista pedidos DIRETO do WooCommerce (espelho do admin WP).
   * Não usa banco local. Contadores e dados vêm sempre atualizados.
   */
  @Get('wc')
  async wcList(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('search') search?: string,
    @Query('after') after?: string,
    @Query('before') before?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    // Quando filtra por loja, pega per_page MAIOR pra compensar o filtro local.
    // LIMITE 100 — WooCommerce REST API REJEITA per_page > 100 com 500.
    const effectivePerPage = storeCode
      ? Math.min(100, Number(perPage || 50) * 2)
      : (perPage ? Number(perPage) : 50);

    const res = await this.wc.listOrders({
      status,
      page: page ? Number(page) : 1,
      perPage: effectivePerPage,
      search,
      after,
      before,
    });

    // Enriquecimento: pra cada pedido retornado, anexa
    //   - loja(s) responsável(is) pela separação (via PickOrder local)
    //   - rastreio (trackingCode/carrier) do pick-order (quem enviou bota aqui)
    //   - flag `shipped` se TODOS os pick-orders do pedido já foram enviados
    // Tudo em 1 query só (batch) — não faz N+1.
    const wcIds = res.data.map((o: any) => Number(o.id)).filter(Boolean);
    const ordersWithPicks =
      wcIds.length > 0
        ? await (this.prisma as any).order.findMany({
            where: { wcOrderId: { in: wcIds } },
            select: {
              wcOrderId: true,
              sellerId: true,
              sellerName: true,
              pickOrders: {
                select: {
                  status: true,
                  trackingCode: true,
                  carrier: true,
                  store: { select: { code: true, name: true } },
                },
              },
            },
          })
        : [];
    const picksByWcId = new Map<number, any[]>();
    const sellerByWcId = new Map<number, { id: string | null; name: string | null }>();
    for (const ord of ordersWithPicks) {
      picksByWcId.set(ord.wcOrderId, ord.pickOrders || []);
      sellerByWcId.set(ord.wcOrderId, {
        id: ord.sellerId ?? null,
        name: ord.sellerName ?? null,
      });
    }

    const data = res.data.map((o: any) => {
      const picks = picksByWcId.get(Number(o.id)) || [];
      const pickOrders = picks.map((p: any) => ({
        storeCode: p.store?.code ?? null,
        storeName: p.store?.name ?? null,
        status: p.status,
        trackingCode: p.trackingCode ?? null,
        carrier: p.carrier ?? null,
      }));
      // "shipped" = TODOS os pick-orders enviados (quando há >1 loja, todas precisam marcar shipped)
      const allShipped =
        pickOrders.length > 0 && pickOrders.every((p) => p.status === 'shipped');
      // 1º tracking disponível (normalmente só há 1 loja por pedido)
      const firstTracking = pickOrders.find((p) => !!p.trackingCode);
      return {
        id: o.id,
        number: o.number,
        status: o.status,
        dateCreatedGmt: o.date_created_gmt ?? o.date_created,
        total: o.total,
        currency: o.currency,
        customerName: `${o.billing?.first_name ?? ''} ${o.billing?.last_name ?? ''}`.trim(),
        // Título do método de envio (SEDEX / PAC / Retirar na Loja de X / etc)
        // — lido direto do shipping_lines que o WC já devolve na listagem.
        shippingMethod: o.shipping_lines?.[0]?.method_title ?? null,
        // UF do destinatário — pra resolver "PROMOCIONAL" → SEDEX (SP) ou PAC.
        shippingState: o.shipping?.state ?? o.billing?.state ?? null,
        // NOVO: loja responsável + rastreio + flag enviado
        pickOrders,
        shipped: allShipped,
        trackingCode: firstTracking?.trackingCode ?? null,
        trackingCarrier: firstTracking?.carrier ?? null,
        // Vendedora atribuída (cache denormalizado no Order local)
        sellerId: sellerByWcId.get(Number(o.id))?.id ?? null,
        sellerName: sellerByWcId.get(Number(o.id))?.name ?? null,
        // Origem do pedido (site/live) — 'source' já é a atribuição UTM do WC
        orderSource: 'site',
        ...extractAttribution(o.meta_data ?? []),
      };
    });

    // ── Pedidos da LIVE (source='live') — MESMA fila, MESMA linha ──
    // Vivem só no Flow (wcOrderId sintético). Mapeia o slug da aba pro status
    // local equivalente e devolve no formato idêntico ao das linhas do WC.
    const LIVE_STATUS_BY_SLUG: Record<string, string[]> = {
      processing: ['processing'],
      separacao: ['separating'],
      'em-separacao': ['separating'],
      completed: ['shipped', 'delivered'],
    };
    const liveStatuses = status ? LIVE_STATUS_BY_SLUG[status] : undefined;
    let liveRows: any[] = [];
    if (liveStatuses?.length) {
      const liveOrders = await (this.prisma as any).order.findMany({
        where: {
          source: 'live',
          status: { in: liveStatuses },
          ...(search
            ? {
                OR: [
                  { wcOrderNumber: { contains: search, mode: 'insensitive' } },
                  { customerName: { contains: search, mode: 'insensitive' } },
                  { customerPhone: { contains: search } },
                ],
              }
            : {}),
          ...(after ? { wcDateCreated: { gte: new Date(after) } } : {}),
          ...(before ? { wcDateCreated: { lte: new Date(before) } } : {}),
        },
        include: {
          pickOrders: {
            select: {
              status: true,
              trackingCode: true,
              carrier: true,
              store: { select: { code: true, name: true } },
            },
          },
        },
        orderBy: { wcDateCreated: 'desc' },
        take: 100,
      });
      liveRows = liveOrders.map((o: any) => {
        const pickOrders = (o.pickOrders || []).map((p: any) => ({
          storeCode: p.store?.code ?? null,
          storeName: p.store?.name ?? null,
          status: p.status,
          trackingCode: p.trackingCode ?? null,
          carrier: p.carrier ?? null,
        }));
        const allShipped =
          pickOrders.length > 0 && pickOrders.every((p: any) => p.status === 'shipped');
        const firstTracking = pickOrders.find((p: any) => !!p.trackingCode);
        let addrState: string | null = null;
        try { addrState = JSON.parse(o.shippingAddress || '{}')?.state ?? null; } catch {}
        return {
          id: o.wcOrderId,
          number: o.wcOrderNumber,
          status,
          dateCreatedGmt: (o.wcDateCreated ?? o.createdAt)?.toISOString?.() ?? null,
          total: String(o.totalAmount ?? 0),
          currency: 'BRL',
          customerName: o.customerName ?? '',
          shippingMethod: o.shippingMethod ?? 'LIVE',
          shippingState: addrState,
          pickOrders,
          shipped: allShipped,
          trackingCode: firstTracking?.trackingCode ?? null,
          trackingCarrier: firstTracking?.carrier ?? null,
          sellerId: o.sellerId ?? null,
          sellerName: o.sellerName ?? null,
          orderSource: 'live',
          origem: 'Live Commerce',
        };
      });
    }
    const dataMerged = [...liveRows, ...data];

    // Filtro por loja responsável (aplicado APÓS enriquecer com pickOrders)
    // Match flexível: normaliza removendo acentos + uppercase + compara code OU name
    const normalize = (s: any) =>
      String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // remove diacríticos (acentos)
        .toUpperCase()
        .trim();
    const targetNorm = normalize(storeCode);
    const filteredData = storeCode
      ? dataMerged.filter((o: any) =>
          (o.pickOrders || []).some((p: any) => {
            const codeN = normalize(p.storeCode);
            const nameN = normalize(p.storeName);
            return codeN === targetNorm || nameN === targetNorm;
          }),
        )
      : dataMerged;

    return {
      data: filteredData,
      total: storeCode ? filteredData.length : res.total + liveRows.length,
      totalPages: storeCode ? 1 : res.totalPages,
      filteredByStore: !!storeCode,
    };
  }

  /**
   * Lista lojas com contagem de pedidos em separação por loja.
   * Usado pelo dropdown de filtro na tela /pedidos.
   */
  @Get('wc/stores-load')
  async wcStoresLoad() {
    // Pega lojas ativas + conta pedidos cuja pick-order ainda não foi enviada
    const stores = await (this.prisma as any).store.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, city: true, state: true },
      orderBy: { name: 'asc' },
    });

    // Conta pick-orders em aberto por loja (status != shipped/cancelled)
    const countsRaw = await (this.prisma as any).pickOrder.groupBy({
      by: ['storeId'],
      where: { status: { notIn: ['shipped', 'cancelled'] } },
      _count: { _all: true },
    });
    const countMap = new Map<string, number>();
    for (const c of countsRaw) countMap.set(c.storeId, c._count._all);

    return {
      stores: stores.map((s: any) => ({
        code: s.code,
        name: s.name,
        city: s.city,
        state: s.state,
        openOrders: countMap.get(s.id) || 0,
      })),
    };
  }

  /**
   * GET /orders/wc/:wcOrderId/routing-audit
   *
   * Auditoria COMPLETA do roteamento de um pedido:
   *  - PickOrders atuais (lojas que estão/estavam separando)
   *  - Items + assignedStoreId (qual loja foi responsável por cada peça)
   *  - OrderHistory completo (mudanças de status + swaps)
   *  - Detecção de duplicidade (lojas com mesmo item)
   *
   * Usado pra investigar "saiu por loja X mas começou por loja Y".
   */
  @Get('wc/:wcOrderId/routing-audit')
  async routingAudit(@Param('wcOrderId') wcOrderId: string) {
    const wcId = Number(wcOrderId);
    if (!wcId || isNaN(wcId)) {
      throw new Error('wcOrderId inválido');
    }

    const order = await (this.prisma as any).order.findFirst({
      where: { wcOrderId: wcId },
      include: {
        items: {
          select: {
            id: true,
            sku: true,
            quantity: true,
            assignedStoreId: true,
          },
        },
        pickOrders: {
          include: {
            store: { select: { code: true, name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
        history: {
          orderBy: { createdAt: 'asc' },
          take: 100,
        },
      },
    });

    if (!order) {
      return { found: false, wcOrderId: wcId };
    }

    // Enriquece items com nome da loja
    const storeMap = new Map<string, { code: string; name: string }>();
    const allStoreIds = new Set<string>();
    order.items.forEach((it: any) => it.assignedStoreId && allStoreIds.add(it.assignedStoreId));
    order.pickOrders.forEach((p: any) => allStoreIds.add(p.storeId));

    if (allStoreIds.size > 0) {
      const stores = await (this.prisma as any).store.findMany({
        where: { id: { in: Array.from(allStoreIds) } },
        select: { id: true, code: true, name: true },
      });
      stores.forEach((s: any) => storeMap.set(s.id, { code: s.code, name: s.name }));
    }

    // Detecta possível duplicidade: pick-orders ativos com mesmo SKU
    const activePickOrders = order.pickOrders.filter(
      (p: any) => !['cancelled'].includes(p.status),
    );
    const skusByStore: Record<string, string[]> = {};
    for (const it of order.items) {
      if (!it.assignedStoreId) continue;
      const loja = storeMap.get(it.assignedStoreId);
      const key = `${loja?.code || it.assignedStoreId}`;
      if (!skusByStore[key]) skusByStore[key] = [];
      skusByStore[key].push(it.sku);
    }
    const skuConflicts: Array<{ sku: string; stores: string[] }> = [];
    const allSkus = new Set(order.items.map((i: any) => i.sku));
    for (const sku of allSkus) {
      const stores = Object.entries(skusByStore).filter(([_, skus]) => skus.includes(sku as string)).map(([s]) => s);
      if (stores.length > 1) skuConflicts.push({ sku: sku as string, stores });
    }

    return {
      found: true,
      orderId: order.id,
      wcOrderId: wcId,
      status: order.status,
      createdAt: order.createdAt,
      pickOrders: order.pickOrders.map((p: any) => ({
        id: p.id,
        storeCode: p.store?.code,
        storeName: p.store?.name,
        status: p.status,
        trackingCode: p.trackingCode,
        carrier: p.carrier,
        isTransfer: p.isTransfer,
        transferToStoreCode: p.transferToStoreCode,
        issueReason: p.issueReason,
        issueNote: p.issueNote,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      items: order.items.map((it: any) => ({
        id: it.id,
        sku: it.sku,
        quantity: it.quantity,
        assignedStoreCode: it.assignedStoreId ? storeMap.get(it.assignedStoreId)?.code : null,
        assignedStoreName: it.assignedStoreId ? storeMap.get(it.assignedStoreId)?.name : null,
      })),
      history: order.history.map((h: any) => ({
        id: h.id,
        createdAt: h.createdAt,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        note: h.note,
        userId: h.userId,
      })),
      // FLAGS DE RISCO
      activePickOrderCount: activePickOrders.length,
      hasDuplicateRisk: skuConflicts.length > 0,
      skuConflicts,
      summary: {
        totalSwaps: order.history.filter((h: any) => (h.note || '').toLowerCase().includes('swap')).length,
        totalItems: order.items.length,
        totalPickOrders: order.pickOrders.length,
        firstPickOrderStore: order.pickOrders[0]?.store?.name,
        lastPickOrderStore: order.pickOrders[order.pickOrders.length - 1]?.store?.name,
      },
    };
  }

  /** Contadores por status (pra renderizar os filtros com número exato do WC). */
  @Get('wc/counts')
  async wcCounts() {
    const totals = await this.wc.countByStatus();
    const byStatus: Record<string, { name: string; total: number }> = {};
    let grand = 0;
    for (const t of totals) {
      byStatus[t.slug] = { name: t.name, total: t.total };
      grand += t.total;
    }
    // Soma os pedidos da LIVE (source='live', só existem no Flow) nos badges
    // das abas equivalentes: processing → Processando · separating → Em
    // separação · shipped/delivered → Concluídos.
    try {
      const liveCounts = await (this.prisma as any).order.groupBy({
        by: ['status'],
        where: { source: 'live' },
        _count: { _all: true },
      });
      const add = (slug: string, n: number) => {
        if (!n) return;
        byStatus[slug] = { name: byStatus[slug]?.name ?? slug, total: (byStatus[slug]?.total ?? 0) + n };
        grand += n;
      };
      for (const c of liveCounts) {
        const n = c._count._all;
        if (c.status === 'processing') add('processing', n);
        else if (c.status === 'separating') add('separacao', n);
        else if (c.status === 'shipped' || c.status === 'delivered') add('completed', n);
      }
    } catch { /* badge sem live é melhor que quebrar a tela */ }
    return { byStatus, grand };
  }

  /**
   * Conta pedidos com status=completed que foram concluídos HOJE (modified_after).
   * O WC marca como "completed" quando a baixa do pedido é confirmada — então
   * filtramos por modified_after = hoje 00:00 (timezone do servidor).
   *
   * Estratégia: pedimos só 1 item (per_page=1) e lemos o header x-wp-total.
   * Custo: 1 request HTTP, sem baixar dados.
   */
  @Get('wc/completed-today')
  async wcCompletedToday() {
    const start = startOfDayBR();
    const res = await this.wc.listOrders({
      status: 'completed',
      perPage: 1,
      page: 1,
      modifiedAfter: start.toISOString(),
    });
    return { total: res.total, since: start.toISOString() };
  }

  /** Detalhe de 1 pedido direto do WC. */
  @Get('wc/:wcId')
  async wcGetOne(@Param('wcId') wcId: string) {
    // Pedido da LIVE: monta o MESMO payload de detalhe a partir do Order local
    // (wcOrderId sintético — não existe no WooCommerce; buscar lá dava 500).
    const liveLocal = await (this.prisma as any).order.findUnique({
      where: { wcOrderId: Number(wcId) },
      include: {
        items: true,
        pickOrders: { select: { trackingCode: true, carrier: true } },
      },
    });
    if (liveLocal?.source === 'live') {
      let addr: any = {};
      try { addr = JSON.parse(liveLocal.shippingAddress || '{}'); } catch {}
      const liveCart = liveLocal.liveCartId
        ? await (this.prisma as any).livePdvCart
            .findUnique({ where: { id: liveLocal.liveCartId }, select: { freteCents: true, customerInstagram: true } })
            .catch(() => null)
        : null;
      const STATUS_SLUG: Record<string, string> = {
        processing: 'processing',
        separating: 'separacao',
        shipped: 'completed',
        delivered: 'completed',
        pending: 'pending',
        cancelled: 'cancelled',
      };
      const track = (liveLocal.pickOrders || []).find((p: any) => p.trackingCode);
      const stores = await this.prisma.store.findMany({
        where: { active: true },
        select: { code: true, name: true },
      });
      return {
        id: liveLocal.wcOrderId,
        number: liveLocal.wcOrderNumber,
        status: STATUS_SLUG[liveLocal.status] ?? liveLocal.status,
        dateCreatedGmt: (liveLocal.wcDateCreated ?? liveLocal.createdAt)?.toISOString?.() ?? null,
        dateModifiedGmt: liveLocal.updatedAt?.toISOString?.() ?? null,
        total: String(liveLocal.totalAmount ?? 0),
        currency: 'BRL',
        paymentMethodTitle: 'PIX (Live Commerce)',
        customerNote: liveCart?.customerInstagram ? `Instagram: @${liveCart.customerInstagram}` : '',
        billing: {
          first_name: liveLocal.customerName || '',
          last_name: '',
          email: liveLocal.customerEmail || '',
          phone: liveLocal.customerPhone || '',
        },
        shipping: addr,
        customerCpf: liveLocal.customerCpf || '',
        lineItems: (liveLocal.items || []).map((it: any) => ({
          id: it.id,
          name: it.productName,
          sku: it.sku,
          quantity: it.quantity,
          total: String((it.unitPrice ?? 0) * (it.quantity ?? 1)),
          price: it.unitPrice,
          image: null,
        })),
        shippingLines: [
          {
            method: liveLocal.shippingMethod ?? 'LIVE',
            total: liveCart ? String((liveCart.freteCents || 0) / 100) : '0',
          },
        ],
        tracking: {
          number: track?.trackingCode ?? '',
          carrier: track?.carrier ?? '',
          url: '',
        },
        pickup: {
          isPickup: !!liveLocal.isPickup,
          storeCode: liveLocal.pickupStoreCode ?? null,
          storeName: liveLocal.pickupStoreCode
            ? stores.find((s) => s.code === liveLocal.pickupStoreCode)?.name ?? null
            : null,
          shippingMethodTitle: liveLocal.shippingMethod ?? 'LIVE',
          unresolvedCityName: null,
        },
        attribution: { origem: 'Live Commerce', source: '(Live) ()' },
        sellerId: liveLocal.sellerId ?? null,
        sellerName: liveLocal.sellerName ?? null,
      };
    }

    const o = await this.wc.getOrder(Number(wcId));

    const getMeta = (key: string) => {
      const m = (o.meta_data ?? []).find((x: any) => x?.key === key);
      return m ? String(m.value ?? '') : '';
    };

    const attribution = extractAttribution(o.meta_data ?? []);
    const customerCpf = extractCpf(o);

    // Detecta retirada em loja (pra UI mostrar badge + destacar loja)
    const activeStores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });
    const pickup = detectPickup(o, activeStores);

    // Vendedora atribuída (cache denormalizado)
    const localOrder = await this.prisma.order.findFirst({
      where: { wcOrderId: Number(wcId) },
      select: { sellerId: true, sellerName: true },
    });

    return {
      id: o.id,
      number: o.number,
      status: o.status,
      dateCreatedGmt: o.date_created_gmt ?? o.date_created,
      dateModifiedGmt: o.date_modified_gmt ?? o.date_modified,
      total: o.total,
      currency: o.currency,
      paymentMethodTitle: o.payment_method_title,
      customerNote: o.customer_note,
      billing: o.billing ?? {},
      shipping: o.shipping ?? {},
      customerCpf,
      lineItems: (o.line_items ?? []).map((li: any) => ({
        id: li.id,
        name: li.name,
        sku: li.sku,
        quantity: li.quantity,
        total: li.total,
        price: li.price,
        image: li.image?.src ?? null,
      })),
      shippingLines: (o.shipping_lines ?? []).map((sl: any) => ({
        method: sl.method_title,
        total: sl.total,
      })),
      tracking: {
        number: getMeta('_tracking_number'),
        carrier: getMeta('_tracking_carrier') || getMeta('_tracking_provider'),
        url: getMeta('_tracking_url'),
      },
      pickup: {
        isPickup: pickup.isPickup,
        storeCode: pickup.pickupStoreCode,
        storeName: pickup.pickupStoreCode
          ? activeStores.find((s) => s.code === pickup.pickupStoreCode)?.name ?? null
          : null,
        shippingMethodTitle: pickup.shippingMethodTitle,
        unresolvedCityName: pickup.unresolvedCityName ?? null,
      },
      attribution,
      sellerId: localOrder?.sellerId ?? null,
      sellerName: localOrder?.sellerName ?? null,
    };
  }

  /**
   * Atualiza um pedido no WooCommerce (grava direto no site).
   * Body: { status?, trackingNumber?, trackingCarrier?, trackingUrl?, customerNote?, addNote? }
   *
   * ⚠ Hook importante: quando status === 'separacao' e ainda NÃO existe pick-order
   * local, este endpoint dispara o roteamento automático (cria pick-order, aloca loja
   * e emite socket). Isso é fonte única — todos os caminhos do front (bulk WhatsApp,
   * botão individual, wa.me, mudança manual de status) passam por aqui e ganham o
   * registro de qual loja é responsável. Sem este hook, pedido vira "Separação" sem
   * loja associada e o painel "Status ao vivo" fica vazio.
   */
  @Patch('wc/:wcId')
  async wcUpdate(
    @Param('wcId') wcId: string,
    @Body()
    body: {
      status?: string;
      trackingNumber?: string;
      trackingCarrier?: string;
      trackingUrl?: string;
      customerNote?: string;
      addNote?: { text: string; notifyCustomer?: boolean };
    },
  ) {
    const wcOrderId = Number(wcId);

    // Pedido da LIVE (source='live', wcOrderId sintético 900M+): existe SÓ no
    // Flow — nunca toca o WooCommerce. As mesmas ações (gerar separação, nota)
    // são aplicadas localmente.
    const localForSource = await (this.prisma as any).order.findUnique({
      where: { wcOrderId },
      select: { id: true, source: true, status: true },
    });
    const isLive = localForSource?.source === 'live';

    // 1) Se está indo pra 'separacao', garante pick-orders criados ANTES.
    //    Se não conseguir (sem estoque etc), aborta sem mexer no WC — não faz
    //    sentido marcar "separação" se ninguém vai separar.
    let ensuredPickOrders: Array<{ id: string; storeCode: string; storeName: string }> | undefined;
    let alreadyHadPickOrders = false;
    if (body.status === 'separacao') {
      const ensured = await this.ensurePickOrdersForWc(wcOrderId);
      if (!ensured.ok) {
        return {
          ok: false,
          id: wcOrderId,
          status: null,
          requestedStatus: body.status,
          statusApplied: false,
          warning:
            `Não foi possível gerar a ordem de separação: ${ensured.message}. ` +
            `O status no site NÃO foi alterado. Abra o pedido e clique em "Gerar separação" ` +
            `pra ver o diagnóstico (SKU sem estoque, ruptura, etc).`,
        };
      }
      ensuredPickOrders = ensured.pickOrders;
      alreadyHadPickOrders = !!ensured.already;
    }

    if (isLive) {
      // Nota vira histórico local; status já foi aplicado pelo confirmRoute
      // (processing→separating). Nada de WooCommerce.
      if (body.addNote?.text?.trim()) {
        await (this.prisma as any).orderHistory
          .create({
            data: {
              orderId: localForSource!.id,
              fromStatus: localForSource!.status,
              toStatus: localForSource!.status,
              note: body.addNote.text.trim(),
            },
          })
          .catch(() => {});
      }
      return {
        ok: true,
        id: wcOrderId,
        status: body.status ?? localForSource!.status,
        requestedStatus: body.status,
        statusApplied: true,
        pickOrdersCreated: ensuredPickOrders && !alreadyHadPickOrders ? ensuredPickOrders : undefined,
        pickOrdersAlreadyExisted: alreadyHadPickOrders,
      };
    }

    const updated = await this.wc.updateOrder(wcOrderId, {
      status: body.status,
      trackingNumber: body.trackingNumber,
      trackingCarrier: body.trackingCarrier,
      trackingUrl: body.trackingUrl,
      customerNote: body.customerNote,
    });

    if (body.addNote?.text?.trim()) {
      await this.wc.addOrderNote(wcOrderId, body.addNote.text, body.addNote.notifyCustomer ?? false);
    }

    const requestedStatus = body.status;
    const rejectedStatus = updated._flowops_statusRejected as string | undefined;
    const statusApplied = !requestedStatus || updated.status === requestedStatus;

    let warning: string | undefined;
    if (rejectedStatus) {
      warning =
        `O status "${rejectedStatus}" NÃO existe no seu WooCommerce — o WP recusou. ` +
        `O tracking e/ou a nota foram salvos, mas o status continua "${updated.status}". ` +
        `Pra usar "Separação" você precisa registrar o slug "em-separacao" no site ` +
        `(plugin "WooCommerce Custom Order Status" ou registro via functions.php).` +
        (updated._flowops_apiError ? ` WC disse: ${updated._flowops_apiError}` : '');
    } else if (!statusApplied) {
      warning =
        `WooCommerce retornou status "${updated.status}" mas foi pedido "${requestedStatus}". ` +
        `Pode ser plugin bloqueando a transição ou permissão insuficiente da chave REST.`;
    }

    return {
      ok: statusApplied && !rejectedStatus,
      id: updated.id,
      status: updated.status,
      requestedStatus,
      statusApplied: statusApplied && !rejectedStatus,
      warning,
      pickOrdersCreated: ensuredPickOrders && !alreadyHadPickOrders ? ensuredPickOrders : undefined,
      pickOrdersAlreadyExisted: alreadyHadPickOrders,
    };
  }

  /**
   * Idempotente: garante que existem pick-orders locais pro wcOrderId.
   *  - Se já existe → retorna { ok: true, already: true } sem refazer nada.
   *  - Se não existe → puxa do WC, upsert, roda routing, cria pick-orders e emite socket.
   *  - Se routing falhar (sem estoque etc) → retorna { ok: false, message }.
   */
  private async ensurePickOrdersForWc(wcOrderId: number): Promise<{
    ok: boolean;
    already?: boolean;
    pickOrders?: Array<{ id: string; storeCode: string; storeName: string }>;
    message?: string;
  }> {
    // Já tem?
    const existing = await this.prisma.order.findFirst({
      where: { wcOrderId },
      include: {
        pickOrders: {
          include: { store: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (existing && existing.pickOrders.length > 0) {
      return {
        ok: true,
        already: true,
        pickOrders: existing.pickOrders.map((p) => ({
          id: p.id,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    }

    // Pedido da LIVE: já existe local com itens — roteia direto, sem WC.
    if (existing && (existing as any).source === 'live') {
      try {
        const preview = await this.routing.previewRoute(existing.id);
        if (!preview.success) {
          const missingLabel = preview.missing?.length
            ? `${preview.missing.length} SKU(s) sem estoque (${preview.missing.slice(0, 3).map((m: any) => m.sku).join(', ')}${preview.missing.length > 3 ? '…' : ''})`
            : `estratégia ${preview.strategy}`;
          return { ok: false, message: missingLabel };
        }
        await this.routing.confirmRoute(existing.id, preview as any);
        const pickOrders = await this.prisma.pickOrder.findMany({
          where: { orderId: existing.id },
          include: { store: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        });
        return {
          ok: true,
          pickOrders: pickOrders.map((p) => ({
            id: p.id,
            storeCode: p.store.code,
            storeName: p.store.name,
          })),
        };
      } catch (e: any) {
        return { ok: false, message: e?.message || 'erro no routing do pedido da live' };
      }
    }

    // Não tem — puxa do WC e roteia
    try {
      const o = await this.wc.getOrder(wcOrderId);
      const { orderId } = await this.orders.upsertFromWooCommerce(o);
      const preview = await this.routing.previewRoute(orderId);
      if (!preview.success) {
        const missingLabel = preview.missing?.length
          ? `${preview.missing.length} SKU(s) sem estoque (${preview.missing.slice(0, 3).map((m: any) => m.sku).join(', ')}${preview.missing.length > 3 ? '…' : ''})`
          : `estratégia ${preview.strategy}`;
        return { ok: false, message: missingLabel };
      }
      await this.routing.confirmRoute(orderId, preview as any);
      const pickOrders = await this.prisma.pickOrder.findMany({
        where: { orderId },
        include: { store: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return {
        ok: true,
        pickOrders: pickOrders.map((p) => ({
          id: p.id,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    } catch (e: any) {
      return { ok: false, message: e?.message || 'erro desconhecido no routing' };
    }
  }

  // ---------- Rotas de listagem geral ----------

  @Get()
  list(
    @Query('status') status?: OrderStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orders.list({
      status,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  // ---------- Rotas paramétricas DEPOIS ----------

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.getById(id);
  }

  /**
   * Estoque por loja para todos os SKUs do pedido (consulta ERP com cache).
   */
  @Get(':id/stock-by-store')
  async stockByStore(@Param('id') id: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
    const stores = await this.prisma.store.findMany({ where: { active: true } });
    const storeCodes = stores.map((s) => s.code);
    const skus = [...new Set(order.items.map((i) => i.sku))];

    const entries = await this.stock.getStockFor(skus, storeCodes);

    const result: Record<string, Array<any>> = {};
    for (const sku of skus) {
      result[sku] = stores.map((s) => {
        const match = entries.find((e) => e.sku === sku && e.storeCode === s.code);
        return {
          storeId: s.id,
          storeCode: s.code,
          storeName: s.name,
          city: s.city,
          state: s.state,
          qty: match?.availableQty ?? 0,
        };
      });
    }

    return { skus, stock: result };
  }

  /**
   * Preview: calcula o roteamento SEM persistir. Retorna quais lojas atenderiam.
   */
  @Post(':id/preview-route')
  async previewRoute(@Param('id') id: string) {
    return this.routing.previewRoute(id);
  }

  /**
   * Confirma o preview e persiste: cria pick_orders, muda status do pedido.
   */
  @Post(':id/confirm-route')
  async confirmRoute(@Param('id') id: string, @Body() body: any) {
    return this.routing.confirmRoute(id, body);
  }

  /**
   * Atalho automático: roteia e persiste numa chamada só.
   */
  @Post(':id/route')
  async route(@Param('id') id: string) {
    const result = await this.routing.routeOrder(id);
    return { ok: result.success, ...result };
  }

  /**
   * Preview de separação pra um pedido WOOCOMMERCE (sem passar pelo banco local).
   *  1. Busca pedido no WC
   *  2. Extrai SKUs + cliente + método de envio
   *  3. Roda a engine de roteamento (1 loja preferido, múltiplas se necessário)
   *  4. Retorna grupos prontos pra enviar WhatsApp
   */
  @Get('wc/:wcId/prepare-separation')
  async prepareSeparation(
    @Param('wcId') wcId: string,
    @Query('preferStoreCode') preferStoreCode?: string,
  ) {
    const wcOrderId = Number(wcId);

    // Pedido da LIVE: monta o MESMO preview a partir do Order local — não
    // existe no WooCommerce (wcOrderId sintético 900M+).
    const local = await (this.prisma as any).order.findUnique({
      where: { wcOrderId },
      include: { items: true },
    });
    if (local?.source === 'live') {
      let addr: any = {};
      try { addr = JSON.parse(local.shippingAddress || '{}'); } catch { /* endereço cru */ }
      return this.routing.previewSeparationForWc({
        wcOrderId,
        wcOrderNumber: String(local.wcOrderNumber ?? wcOrderId),
        orderDateIso: (local.wcDateCreated ?? local.createdAt).toISOString(),
        totalAmount: Number(local.totalAmount ?? 0),
        paymentMethod: 'PIX (Live)',
        items: (local.items || []).map((li: any) => ({
          sku: String(li.sku ?? '').trim(),
          quantity: Number(li.quantity ?? 0),
          productName: String(li.productName ?? ''),
          variant: undefined,
        })),
        customerName: local.customerName ?? '',
        customerPhone: local.customerPhone ?? null,
        customerEmail: local.customerEmail ?? null,
        customerCpf: local.customerCpf ?? null,
        shippingMethod: local.shippingMethod ?? 'LIVE',
        isPickup: !!local.isPickup,
        pickupStoreCode: local.pickupStoreCode ?? null,
        preferStoreCode: preferStoreCode?.trim() || null,
        address: {
          street: addr.address_1 ?? null,
          number: null, // já embutido em address_1 ("Rua X, 123")
          complement: addr.address_2 ?? null,
          neighborhood: null,
          city: addr.city ?? null,
          state: addr.state ?? null,
          postcode: addr.postcode ?? null,
        },
      });
    }

    const o = await this.wc.getOrder(wcOrderId);

    // Monta items com variante (tamanho/cor) vindo do meta_data
    const items = (o.line_items ?? []).map((li: any) => {
      const variant = extractVariantFromLineItem(li);
      return {
        sku: String(li.sku ?? '').trim(),
        quantity: Number(li.quantity ?? 0),
        productName: String(li.name ?? ''),
        variant,
      };
    });

    const shipping = o.shipping ?? {};
    const billing = o.billing ?? {};
    const shippingMethod = (o.shipping_lines ?? [])[0]?.method_title ?? 'Não informado';

    const customerName = [shipping.first_name || billing.first_name, shipping.last_name || billing.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();

    // Detecta retirada em loja e resolve storeCode
    const activeStores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });
    const pickup = detectPickup(o, activeStores);
    const customerCpf = extractCpf(o);

    return this.routing.previewSeparationForWc({
      wcOrderId,
      wcOrderNumber: String(o.number ?? wcOrderId),
      orderDateIso: o.date_created_gmt ?? o.date_created ?? new Date().toISOString(),
      totalAmount: Number(o.total ?? 0),
      paymentMethod: o.payment_method_title ?? '',
      items,
      customerName,
      customerPhone: billing.phone ?? null,
      customerEmail: billing.email ?? null,
      customerCpf,
      shippingMethod,
      isPickup: pickup.isPickup,
      pickupStoreCode: pickup.pickupStoreCode,
      preferStoreCode: preferStoreCode?.trim() || null,
      address: {
        street: shipping.address_1 ?? billing.address_1 ?? null,
        number: shipping.number ?? billing.number ?? null,
        complement: shipping.address_2 ?? billing.address_2 ?? null,
        neighborhood: shipping.neighborhood ?? billing.neighborhood ?? null,
        city: shipping.city ?? billing.city ?? null,
        state: shipping.state ?? billing.state ?? null,
        postcode: shipping.postcode ?? billing.postcode ?? null,
      },
    });
  }

  /**
   * BATELADA: preview de separação pra VÁRIOS pedidos WC de uma vez.
   * Aplica:
   *   - ESTOQUE VIRTUAL compartilhado (a mesma peça não cai em 2 pedidos)
   *   - PROPORCIONALIDADE INVERSA (loja que vendeu mais nos últimos 30d cede menos)
   *
   * Body:
   *   { wcOrderIds: number[] }   // Array de IDs WC a rotear em sequência
   *
   * Retorna: { previews: [...], cedeSummary: { byStore, totalCedeSoFar } }
   *
   * Não persiste — é preview. Pra commit, matriz chama confirmSeparation por pedido.
   */
  @Post('wc/prepare-separation-batch')
  async prepareSeparationBatch(@Body() body: { wcOrderIds: number[] }) {
    const ids = Array.isArray(body?.wcOrderIds) ? body.wcOrderIds.map(Number).filter((n) => n > 0) : [];
    if (ids.length === 0) {
      throw new BadRequestException('wcOrderIds vazio.');
    }
    // Cap de segurança — bateladas gigantes travariam a UI e o ERP.
    if (ids.length > 60) {
      throw new BadRequestException('Máximo de 60 pedidos por batelada.');
    }

    const activeStores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });

    const orderInputs: any[] = [];
    for (const wcOrderId of ids) {
      try {
        const o = await this.wc.getOrder(wcOrderId);
        const items = (o.line_items ?? []).map((li: any) => {
          const variant = extractVariantFromLineItem(li);
          return {
            sku: String(li.sku ?? '').trim(),
            quantity: Number(li.quantity ?? 0),
            productName: String(li.name ?? ''),
            variant,
          };
        });
        const shipping = o.shipping ?? {};
        const billing = o.billing ?? {};
        const shippingMethod = (o.shipping_lines ?? [])[0]?.method_title ?? 'Não informado';
        const customerName = [shipping.first_name || billing.first_name, shipping.last_name || billing.last_name]
          .filter(Boolean)
          .join(' ')
          .trim();
        const pickup = detectPickup(o, activeStores);
        const customerCpf = extractCpf(o);

        orderInputs.push({
          wcOrderId,
          wcOrderNumber: String(o.number ?? wcOrderId),
          orderDateIso: o.date_created_gmt ?? o.date_created ?? new Date().toISOString(),
          totalAmount: Number(o.total ?? 0),
          paymentMethod: o.payment_method_title ?? '',
          items,
          customerName,
          customerPhone: billing.phone ?? null,
          customerEmail: billing.email ?? null,
          customerCpf,
          shippingMethod,
          isPickup: pickup.isPickup,
          pickupStoreCode: pickup.pickupStoreCode,
          address: {
            street: shipping.address_1 ?? billing.address_1 ?? null,
            number: shipping.number ?? billing.number ?? null,
            complement: shipping.address_2 ?? billing.address_2 ?? null,
            neighborhood: shipping.neighborhood ?? billing.neighborhood ?? null,
            city: shipping.city ?? billing.city ?? null,
            state: shipping.state ?? billing.state ?? null,
            postcode: shipping.postcode ?? billing.postcode ?? null,
          },
        });
      } catch (e: any) {
        orderInputs.push({
          wcOrderId,
          wcOrderNumber: String(wcOrderId),
          orderDateIso: new Date().toISOString(),
          totalAmount: 0,
          paymentMethod: '',
          items: [],
          customerName: '',
          shippingMethod: '',
          address: {},
          _fetchError: e?.message ?? String(e),
        } as any);
      }
    }

    return this.routing.previewBatchForWc(orderInputs);
  }

  /**
   * DIAGNÓSTICO: pra investigar pedido roteado pra loja "errada".
   * Compara o que a engine VIU no momento (routingResult salvo) vs ERP AO VIVO agora.
   * Mostra por SKU e por loja:
   *  - Assignment persistido (qual loja pegou)
   *  - scoreBreakdown salvo (por que cada loja ficou de fora)
   *  - ERP AO VIVO agora (filtro ESTOQUE>0)
   *  - Cache atual
   * Com isso dá pra afirmar: foi bug da engine? ERP mudou depois? Dados duplicados?
   */
  @Get('wc/:wcId/routing-debug')
  async routingDebug(@Param('wcId') wcId: string) {
    const wcOrderId = Number(wcId);

    // Tenta pelo banco local (pedido já confirmado)
    let order = await this.prisma.order.findUnique({
      where: { wcOrderId },
      include: {
        items: { include: { assignedStore: { select: { code: true, name: true } } } },
        pickOrders: { include: { store: { select: { code: true, name: true } } } },
      },
    });

    // FALLBACK: pedido não está no banco → busca ao vivo no WC e monta SKUs sem persistir
    let liveMode = false;
    let wcLineItems: Array<{ sku: string; quantity: number; name: string }> = [];
    if (!order) {
      liveMode = true;
      try {
        const o = await this.wc.getOrder(wcOrderId);
        wcLineItems = (o.line_items ?? []).map((li: any) => ({
          sku: String(li.sku ?? '').trim(),
          quantity: Number(li.quantity ?? 0),
          name: String(li.name ?? ''),
        }));
      } catch (e: any) {
        return {
          error: `Order wc=${wcId} não está no banco local nem no WooCommerce: ${e?.message ?? e}`,
        };
      }
    }

    // routingResult é JSON string — parseia com cuidado
    let savedRouting: any = null;
    if (order) {
      try {
        savedRouting = order.routingResult ? JSON.parse(order.routingResult) : null;
      } catch {
        savedRouting = { _parseError: true, raw: order.routingResult };
      }
    }

    const stores = await this.prisma.store.findMany({ where: { active: true } });
    const storeCodes = stores.map((s) => s.code);
    const skus = liveMode
      ? [...new Set(wcLineItems.map((i) => i.sku).filter((s) => s?.trim()))]
      : [...new Set((order?.items ?? []).map((i) => i.sku).filter((s) => s?.trim()))];

    // ERP ao vivo (filtro ESTOQUE>0 — o que a engine usaria agora)
    const liveStock = await this.stock.getStockLive(skus, storeCodes);
    const liveMap = new Map<string, number>();
    for (const e of liveStock) {
      liveMap.set(`${e.storeCode}::${e.sku}`, e.availableQty);
    }

    // Comparação por SKU
    const bySku = await Promise.all(
      skus.map(async (sku) => {
        let totalQty = 0;
        let assignedStoreCodes: string[] = [];
        if (liveMode) {
          totalQty = wcLineItems
            .filter((i) => i.sku === sku)
            .reduce((acc, i) => acc + i.quantity, 0);
        } else {
          const orderItems = (order?.items ?? []).filter((i) => i.sku === sku);
          totalQty = orderItems.reduce((acc, i) => acc + i.quantity, 0);
          assignedStoreCodes = [
            ...new Set(
              orderItems
                .map((i) => i.assignedStore?.code)
                .filter((c): c is string => !!c),
            ),
          ];
        }

        // RAW do ERP pra esse SKU — todas as linhas (inclusive negativas/zero)
        const rawRows = await this.erp.getStockRawBySku(sku);
        const rawByStore = new Map<string, { sum: number; rows: number; positive: number }>();
        for (const r of rawRows) {
          const cur = rawByStore.get(r.storeCode) ?? { sum: 0, rows: 0, positive: 0 };
          cur.sum += r.qty;
          cur.rows += 1;
          if (r.qty > 0) cur.positive += r.qty;
          rawByStore.set(r.storeCode, cur);
        }

        const perStore = stores.map((s) => {
          const raw = rawByStore.get(s.code) ?? { sum: 0, rows: 0, positive: 0 };
          const live = liveMap.get(`${s.code}::${sku}`) ?? 0;
          const isAssigned = assignedStoreCodes.includes(s.code);
          return {
            storeCode: s.code,
            storeName: s.name,
            isAssigned,
            erpRawSum: raw.sum, // soma de TODAS as linhas (inclusive negativas)
            erpRawRows: raw.rows, // quantas linhas existem na tabela
            erpPositiveQty: raw.positive, // só as positivas (o que ESTOQUE>0 retorna)
            engineLiveSaw: live, // o que a engine receberia do stock service agora
            // 🚨 red flag: engine acha que tem, mas soma real é zero/negativa
            suspicious:
              live > 0 && raw.sum <= 0
                ? `engine vê ${live} mas soma real no ERP é ${raw.sum}`
                : null,
          };
        });

        return {
          sku,
          totalQtyInOrder: totalQty,
          assignedStoreCodes,
          perStore,
        };
      }),
    );

    return {
      liveMode,
      order: order
        ? {
            id: order.id,
            wcOrderId: order.wcOrderId,
            wcOrderNumber: order.wcOrderNumber,
            status: order.status,
            createdAt: order.createdAt,
          }
        : {
            id: null,
            wcOrderId,
            wcOrderNumber: String(wcId),
            status: 'NÃO-PERSISTIDO (pedido não passou pelo botão Confirmar separação)',
            createdAt: new Date().toISOString(),
          },
      savedRouting,
      pickOrders: order?.pickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })) ?? [],
      bySku,
      wcLineItems: liveMode ? wcLineItems : undefined,
    };
  }

  /**
   * CONFIRMA a separação de um pedido WC: persiste localmente, cria pick-orders
   * pra cada loja roteada e EMITE socket pra elas (faz o card aparecer no app
   * /minha-loja em tempo real).
   *
   * Body opcional:
   *   - overrides?: { [skuOuStoreIdOriginal]: storeIdNovo }   // pra forçar loja diferente
   *
   * Retorna:
   *   { ok, pickOrders: [{id, storeCode, storeName, items}], orderId }
   */
  /**
   * RECALCULA a separação de um pedido WC já roteado.
   *
   * Quando usar: matriz percebe que a loja roteada não tem estoque (race condition,
   * peça quebrada, etc.) e quer reatribuir. Diferente do `confirm-separation` que é
   * idempotente, esse aqui CANCELA pick-orders ativos e cria novos.
   *
   * Bloqueio: se algum pick-order já está em separated/ready/shipped, retorna 200
   * com `ok: false, reason: 'advanced-status'` — a matriz precisa rejeitar manualmente
   * antes de poder reatribuir.
   *
   * Ganho extra: o roteamento agora desconta `committed` (peças prometidas em outros
   * pick-orders ativos), então não vai realocar pra mesma loja sem estoque.
   */
  @Post('wc/:wcId/recalculate-separation')
  async recalculateSeparation(
    @Param('wcId') wcId: string,
    @Body() body?: { excludeStoreCodes?: string[]; pickOrderId?: string; forceStoreCode?: string },
  ) {
    // SWAP CIRÚRGICO: se vier pickOrderId, troca SÓ aquele pick-order específico,
    // sem mexer nos outros (caso onde uma loja já enviou e outra precisa ser trocada).
    if (body?.pickOrderId) {
      return this.routing.swapSinglePickOrder(body.pickOrderId, {
        excludeStoreCodes: Array.isArray(body?.excludeStoreCodes)
          ? body.excludeStoreCodes
          : undefined,
        forceStoreCode: body?.forceStoreCode,
      });
    }

    const wcOrderId = Number(wcId);
    const local = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: { id: true },
    });
    if (!local) {
      // Sem Order local ainda → cai no fluxo normal de criar do zero
      return this.confirmSeparation(wcId);
    }
    return this.routing.recalculateForWc(local.id, {
      excludeStoreCodes: Array.isArray(body?.excludeStoreCodes)
        ? body!.excludeStoreCodes
        : undefined,
      forceStoreCode: body?.forceStoreCode,
    });
  }

  @Post('wc/:wcId/confirm-separation')
  async confirmSeparation(
    @Param('wcId') wcId: string,
    @Body() body?: { preferStoreCode?: string | null },
  ) {
    const wcOrderId = Number(wcId);

    // Idempotente: se já rodou (via PATCH→hook, botão anterior, etc), retorna o que existe.
    const existing = await this.prisma.order.findFirst({
      where: { wcOrderId },
      include: {
        pickOrders: {
          include: { store: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (existing && existing.pickOrders.length > 0) {
      return {
        ok: true,
        orderId: existing.id,
        alreadyExisted: true,
        pickOrders: existing.pickOrders.map((p) => ({
          id: p.id,
          status: p.status,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    }

    // 1) Garante o Order local com items.
    //    Pedido da LIVE (source='live') JÁ existe local — não busca no WC
    //    (wcOrderId sintético; buscar lá dava 500 na aprovação da quebra).
    let orderId: string;
    if (existing && (existing as any).source === 'live') {
      orderId = existing.id;
    } else {
      const o = await this.wc.getOrder(wcOrderId);
      const up = await this.orders.upsertFromWooCommerce(o);
      orderId = up.orderId;
    }

    // 2) Roda o preview oficial (consulta estoque e roteia)
    //    Respeita `preferStoreCode` se o usuário escolheu via radio button no
    //    frontend — a engine força essa loja se ela cobrir o pedido inteiro.
    const preview = await this.routing.previewRoute(orderId, {
      preferStoreCode: body?.preferStoreCode?.trim() || null,
    });

    if (!preview.success) {
      return {
        ok: false,
        reason: 'sem-estoque',
        message: 'Nenhuma loja tem estoque suficiente. Verifica o estoque ou divide manualmente.',
        missing: preview.missing,
        orderId,
      };
    }

    // 3) Confirma → cria PickOrders + emite socket pras lojas
    await this.routing.confirmRoute(orderId, preview as any);

    // 4) Re-lê os pick-orders criados pra retornar info detalhada
    const pickOrders = await this.prisma.pickOrder.findMany({
      where: { orderId },
      include: { store: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true,
      orderId,
      strategy: preview.strategy,
      pickOrders: pickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })),
    };
  }
}

// extractVariantFromLi
