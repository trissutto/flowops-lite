import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { OrderStatus } from '../common/enums';
import { StockService } from '../stock/stock.service';
import { RoutingService } from '../routing/routing.service';
import { PrismaService } from '../prisma/prisma.service';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { ErpService } from '../erp/erp.service';
import { extractAttribution } from '../woocommerce/attribution.util';

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
   * Lista pedidos DIRETO do WooCommerce (espelho do admin WP).
   * Não usa banco local. Contadores e dados vêm sempre atualizados.
   */
  @Get('wc')
  async wcList(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('search') search?: string,
  ) {
    const res = await this.wc.listOrders({
      status,
      page: page ? Number(page) : 1,
      perPage: perPage ? Number(perPage) : 50,
      search,
    });

    const data = res.data.map((o: any) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      dateCreatedGmt: o.date_created_gmt ?? o.date_created,
      total: o.total,
      currency: o.currency,
      customerName: `${o.billing?.first_name ?? ''} ${o.billing?.last_name ?? ''}`.trim(),
      ...extractAttribution(o.meta_data ?? []),
    }));

    return { data, total: res.total, totalPages: res.totalPages };
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
    return { byStatus, grand };
  }

  /** Detalhe de 1 pedido direto do WC. */
  @Get('wc/:wcId')
  async wcGetOne(@Param('wcId') wcId: string) {
    const o = await this.wc.getOrder(Number(wcId));

    const getMeta = (key: string) => {
      const m = (o.meta_data ?? []).find((x: any) => x?.key === key);
      return m ? String(m.value ?? '') : '';
    };

    const attribution = extractAttribution(o.meta_data ?? []);

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
      attribution,
    };
  }

  /**
   * Atualiza um pedido no WooCommerce (grava direto no site).
   * Body: { status?, trackingNumber?, trackingCarrier?, trackingUrl?, customerNote?, addNote? }
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
    };
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
  async prepareSeparation(@Param('wcId') wcId: string) {
    const wcOrderId = Number(wcId);
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

    return this.routing.previewSeparationForWc({
      wcOrderId,
      wcOrderNumber: String(o.number ?? wcOrderId),
      orderDateIso: o.date_created_gmt ?? o.date_created ?? new Date().toISOString(),
      totalAmount: Number(o.total ?? 0),
      paymentMethod: o.payment_method_title ?? '',
      items,
      customerName,
      customerPhone: billing.phone ?? null,
      shippingMethod,
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
    const order = await this.prisma.order.findUnique({
      where: { wcOrderId },
      include: {
        items: { include: { assignedStore: { select: { code: true, name: true } } } },
        pickOrders: { include: { store: { select: { code: true, name: true } } } },
      },
    });
    if (!order) {
      return { error: `Order wc=${wcId} não encontrado no banco local. Confirme a separação primeiro.` };
    }

    // routingResult é JSON string — parseia com cuidado
    let savedRouting: any = null;
    try {
      savedRouting = order.routingResult ? JSON.parse(order.routingResult) : null;
    } catch {
      savedRouting = { _parseError: true, raw: order.routingResult };
    }

    const stores = await this.prisma.store.findMany({ where: { active: true } });
    const storeCodes = stores.map((s) => s.code);
    const skus = [...new Set(order.items.map((i) => i.sku).filter((s) => s?.trim()))];

    // ERP ao vivo (filtro ESTOQUE>0 — o que a engine usaria agora)
    const liveStock = await this.stock.getStockLive(skus, storeCodes);
    const liveMap = new Map<string, number>();
    for (const e of liveStock) {
      liveMap.set(`${e.storeCode}::${e.sku}`, e.availableQty);
    }

    // Comparação por SKU
    const bySku = await Promise.all(
      skus.map(async (sku) => {
        const orderItems = order.items.filter((i) => i.sku === sku);
        const totalQty = orderItems.reduce((acc, i) => acc + i.quantity, 0);
        const assignedStoreCodes = [
          ...new Set(
            orderItems
              .map((i) => i.assignedStore?.code)
              .filter((c): c is string => !!c),
          ),
        ];

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
      order: {
        id: order.id,
        wcOrderId: order.wcOrderId,
        wcOrderNumber: order.wcOrderNumber,
        status: order.status,
        createdAt: order.createdAt,
      },
      savedRouting,
      pickOrders: order.pickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })),
      bySku,
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
  @Post('wc/:wcId/confirm-separation')
  async confirmSeparation(@Param('wcId') wcId: string) {
    const wcOrderId = Number(wcId);
    const o = await this.wc.getOrder(wcOrderId);

    // 1) Upsert local do pedido (cria Order + items se ainda não existir)
    const { orderId } = await this.orders.upsertFromWooCommerce(o);

    // 2) Roda o preview oficial (consulta estoque e roteia)
    const preview = await this.routing.previewRoute(orderId);

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

/**
 * Tenta extrair a variante (tamanho, cor) do meta_data do line_item do WC.
 * Atributos de variação vêm com key tipo "pa_tamanho" / "pa_cor".
 */
function extractVariantFromLineItem(li: any): string | undefined {
  const meta = li?.meta_data ?? [];
  const parts: string[] = [];
  for (const m of meta) {
    const key = String(m?.key ?? '');
    const display = String(m?.display_key ?? '');
    const val = String(m?.display_value ?? m?.value ?? '').trim();
    if (!val) continue;
    // Ignora metas técnicas (chave começa com "_")
    if (key.startsWith('_')) continue;
    const label = display || key.replace(/^pa_/, '').replace(/_/g, ' ');
    parts.push(`${capitalize(label)}: ${val}`);
  }
  return parts.length ? parts.join(' · ') : undefined;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
