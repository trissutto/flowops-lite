import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { ErpService } from '../erp/erp.service';
import { ManychatService } from '../live-pdv/manychat.service';

// Status LOGÍSTICO do pick-order (controlado pela loja):
//   new          → chegou, filial não começou
//   separating   → filial clicou "Iniciar Separação", bipagem em andamento
//   separated    → filial bipou 100% → já pode postar (rastreio liberado)
//   ready        → (legado) mantido por compatibilidade com dados antigos
//   shipped      → filial postou e adicionou rastreio
//
// APROVAÇÃO DE BAIXA (matriz) = campo debitApprovedAt no PickOrder, INDEPENDENTE.
// Loja não espera matriz pra postar. Matriz aprova em paralelo (pode ser depois de shipped).
export type PickStatus = 'new' | 'separating' | 'separated' | 'ready' | 'shipped';
const VALID_STATUSES: PickStatus[] = ['new', 'separating', 'separated', 'ready', 'shipped'];

// Transições permitidas. Agora separated pode ir direto pra shipped (sem esperar matriz).
const NEXT_ALLOWED: Record<PickStatus, PickStatus[]> = {
  new: ['separating', 'separated', 'ready', 'shipped'], // admin pode pular tudo em casos raros
  separating: ['separated', 'ready', 'shipped'],        // bipou ou marcou pronto
  separated: ['shipped', 'separating', 'ready'],        // posta direto (rastreio), ou volta pra revisar
  ready: ['shipped'],                                   // legado
  shipped: [],                                          // ponto final
};

/**
 * Mapeamento do status INTERNO do pick-order (loja) → status no WooCommerce.
 *   - separating/ready → 'separacao' (em separação no site)
 *   - shipped (quando TODOS os pick-orders siblings já foram enviados) → 'completed'
 *
 * IMPORTANTE — por que 'completed' e não 'enviado':
 * O status customizado 'enviado' (violeta) do WC NÃO dispara o hook nativo
 * `woocommerce_order_status_completed` — e é nele que o plugin de WhatsApp
 * fica pendurado pra mandar o rastreio pra cliente. Ao marcar 'completed',
 * o WC dispara o hook, o plugin pega o meta `_tracking_number` que já está
 * salvo no pedido e envia a mensagem automaticamente.
 * O status "Enviado" da listagem nativa fica inutilizado, mas é aceitável —
 * "Concluído" no WC corresponde ao "Enviado" no fluxo físico (saiu da loja).
 */
const WC_STATUS_SEPARATING = 'separacao';
const WC_STATUS_SHIPPED = 'completed';

@Injectable()
export class PickOrdersService {
  private readonly logger = new Logger(PickOrdersService.name);
  // Divisor do valor intercompany (regra do dono: VENDAUN ÷ 2,5 — NUNCA o CUSTO)
  private static readonly DIVISOR_CUSTO = 2.5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    @Inject(forwardRef(() => WooCommerceService))
    private readonly wc: WooCommerceService,
    private readonly erp: ErpService,
    private readonly manychat: ManychatService,
  ) {}

  /**
   * Retorna os items desse pick-order com o EAN resolvido do ERP.
   * Usado pela tela de bipagem da filial — frontend monta mapa EAN→SKU.
   */
  async getScanData(pickOrderId: string, storeId: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, storeId: true, status: true, orderId: true },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');

    // Items atribuídos a essa loja (pedido multi-loja só retorna o pedaço dela)
    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: storeId },
      select: { id: true, sku: true, productName: true, quantity: true },
    });

    const skus = items.map((i) => i.sku).filter(Boolean);
    const eanMap = skus.length ? await this.erp.getEansBySkus(skus) : {};

    return {
      pickOrderId: po.id,
      status: po.status,
      items: items.map((i) => {
        const ean = eanMap[i.sku] ?? null;
        // Variantes pra tolerar zeros à esquerda do scanner (ex: "0789..." vs "789...")
        // IMPORTANTE: o próprio SKU/CODIGO também entra como variante — muitas confecções
        // imprimem o código interno do ERP como barcode, sem EAN13 real.
        const eanVariants: string[] = [];
        const addVariant = (v: string | null | undefined) => {
          if (!v) return;
          const s = String(v).trim();
          if (s && !eanVariants.includes(s)) eanVariants.push(s);
          if (s && /^\d+$/.test(s)) {
            const stripped = s.replace(/^0+/, '');
            if (stripped && !eanVariants.includes(stripped)) eanVariants.push(stripped);
            const p13 = s.padStart(13, '0');
            const p14 = s.padStart(14, '0');
            if (!eanVariants.includes(p13)) eanVariants.push(p13);
            if (!eanVariants.includes(p14)) eanVariants.push(p14);
          }
        };
        addVariant(ean);
        addVariant(i.sku); // sku bipado direto também conta
        return {
          id: i.id,
          sku: i.sku,
          productName: i.productName,
          quantity: i.quantity,
          ean, // null = sem EAN no ERP → operador precisa reportar
          eanVariants,
        };
      }),
    };
  }

  /**
   * Fallback quando o EAN bipado não bateu no mapa local da tela de bipagem.
   * Busca no ERP (todas as colunas candidatas, todas as variantes de zeros) e
   * se encontrar um CODIGO que está nos SKUs desse pick-order, retorna o SKU.
   *
   * Também devolve debug dos SKUs do pedido (EANs por coluna) pra diagnóstico
   * rápido na UI quando o EAN realmente não pertence ao pedido.
   */
  async resolveScan(pickOrderId: string, storeId: string, rawEan: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, storeId: true, orderId: true },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');

    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: storeId },
      select: { sku: true },
    });
    const pedidoSkus = new Set(items.map((i) => i.sku).filter(Boolean));

    const hit = await this.erp.findSkuByAnyEan(rawEan);
    if (hit && pedidoSkus.has(hit)) {
      return { found: true, sku: hit, ean: rawEan, source: 'erp-wide' as const };
    }

    // Não achou — devolve dump dos SKUs do pedido pra UI exibir debug
    const debug: Array<Record<string, any>> = [];
    for (const sku of pedidoSkus) {
      const d = await this.erp.debugProductEans(sku);
      if (d) debug.push(d);
    }
    return { found: false, ean: rawEan, erpHit: hit, debug };
  }

  /**
   * Transiciona pick-order de `separating` → `separated`.
   * Recebe no body a lista de scans pra auditoria (armazena em integration_logs).
   *
   * IMPORTANTE: essa operação AINDA NÃO toca no Gigasistemas. Apenas muda
   * status interno. A baixa real de estoque acontece na matriz, quando operadora
   * da retaguarda aprova.
   */
  async finishSeparation(
    pickOrderId: string,
    storeId: string,
    userId: string,
    scans: Array<{ sku: string; ean: string; timestamp: string }>,
  ) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, storeId: true, status: true, orderId: true },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');
    if (po.status !== 'separating' && po.status !== 'new') {
      throw new BadRequestException(`Status atual é "${po.status}" — só pode finalizar de "separating"/"new"`);
    }

    // Valida que bipou tudo que era esperado
    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: storeId },
      select: { sku: true, quantity: true },
    });
    const expected = new Map<string, number>();
    for (const it of items) {
      expected.set(it.sku, (expected.get(it.sku) ?? 0) + it.quantity);
    }
    const scannedCount = new Map<string, number>();
    for (const s of scans) {
      scannedCount.set(s.sku, (scannedCount.get(s.sku) ?? 0) + 1);
    }
    for (const [sku, qty] of expected.entries()) {
      const got = scannedCount.get(sku) ?? 0;
      if (got < qty) {
        throw new BadRequestException(
          `SKU ${sku}: esperado ${qty}, bipado ${got}. Bipa tudo antes de finalizar.`,
        );
      }
    }

    // Log de auditoria — fica pra sempre no integration_logs
    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'separation.finished',
        payload: JSON.stringify({ pickOrderId, userId, storeId, scans }),
        status: 200,
      },
    });

    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: { status: 'separated' },
      include: { order: { select: { wcOrderId: true } } },
    });

    // Notifica matriz em tempo real — retaguarda vê a nova fila
    this.gateway.emitPickOrderStatus(storeId, {
      id: updated.id,
      status: 'separated',
    });

    // BAIXA AUTOMÁTICA NO GIGA — após bipar tudo, dispara decreaseStock
    // sem precisar de aprovação manual da matriz. Usa allowNegative +
    // skipNotFound pra não travar a separação por divergências de estoque
    // (peça já está separada fisicamente). Erro NÃO bloqueia a resposta —
    // só loga e segue: a separação aconteceu, baixa pode ser retentada
    // depois pelo retry de baixas falhadas.
    try {
      await this.runAutoDebit(pickOrderId, userId);
    } catch (e: any) {
      this.logger.warn(
        `Baixa automática falhou pro pick-order ${pickOrderId}: ${e?.message || e}. Pode ser retentada manualmente.`,
      );
    }

    return {
      id: updated.id,
      status: updated.status,
      wcOrderId: updated.order?.wcOrderId ?? null,
      itemsScanned: scans.length,
    };
  }

  /**
   * Baixa automática chamada após finishSeparation. Espelha o fluxo do
   * approveDebit mas com allowNegative + skipNotFound (a peça já está em
   * mãos, não bloqueamos por divergência do Giga). Marca debitApprovedAt
   * pra não duplicar caso a matriz tente aprovar manualmente depois.
   */
  private async runAutoDebit(pickOrderId: string, userId: string): Promise<void> {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true,
        storeId: true,
        orderId: true,
        debitApprovedAt: true,
        store: { select: { code: true } },
      } as any,
    });
    if (!po) return;
    if ((po as any).debitApprovedAt) return; // já baixou

    const writeEnabled = this.erp.isWriteEnabled;
    if (!writeEnabled) {
      // shadow mode — só log
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.approved.shadow.auto',
          payload: JSON.stringify({ pickOrderId, userId, mode: 'auto' }),
          status: 200,
        },
      });
      return;
    }

    const storeCode = String(((po as any).store?.code) ?? '').trim();
    if (!storeCode) {
      this.logger.warn(`runAutoDebit ${pickOrderId}: loja sem code, pulando`);
      return;
    }

    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: po.storeId },
      select: { sku: true, quantity: true, productName: true },
    });

    const result = await this.erp.decreaseStock(
      items.map((i) => ({ sku: i.sku, qty: i.quantity, storeCode })),
      { allowNegative: true, skipNotFound: true },
    );

    if (!result.success) {
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.real.auto.failed',
          payload: JSON.stringify({
            pickOrderId,
            userId,
            storeCode,
            items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
            error: result.error,
          }),
          status: 500,
          error: (result.error || '').slice(0, 500),
        },
      });
      throw new Error(`decreaseStock falhou: ${result.error}`);
    }

    // Sucesso — marca debitApprovedAt pra não duplicar
    await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: { debitApprovedAt: new Date() } as any,
    });

    await this.prisma.integrationLog.create({
      data: {
        source: 'erp',
        direction: 'out',
        event: 'debit.real.auto.applied',
        payload: JSON.stringify({
          pickOrderId,
          userId,
          storeCode,
          mode: 'auto',
          applied: result.applied,
        }),
        status: 200,
      },
    });
  }

  /**
   * Lista os pick-orders DA loja do user logado.
   * Filtro default: status ativos (new, separating, ready). `all=true` traz shipped também.
   */
  async listMine(storeId: string, opts?: { all?: boolean }) {
    const where: any = { storeId };
    if (!opts?.all) {
      where.status = { in: ['new', 'separating', 'separated', 'ready'] };
      // Esconde pick-orders sinalizados com problema — card sai da fila da loja
      // assim que ela reporta; matriz vê a flag em /pedidos e /separacao e reroteia.
      where.issueReason = null;
    }
    const rows = await this.prisma.pickOrder.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        order: {
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            customerName: true,
            customerPhone: true,
            customerCpf: true,
            customerEmail: true,
            shippingCep: true,
            shippingAddress: true,
            totalAmount: true,
            wcDateCreated: true,
            isPickup: true,
            pickupStoreCode: true,
            shippingMethod: true,
          },
        },
      },
    });
    // Items atribuídos a ESSA loja (um pedido multi-loja só mostra o pedaço dessa loja)
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const items = orderIds.length
      ? await this.prisma.orderItem.findMany({
          where: { orderId: { in: orderIds }, assignedStoreId: storeId },
        })
      : [];
    const itemsByOrder = new Map<string, any[]>();
    for (const it of items) {
      const arr = itemsByOrder.get(it.orderId) ?? [];
      arr.push(it);
      itemsByOrder.set(it.orderId, arr);
    }

    // Resolve transferToStoreName para os pick-orders de transferência
    const transferStoreCodes = [
      ...new Set(
        rows
          .map((r) => r.transferToStoreCode)
          .filter((c): c is string => !!c),
      ),
    ];
    const transferStores = transferStoreCodes.length
      ? await this.prisma.store.findMany({
          where: { code: { in: transferStoreCodes } },
          select: { code: true, name: true, city: true, state: true },
        })
      : [];
    const storeByCode = new Map(transferStores.map((s) => [s.code, s]));

    return rows.map((r) => {
      const transferToStore = r.transferToStoreCode
        ? storeByCode.get(r.transferToStoreCode) ?? null
        : null;
      // Parse do snapshot do cliente (só existe em transferências)
      let customerSnapshotObj: any = null;
      if (r.customerSnapshot) {
        try {
          customerSnapshotObj = JSON.parse(r.customerSnapshot);
        } catch {
          customerSnapshotObj = null;
        }
      }
      return {
        id: r.id,
        status: r.status,
        trackingCode: r.trackingCode,
        carrier: r.carrier,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        isTransfer: r.isTransfer,
        transferToStoreCode: r.transferToStoreCode,
        transferToStoreName: transferToStore?.name ?? null,
        transferToStoreCity: transferToStore?.city ?? null,
        customerSnapshot: customerSnapshotObj,
        order: {
          ...r.order,
          items: itemsByOrder.get(r.orderId) ?? [],
        },
      };
    });
  }

  /**
   * Matriz — lista todos os pick-orders com status `separated` (aguardando aprovação).
   * Ordenação: mais antigo primeiro (FIFO — quem separou primeiro, baixa primeiro).
   */
  async listPendingApproval() {
    const rows = await this.prisma.pickOrder.findMany({
      where: {
        // Qualquer coisa já separada mas ainda sem baixa aprovada — inclui shipped
        // (loja pode postar antes da matriz aprovar baixa no novo fluxo).
        status: { in: ['separated', 'ready', 'shipped'] },
        debitApprovedAt: null,
      } as any,
      orderBy: [{ updatedAt: 'asc' }],
      include: {
        store: { select: { id: true, code: true, name: true, city: true } },
        order: {
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            customerName: true,
            customerCpf: true,
            customerEmail: true,
            customerPhone: true,
            shippingCep: true,
            totalAmount: true,
          },
        },
      },
    });

    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const allItems = orderIds.length
      ? await this.prisma.orderItem.findMany({
          where: { orderId: { in: orderIds } },
        })
      : [];
    const itemsByPickOrder = new Map<string, any[]>();
    for (const r of rows) {
      const its = allItems.filter(
        (it) => it.orderId === r.orderId && it.assignedStoreId === r.storeId,
      );
      itemsByPickOrder.set(r.id, its);
    }

    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      waitingMinutes: Math.round((Date.now() - r.updatedAt.getTime()) / 60000),
      store: r.store,
      order: r.order,
      items: itemsByPickOrder.get(r.id) ?? [],
    }));
  }

  /**
   * Matriz — lista compacta de todos os pick-orders com issue REPORTADO e
   * ainda não resolvido (status new|separating, issueReason != null).
   *
   * Usado pela /separacao pra pintar badge vermelho no pedido da fila que
   * tem problema reportado por alguma loja. Resposta pequena pra ficar barato
   * cross-referenciar com a lista do WC (que pode ter centenas de itens).
   */
  /**
   * Lista pick-orders com status=shipped num intervalo, agrupados por loja.
   *
   * Usado pela tela /retaguarda/enviados-hoje pra matriz ver em tempo real o que
   * cada filial despachou no dia. O "shipped at" não tem coluna dedicada — usamos
   * `updatedAt` que é tocado quando a loja muda pra shipped (updateStatus).
   *
   * Default period: HOJE em horário SP (-03:00). Retorna agrupado + total geral.
   */
  async listShippedByStore(params: { from?: string; to?: string }) {
    // Se não veio data, usa HOJE (00:00 → 23:59:59.999 no fuso SP)
    // Guarda margem de 3h pra não perder cliente que enviou perto da meia-noite.
    const now = new Date();
    // Hoje em SP → pega timestamp UTC do 00:00 SP e do 23:59:59 SP
    const spMidnightLocal = new Date(now);
    spMidnightLocal.setHours(0, 0, 0, 0);
    // spMidnight em UTC = spMidnightLocal (trust server tz) — se servidor é UTC,
    // 00:00 SP == 03:00 UTC. Fazemos overlap generoso (24h anteriores).
    const defaultFrom = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const defaultTo = new Date(Date.now() + 1 * 60 * 60 * 1000);

    const from = params.from ? new Date(params.from) : defaultFrom;
    let to = params.to ? new Date(params.to) : defaultTo;
    // Se veio só data (YYYY-MM-DD), o to fica 00:00 — empurra pro final do dia
    if (params.to && /^\d{4}-\d{2}-\d{2}$/.test(params.to)) {
      to = new Date(params.to + 'T23:59:59.999Z');
    }

    const rows = await this.prisma.pickOrder.findMany({
      where: {
        status: { in: ['shipped', 'delivered'] },
        updatedAt: { gte: from, lte: to },
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        store: { select: { code: true, name: true } },
        order: {
          select: {
            id: true,
            wcOrderId: true,
            wcOrderNumber: true,
            customerName: true,
            customerPhone: true,
            totalAmount: true,
            isPickup: true,
            shippingMethod: true,
            trackingCode: true,
            carrier: true,
            items: {
              select: { sku: true, quantity: true, productName: true },
            },
          } as any,
        },
      },
    });

    // Agrupa por storeCode
    const byStoreMap = new Map<string, {
      storeCode: string;
      storeName: string;
      count: number;
      totalItems: number;
      totalRevenue: number;
      transferCount: number;
      pickupCount: number;
      rows: Array<{
        pickOrderId: string;
        wcOrderId: number | null;
        wcOrderNumber: string | null;
        customerName: string | null;
        customerPhone: string | null;
        totalAmount: number | null;
        shippingMethod: string | null;
        // rastreio: prioriza do pick-order (que a loja preencheu no shipped),
        // senão cai pro order (WC).
        trackingCode: string | null;
        carrier: string | null;
        shippedAt: Date;
        itemsCount: number;
        isPickup: boolean;
        isTransfer: boolean;
        transferToStoreCode: string | null;
      }>;
    }>();

    for (const r of rows) {
      const code = r.store?.code ?? 'SEM_LOJA';
      const name = r.store?.name ?? 'Sem loja';
      const o: any = r.order;
      const itemsCount = Array.isArray(o?.items)
        ? o.items.reduce((acc: number, it: any) => acc + (Number(it.quantity) || 0), 0)
        : 0;
      const amount = Number(o?.totalAmount ?? 0);
      const isTransfer = (r as any).isTransfer === true;
      const isPickup = o?.isPickup === true;

      const cur = byStoreMap.get(code) ?? {
        storeCode: code,
        storeName: name,
        count: 0,
        totalItems: 0,
        totalRevenue: 0,
        transferCount: 0,
        pickupCount: 0,
        rows: [],
      };
      cur.count++;
      cur.totalItems += itemsCount;
      cur.totalRevenue += amount;
      if (isTransfer) cur.transferCount++;
      if (isPickup) cur.pickupCount++;
      cur.rows.push({
        pickOrderId: r.id,
        wcOrderId: o?.wcOrderId ?? null,
        wcOrderNumber: o?.wcOrderNumber ?? null,
        customerName: o?.customerName ?? null,
        customerPhone: o?.customerPhone ?? null,
        totalAmount: amount || null,
        shippingMethod: o?.shippingMethod ?? null,
        trackingCode: r.trackingCode ?? o?.trackingCode ?? null,
        carrier: r.carrier ?? o?.carrier ?? null,
        shippedAt: r.updatedAt,
        itemsCount,
        isPickup,
        isTransfer,
        transferToStoreCode: (r as any).transferToStoreCode ?? null,
      });
      byStoreMap.set(code, cur);
    }

    const byStore = Array.from(byStoreMap.values()).sort((a, b) => b.count - a.count);
    const grand = {
      count: rows.length,
      totalItems: byStore.reduce((acc, s) => acc + s.totalItems, 0),
      totalRevenue: byStore.reduce((acc, s) => acc + s.totalRevenue, 0),
      storesCount: byStore.length,
      transferCount: byStore.reduce((acc, s) => acc + s.transferCount, 0),
      pickupCount: byStore.reduce((acc, s) => acc + s.pickupCount, 0),
    };

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      grand,
      byStore,
    };
  }

  async listIssuesActive() {
    const rows = await this.prisma.pickOrder.findMany({
      where: {
        issueReason: { not: null },
        status: { in: ['new', 'separating'] },
      } as any,
      orderBy: { issueReportedAt: 'desc' } as any,
      include: {
        store: { select: { code: true, name: true } },
        order: { select: { wcOrderId: true, wcOrderNumber: true } },
      },
    });

    const reasonLabels: Record<string, string> = {
      out_of_stock: 'Sem estoque físico',
      defective: 'Peça com defeito',
      divergence: 'Divergência (cor/tamanho)',
      other: 'Outro',
    };

    return rows.map((r) => {
      const reason = (r as any).issueReason as string;
      return {
        pickOrderId: r.id,
        wcOrderId: r.order?.wcOrderId ?? null,
        wcOrderNumber: r.order?.wcOrderNumber ?? null,
        storeCode: r.store?.code ?? null,
        storeName: r.store?.name ?? null,
        reason,
        reasonLabel: reasonLabels[reason] ?? reason,
        note: (r as any).issueNote ?? null,
        reportedAt: (r as any).issueReportedAt ?? null,
      };
    });
  }

  /**
   * Matriz aprova a baixa do pick-order.
   *
   * Modos (controlado por env `ERP_WRITE_ENABLED`):
   *
   *  REAL (ERP_WRITE_ENABLED=true):
   *    - Chama `erp.decreaseStock(items)` que executa UPDATE estoque em transação.
   *    - Se falhar (ex: estoque insuficiente, SKU não existe, timeout), bloqueia
   *      a aprovação e lança BadRequestException — operadora vê o erro e decide.
   *    - Sucesso → grava log `debit.real.applied` em integration_logs.
   *
   *  SHADOW (default):
   *    - Apenas grava `debit.approved.shadow` em integration_logs.
   *    - Não toca no Gigasistemas. Operadora ainda precisa passar no PDV manualmente.
   *
   * Em ambos os casos, marca `debitApprovedAt` no pick-order. O status logístico
   * (separated/shipped) fica intacto — baixa é independente do fluxo de envio.
   */
  async approveDebit(pickOrderId: string, operatorUserId: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true,
        status: true,
        storeId: true,
        orderId: true,
        debitApprovedAt: true,
        store: { select: { code: true, name: true } },
      } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    // Aceita aprovar em qualquer status DEPOIS que a loja bipou (separated, ready, shipped).
    // Nunca antes — não dá pra aprovar baixa sem validação de itens.
    const okStatuses: PickStatus[] = ['separated', 'ready', 'shipped'];
    if (!okStatuses.includes(po.status as PickStatus)) {
      throw new BadRequestException(
        `Status atual é "${po.status}" — só aprova depois da separação bipada`,
      );
    }
    if ((po as any).debitApprovedAt) {
      throw new BadRequestException('Baixa já foi aprovada anteriormente');
    }

    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: po.storeId },
      select: { sku: true, quantity: true, productName: true },
    });

    const storeCode = String(((po as any).store?.code) ?? '').trim();
    const writeEnabled = this.erp.isWriteEnabled;
    let realApplied: Array<{ sku: string; storeCode: string; qty: number; previousStock: number; newStock: number }> | null = null;

    if (writeEnabled) {
      // Validação: sem código de loja (LJ01/01) não dá pra baixar no Giga
      if (!storeCode) {
        throw new BadRequestException(
          'Loja sem código configurado (store.code vazio) — não é possível baixar no Gigasistemas',
        );
      }

      const result = await this.erp.decreaseStock(
        items.map((i) => ({ sku: i.sku, qty: i.quantity, storeCode })),
      );

      if (!result.success) {
        // Log de falha pra auditoria (tabela integration_logs)
        await this.prisma.integrationLog.create({
          data: {
            source: 'erp',
            direction: 'out',
            event: 'debit.real.failed',
            payload: JSON.stringify({
              pickOrderId,
              approvedBy: operatorUserId,
              storeCode,
              items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
              error: result.error,
            }),
            status: 500,
            error: result.error?.slice(0, 500),
          },
        });
        throw new BadRequestException(
          `Falha ao baixar estoque no Gigasistemas: ${result.error ?? 'erro desconhecido'}`,
        );
      }

      realApplied = result.applied;

      // Log de sucesso com o antes/depois de cada SKU pra auditoria
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.real.applied',
          payload: JSON.stringify({
            pickOrderId,
            approvedBy: operatorUserId,
            storeCode,
            applied: result.applied,
          }),
          status: 200,
        },
      });
    } else {
      // SHADOW: grava intenção de baixa pra auditoria/comparação
      await this.prisma.integrationLog.create({
        data: {
          source: 'pick-order',
          direction: 'internal',
          event: 'debit.approved.shadow',
          payload: JSON.stringify({
            pickOrderId,
            approvedBy: operatorUserId,
            storeId: po.storeId,
            storeCode,
            items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
            note: 'SHADOW MODE — ERP_WRITE_ENABLED=false. Baixa manual no PDV ainda é necessária.',
          }),
          status: 200,
        },
      });
    }

    // Só seta o flag de aprovação. NÃO mexe em status logístico.
    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: {
        debitApprovedAt: new Date(),
        debitApprovedBy: operatorUserId,
      } as any,
    });

    return {
      id: updated.id,
      status: updated.status,
      debitApprovedAt: (updated as any).debitApprovedAt,
      shadowMode: !writeEnabled,
      realApplied,
      itemsCount: items.length,
    };
  }

  /**
   * Matriz aprova baixa em LOTE — recebe array de pick-order IDs, itera e aprova
   * cada um. Não é transacional (se um falhar, os outros já aprovados continuam).
   * Retorna summary: approved/skipped/errors pra UI mostrar o que rolou.
   *
   * Usa um único integration_log "debit.bulk-approved.shadow" agregando o batch
   * inteiro (além dos logs individuais por pick-order que `approveDebit` já cria).
   */
  async bulkApproveDebit(pickOrderIds: string[], operatorUserId: string) {
    const ids = Array.from(new Set((pickOrderIds ?? []).filter(Boolean)));
    if (ids.length === 0) {
      return { approved: [], skipped: [], errors: [], total: 0 };
    }

    const approved: Array<{ id: string; itemsCount: number }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        const res = await this.approveDebit(id, operatorUserId);
        approved.push({ id: res.id, itemsCount: res.itemsCount });
      } catch (e: any) {
        const msg = String(e?.message ?? 'erro desconhecido');
        // Distingue "já aprovado" / "status inválido" (skipped) de erro real
        if (
          msg.includes('já foi aprovada') ||
          msg.includes('só aprova depois') ||
          msg.includes('não encontrado')
        ) {
          skipped.push({ id, reason: msg });
        } else {
          errors.push({ id, error: msg });
        }
      }
    }

    const writeEnabled = this.erp.isWriteEnabled;

    // Log agregado pro auditoria rápida do batch. Event reflete o modo.
    await this.prisma.integrationLog.create({
      data: {
        source: writeEnabled ? 'erp' : 'pick-order',
        direction: writeEnabled ? 'out' : 'internal',
        event: writeEnabled ? 'debit.bulk-approved.real' : 'debit.bulk-approved.shadow',
        payload: JSON.stringify({
          approvedBy: operatorUserId,
          total: ids.length,
          approvedCount: approved.length,
          skippedCount: skipped.length,
          errorCount: errors.length,
          approvedIds: approved.map((a) => a.id),
          skipped,
          errors,
        }),
        status: 200,
      },
    });

    return {
      approved,
      skipped,
      errors,
      total: ids.length,
      shadowMode: !writeEnabled,
    };
  }

  /**
   * Matriz rejeita a baixa — volta pra `separating` pra loja revisar.
   * Grava motivo no log pra loja consultar.
   */
  async rejectDebit(pickOrderId: string, operatorUserId: string, reason: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, status: true, storeId: true, debitApprovedAt: true } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    // Só rejeita se loja ainda não postou (não faz sentido rejeitar algo que já foi).
    if (po.status === 'shipped') {
      throw new BadRequestException(
        'Pedido já foi enviado — não dá pra rejeitar. Use ajuste manual no ERP.',
      );
    }
    if (po.status !== 'separated' && po.status !== 'ready') {
      throw new BadRequestException(`Status atual é "${po.status}" — só rejeita depois da bipagem`);
    }

    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.rejected',
        payload: JSON.stringify({
          pickOrderId,
          rejectedBy: operatorUserId,
          reason: reason?.trim() || '(sem motivo informado)',
        }),
        status: 200,
      },
    });

    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: { status: 'separating' },
    });

    this.gateway.emitPickOrderStatus(po.storeId, {
      id: updated.id,
      status: 'separating',
    });

    return { id: updated.id, status: updated.status, reason };
  }

  /**
   * Reabre a baixa de um pick-order aprovado (seta debitApprovedAt=null).
   * Serve pra devolver o pick-order pra tela /baixa-estoque quando a baixa foi
   * aprovada em modo SHADOW e agora o ERP_WRITE_ENABLED foi ativado — a operadora
   * quer tentar de novo LIVE.
   *
   * PROTEÇÕES (evita baixa dupla):
   *   - Bloqueia se já existe log `debit.real.applied` pra esse pickOrderId
   *     (ERP já foi tocado de verdade — reabrir causaria estoque -2 em vez de -1)
   *   - Bloqueia se debitApprovedAt é null (já está na fila)
   *   - Bloqueia se pick-order não existe
   *
   * Grava log `debit.reopened` com motivo pra auditoria.
   */
  async reopenDebit(pickOrderId: string, operatorUserId: string, reason?: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true, status: true, storeId: true,
        debitApprovedAt: true,
        store: { select: { code: true, name: true } },
      } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (!(po as any).debitApprovedAt) {
      throw new BadRequestException('Baixa ainda não foi aprovada — não tem o que reabrir');
    }

    // PROTEÇÃO CRÍTICA: procura log de debit.real.applied pra esse pickOrderId.
    // Se existir, ERP já foi tocado — reabrir baixaria de novo (estoque dobrado).
    // Procuramos via `contains` no payload JSON porque event/source é comum.
    const liveLog = await this.prisma.integrationLog.findFirst({
      where: {
        source: 'erp',
        event: 'debit.real.applied',
        payload: { contains: `"pickOrderId":"${pickOrderId}"` },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    if (liveLog) {
      throw new BadRequestException(
        `Este pick-order já foi baixado no Gigasistemas em modo LIVE (log #${liveLog.id}). ` +
        'Reabrir causaria baixa dupla. Se precisar ajustar, faça direto no ERP.',
      );
    }

    // Audit: log da reabertura
    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.reopened',
        payload: JSON.stringify({
          pickOrderId,
          reopenedBy: operatorUserId,
          storeCode: (po as any).store?.code ?? null,
          storeName: (po as any).store?.name ?? null,
          previousApprovedAt: (po as any).debitApprovedAt,
          reason: reason?.trim() || null,
        }),
        status: 200,
      },
    });

    // Reseta a aprovação → volta pra fila de /baixa-estoque
    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: {
        debitApprovedAt: null,
        debitApprovedBy: null,
      } as any,
    });

    return {
      id: updated.id,
      status: updated.status,
      debitApprovedAt: null,
      reopened: true,
    };
  }

  /**
   * Reabre baixa em LOTE. Itera sobre os IDs chamando reopenDebit.
   * Retorna summary (reopened/skipped/blocked/errors) — blocked separa os casos
   * "já foi LIVE" pra operadora entender por que alguns não voltaram.
   *
   * Grava log agregado `debit.bulk-reopened` com contadores.
   */
  async bulkReopenDebit(pickOrderIds: string[], operatorUserId: string, reason?: string) {
    const ids = Array.from(new Set((pickOrderIds ?? []).filter(Boolean)));
    if (ids.length === 0) {
      return { reopened: [], skipped: [], blocked: [], errors: [], total: 0 };
    }

    const reopened: Array<{ id: string }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    const blocked: Array<{ id: string; reason: string }> = [];
    const errors: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        await this.reopenDebit(id, operatorUserId, reason);
        reopened.push({ id });
      } catch (e: any) {
        const msg = String(e?.message ?? 'erro desconhecido');
        if (msg.includes('não encontrado') || msg.includes('ainda não foi aprovada')) {
          skipped.push({ id, reason: msg });
        } else if (msg.includes('baixa dupla') || msg.includes('LIVE')) {
          blocked.push({ id, reason: msg });
        } else {
          errors.push({ id, error: msg });
        }
      }
    }

    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.bulk-reopened',
        payload: JSON.stringify({
          reopenedBy: operatorUserId,
          reason: reason?.trim() || null,
          total: ids.length,
          reopenedCount: reopened.length,
          skippedCount: skipped.length,
          blockedCount: blocked.length,
          errorCount: errors.length,
          reopenedIds: reopened.map((r) => r.id),
          skipped,
          blocked,
          errors,
        }),
        status: 200,
      },
    });

    return { reopened, skipped, blocked, errors, total: ids.length };
  }

  /**
   * RETRY DA BAIXA AUTOMÁTICA que falhou (ETIMEDOUT, ECONNRESET, etc).
   *
   * Quando o pick-order foi marcado 'shipped' e o autoDebitOnShipped tentou
   * bater no Giga mas falhou (ex: rede caiu), o pick-order fica em limbo:
   *   - status = 'shipped' ✅ (pra loja, o pedido saiu)
   *   - debitApprovedAt = null ❌ (matriz não debitou de verdade)
   *   - tem log `debit.real.failed` ❌ (evidência de falha)
   *
   * Isso bagunça o estoque (venda enviada mas não baixada no ERP).
   * `reopenDebit` não resolve porque ele exige `debitApprovedAt != null`
   * (ele é pra desfazer uma baixa já aprovada — aqui é o OPOSTO).
   *
   * Esse método:
   *   1. Valida que o pick-order está em estado LIVE FALHOU (shipped + sem aprovação + tem log falhou)
   *   2. Valida anti-dupla (sem log debit.real.applied)
   *   3. Re-executa autoDebitOnShipped (que agora tem retry automático no ERP)
   *   4. Loga `debit.retry.attempted` com resultado pra auditoria
   *   5. Retorna o resultado (aplicado / ainda falhou)
   *
   * Chamado por POST /pick-orders/:id/retry-auto-debit (botão "Retry" no log de baixas).
   */
  async retryAutoDebit(pickOrderId: string, operatorUserId: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: {
        id: true,
        status: true,
        storeId: true,
        orderId: true,
        debitApprovedAt: true,
        store: { select: { code: true, name: true } },
      } as any,
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');

    // GUARD 1: já tem baixa aprovada → usar reopenDebit, não retry
    if ((po as any).debitApprovedAt) {
      throw new BadRequestException(
        'Pick-order já tem baixa aprovada. Se quer refazer, use "Reabrir" na tela /baixa-estoque.',
      );
    }

    // GUARD 2: precisa estar em estado pós-envio (shipped) pra fazer sentido retry
    // Aceita variações caso futuramente o enum mude.
    const st = String((po as any).status ?? '').toLowerCase();
    if (st !== 'shipped') {
      throw new BadRequestException(
        `Pick-order está em status "${st}" — retry de baixa automática só faz sentido após 'shipped'.`,
      );
    }

    // GUARD 3: anti-dupla — se já existe debit.real.applied, ERP já foi tocado
    const priorApplied = await this.prisma.integrationLog.findFirst({
      where: {
        source: 'erp',
        event: 'debit.real.applied',
        payload: { contains: `"pickOrderId":"${pickOrderId}"` },
      },
      select: { id: true },
    });
    if (priorApplied) {
      throw new BadRequestException(
        `Já existe log debit.real.applied #${priorApplied.id} — ERP foi baixado. ` +
        'Retry causaria baixa dupla. Veja o log ou corrija direto no Giga.',
      );
    }

    // GUARD 4: precisa ter log de falha pra justificar o retry (evita disparo aleatório)
    const priorFailed = await this.prisma.integrationLog.findFirst({
      where: {
        source: 'erp',
        event: 'debit.real.failed',
        payload: { contains: `"pickOrderId":"${pickOrderId}"` },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    if (!priorFailed) {
      throw new BadRequestException(
        'Nenhuma falha anterior registrada pra esse pick-order. Nada pra tentar de novo.',
      );
    }

    // Auditoria — loga intenção ANTES de tentar
    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'debit.retry.attempted',
        payload: JSON.stringify({
          pickOrderId,
          retryBy: operatorUserId,
          storeCode: (po as any).store?.code ?? null,
          storeName: (po as any).store?.name ?? null,
          previousFailedLogId: priorFailed.id,
        }),
        status: 200,
      },
    });

    // Re-executa a lógica de auto-baixa. autoDebitOnShipped já cuida de
    // logar debit.real.failed/applied e atualizar debitApprovedAt em caso de sucesso.
    const result = await this.autoDebitOnShipped(pickOrderId, operatorUserId);

    return {
      pickOrderId,
      attempted: result.attempted,
      applied: result.applied,
      skipped: result.skipped,
      shadow: result.shadow,
      reason: result.reason,
    };
  }

  /**
   * Lista TODOS os pick-orders de um pedido WC (matriz-only).
   * Usado pela tela /pedidos/wc/[id] pra mostrar status de cada loja ao vivo,
   * incluindo rastreio quando enviado. Join com store pra ter nome/code.
   */
  async listByWcOrderId(wcOrderId: number) {
    const order = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: { id: true },
    });
    if (!order) return [];

    const rows = await this.prisma.pickOrder.findMany({
      where: { orderId: order.id },
      orderBy: [{ createdAt: 'asc' }],
      include: {
        store: { select: { id: true, code: true, name: true, city: true } },
      },
    });
    // ITENS de cada loja (14/07 skus p/ "Trocar loja"; 15/07 lista completa p/
    // a operadora VER quais peças cada loja separa e decidir consolidar). Item
    // vai pra loja onde foi assignado; sem assignação (pedido de loja única)
    // conta pra loja se for a única pick-order.
    const itens = await this.prisma.orderItem.findMany({
      where: { orderId: order.id },
      select: { sku: true, productName: true, quantity: true, assignedStoreId: true },
    });
    const soUmaLoja = rows.length === 1;
    const itensDaStore = (storeId: string) =>
      itens.filter((i) => i.assignedStoreId === storeId || (soUmaLoja && !i.assignedStoreId));
    const skusPorStore = (storeId: string): string[] =>
      Array.from(new Set(itensDaStore(storeId).map((i) => String(i.sku || '').trim()).filter(Boolean)));
    const itemsPorStore = (storeId: string) =>
      itensDaStore(storeId).map((i) => ({
        sku: String(i.sku || '').trim(),
        descricao: i.productName || null,
        qty: Number(i.quantity) || 1,
      }));
    const reasonLabels: Record<string, string> = {
      out_of_stock: 'Sem estoque físico',
      defective: 'Peça com defeito',
      divergence: 'Divergência (cor/tamanho)',
      other: 'Outro',
    };
    return rows.map((r) => {
      const issueReason = (r as any).issueReason ?? null;
      const debitApprovedAt = (r as any).debitApprovedAt ?? null;
      // Status da baixa ERP (Gigasistemas):
      //   applied  = baixa LIVE aplicada (debitApprovedAt preenchido)
      //   pending  = ainda não é hora (pick-order não enviado)
      //   missing  = foi enviado (shipped) MAS sem baixa aprovada → auto-baixa pode ter falhado
      //             → operadora deve ir em /retaguarda/baixas-log pra diagnosticar
      let debitStatus: 'applied' | 'pending' | 'missing';
      if (debitApprovedAt) debitStatus = 'applied';
      else if (r.status === 'shipped') debitStatus = 'missing';
      else debitStatus = 'pending';

      return {
        id: r.id,
        status: r.status,
        trackingCode: r.trackingCode,
        carrier: r.carrier,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        storeId: r.storeId,
        storeCode: r.store?.code ?? null,
        storeName: r.store?.name ?? null,
        storeCity: r.store?.city ?? null,
        // SKUs desta loja (pra cobertura do "Trocar loja" — ver acima).
        skus: skusPorStore(r.storeId),
        // Peças que ESTA loja separa (descrição + qtd) — a operadora vê o que
        // foi roteado pra cada uma e decide consolidar (evitar 2 SEDEX).
        items: itemsPorStore(r.storeId),
        isTransfer: (r as any).isTransfer ?? false,
        transferToStoreCode: (r as any).transferToStoreCode ?? null,
        issueReason,
        issueReasonLabel: issueReason ? reasonLabels[issueReason] ?? issueReason : null,
        issueNote: (r as any).issueNote ?? null,
        issueReportedAt: (r as any).issueReportedAt ?? null,
        // Status de baixa no ERP (Gigasistemas)
        debitApprovedAt,
        debitStatus,
      };
    });
  }

  /**
   * Detalhe de 1 pick-order. Valida que pertence à loja do user.
   * Retorna dados completos do cliente (CPF/email/telefone/endereço) +
   * forma de envio pro cupom de impressão e tela da filial exibirem tudo
   * que é útil pra despacho, follow-up ou emissão de NF.
   */
  async getOne(id: string, storeId: string) {
    const row = await this.prisma.pickOrder.findUnique({
      where: { id },
      include: { order: { include: { items: true } }, store: true },
    });
    if (!row) throw new NotFoundException('Pick-order não encontrado');
    if (row.storeId !== storeId) {
      throw new ForbiddenException('Pick-order não pertence à sua loja');
    }
    // Filtra itens só dessa loja
    const items = row.order.items.filter(
      (i) => !i.assignedStoreId || i.assignedStoreId === storeId,
    );
    // Parse snapshot do cliente (só em transferência) pro frontend não precisar
    // parsear JSON textual de novo.
    let customerSnapshotObj: any = null;
    if ((row as any).customerSnapshot) {
      try {
        customerSnapshotObj = JSON.parse((row as any).customerSnapshot);
      } catch {
        customerSnapshotObj = null;
      }
    }
    return {
      id: row.id,
      status: row.status,
      trackingCode: row.trackingCode,
      carrier: row.carrier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      isTransfer: (row as any).isTransfer ?? false,
      transferToStoreCode: (row as any).transferToStoreCode ?? null,
      customerSnapshot: customerSnapshotObj,
      store: {
        id: row.store.id,
        code: row.store.code,
        name: row.store.name,
      },
      order: {
        id: row.order.id,
        wcOrderId: row.order.wcOrderId,
        wcOrderNumber: row.order.wcOrderNumber,
        customerName: row.order.customerName,
        customerPhone: row.order.customerPhone,
        customerCpf: row.order.customerCpf,
        customerEmail: row.order.customerEmail,
        shippingCep: row.order.shippingCep,
        shippingAddress: row.order.shippingAddress,
        shippingMethod: (row.order as any).shippingMethod ?? null,
        isPickup: (row.order as any).isPickup ?? false,
        pickupStoreCode: (row.order as any).pickupStoreCode ?? null,
        totalAmount: row.order.totalAmount,
        wcDateCreated: row.order.wcDateCreated,
        items,
      },
    };
  }

  /**
   * TESTE: cria um pick-order forçado pra uma loja específica (ignora estoque/roteamento).
   * Se orderId não for passado, cria um Order sintético (TESTE-<timestamp>) com 2 itens.
   * Emite socket pra loja receber em tempo real na /minha-loja.
   */
  /**
   * Remove um pick-order específico (cancelamento manual da retaguarda).
   * Items dele ficam SEM atribuição (assignedStoreId=null) — retaguarda
   * resolveu fora do sistema. Outros pick-orders do mesmo Order ficam intactos.
   *
   * Bloqueia se status=shipped/delivered (envio já feito, não cancelar).
   */
  async removePickOrder(pickOrderId: string): Promise<{
    ok: boolean;
    pickOrderId: string;
    storeCode: string;
    storeName: string;
    itemsLiberados: number;
  }> {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: { select: { id: true, code: true, name: true } },
        order: { select: { id: true } },
      },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');

    // Não permite remover quem já enviou (preservar tracking/baixa Giga)
    const blocked = ['shipped', 'delivered'];
    if (blocked.includes(po.status)) {
      throw new BadRequestException(
        `Não dá pra remover pick-order com status "${po.status}". Use Trocar Loja se precisar reverter.`,
      );
    }

    const orderId = po.order.id;
    const storeId = po.store.id;
    const storeCode = po.store.code;
    const storeName = po.store.name;

    // Conta items que estavam atribuídos a essa loja (pra retornar count)
    const itemsLiberados = await this.prisma.orderItem.count({
      where: { orderId, assignedStoreId: storeId },
    });

    await this.prisma.$transaction(async (tx) => {
      // Libera items
      await tx.orderItem.updateMany({
        where: { orderId, assignedStoreId: storeId },
        data: { assignedStoreId: null },
      });
      // Deleta pick-order
      await tx.pickOrder.delete({ where: { id: pickOrderId } });
      // Histórico
      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: po.status,
          toStatus: po.status,
          note:
            `Pick-order da loja ${storeCode} REMOVIDO manualmente pela retaguarda. ` +
            `${itemsLiberados} item(ns) liberado(s) (sem reatribuição). ` +
            (po.issueReason ? `Motivo do problema reportado: ${po.issueReason}.` : ''),
        },
      });
    });

    // Notifica loja por socket pra remover o card do app /minha-loja
    try {
      this.gateway?.emitPickOrderRemoved?.(storeId, { orderId });
    } catch (e: any) {
      this.logger.warn(`Falha ao emitir socket: ${e?.message}`);
    }

    return { ok: true, pickOrderId, storeCode, storeName, itemsLiberados };
  }

  async forceCreateForStore(storeCode: string, orderId?: string) {
    if (!storeCode?.trim()) throw new BadRequestException('storeCode obrigatório');
    const store = await this.prisma.store.findUnique({ where: { code: storeCode.trim() } });
    if (!store) throw new NotFoundException(`Loja com código "${storeCode}" não existe`);

    let order: any;
    if (orderId) {
      order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundException(`Order ${orderId} não encontrado`);
    } else {
      const stamp = Date.now();
      order = await this.prisma.order.create({
        data: {
          wcOrderId: stamp,
          wcOrderNumber: `TESTE-${stamp}`,
          customerName: 'Cliente TESTE',
          customerPhone: '(11) 99999-0000',
          shippingCep: '04077-000',
          shippingAddress: 'Av. Ibirapuera, 3103 - Moema, São Paulo - SP',
          totalAmount: 199.9,
          status: 'separating',
          items: {
            create: [
              {
                sku: 'TESTE-SKU-1',
                productName: 'Vestido Plus Size Exemplo (Tam G)',
                quantity: 2,
                assignedStoreId: store.id,
              },
              {
                sku: 'TESTE-SKU-2',
                productName: 'Blusa Manga Longa (Tam GG)',
                quantity: 1,
                assignedStoreId: store.id,
              },
            ],
          },
        },
        include: { items: true },
      });
    }

    const pickOrder = await this.prisma.pickOrder.create({
      data: { orderId: order.id, storeId: store.id, status: 'new' },
    });

    this.gateway.emitPickOrderToStore(store.id, {
      id: pickOrder.id,
      status: 'new',
      storeId: store.id,
      orderId: order.id,
      order: {
        id: order.id,
        wcOrderId: order.wcOrderId,
        wcOrderNumber: order.wcOrderNumber,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        shippingCep: order.shippingCep,
        shippingAddress: order.shippingAddress,
        totalAmount: order.totalAmount,
        wcDateCreated: order.wcDateCreated,
        items: order.items,
      },
      storeCode: store.code,
      storeName: store.name,
      strategy: 'manual-test',
    });

    return {
      ok: true,
      pickOrderId: pickOrder.id,
      store: { id: store.id, code: store.code, name: store.name },
      order: { id: order.id, wcOrderNumber: order.wcOrderNumber },
    };
  }

  /**
   * Transiciona o status. Valida que user é dono da loja.
   * Quando vai pra 'shipped', exige trackingCode + carrier.
   */
  async updateStatus(
    id: string,
    storeId: string,
    userId: string,
    input: { status: PickStatus; trackingCode?: string; carrier?: string },
  ) {
    if (!VALID_STATUSES.includes(input.status)) {
      throw new BadRequestException(`Status inválido: ${input.status}`);
    }

    const current = await this.prisma.pickOrder.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Pick-order não encontrado');
    if (current.storeId !== storeId) {
      throw new ForbiddenException('Pick-order não pertence à sua loja');
    }

    const currentStatus = current.status as PickStatus;

    // ════════════════════════════════════════════════════════════════════════
    //  GUARD CRÍTICO — BLOQUEAR RE-ENVIO DE PEDIDO JÁ ENVIADO
    //
    //  Caso real (06/06 → 10/06): mesma cliente recebeu 2 pacotes do mesmo
    //  pedido. Loja "enviou" o mesmo pedido em datas diferentes porque o
    //  check de transição abaixo permitia shipped → shipped (a condição
    //  `input.status !== currentStatus` vira false quando ambos são shipped).
    //
    //  Esse guard bloqueia explicitamente. Mostra rastreio + data do envio
    //  anterior pra operadora entender. Se precisar reenviar de verdade
    //  (cliente alega extravio etc.), tem que pedir admin pra resetar o
    //  status — não pode disparar nova etiqueta + baixa Giga + nota WC
    //  clicando "Enviar" duas vezes.
    // ════════════════════════════════════════════════════════════════════════
    if (currentStatus === 'shipped' && input.status === 'shipped') {
      const dataEnvio = current.updatedAt
        ? new Date(current.updatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
        : 'data desconhecida';
      const rastreio = current.trackingCode
        ? `${current.carrier ?? ''} ${current.trackingCode}`.trim()
        : 'sem rastreio';
      throw new BadRequestException(
        `🚫 ENVIO DUPLICADO BLOQUEADO. Este pedido JÁ FOI ENVIADO em ${dataEnvio} ` +
          `(rastreio: ${rastreio}). Se a cliente alega que não recebeu, abra um ` +
          `chamado com a transportadora — NÃO envie outro pacote sem confirmar ` +
          `com a matriz.`,
      );
    }

    const allowed = NEXT_ALLOWED[currentStatus] ?? [];
    if (!allowed.includes(input.status) && input.status !== currentStatus) {
      throw new BadRequestException(
        `Transição ${currentStatus} → ${input.status} não permitida`,
      );
    }

    if (input.status === 'shipped') {
      const code = (input.trackingCode ?? '').trim();
      const carrier = (input.carrier ?? '').trim();
      if (!code) throw new BadRequestException('Código de rastreio é obrigatório');
      if (!carrier) throw new BadRequestException('Transportadora é obrigatória');
    }

    const updated = await this.prisma.pickOrder.update({
      where: { id },
      data: {
        status: input.status,
        ...(input.status === 'shipped'
          ? { trackingCode: input.trackingCode?.trim(), carrier: input.carrier?.trim() }
          : {}),
      },
      include: {
        order: { select: { wcOrderNumber: true, wcOrderId: true, customerName: true, source: true, liveCartId: true } },
        store: { select: { code: true, name: true } },
      },
    });

    // Histórico no pedido
    await this.prisma.orderHistory.create({
      data: {
        orderId: current.orderId,
        userId,
        fromStatus: currentStatus,
        toStatus: input.status,
        note:
          input.status === 'shipped'
            ? `Enviado pela loja. Rastreio: ${input.trackingCode} (${input.carrier})`
            : `Mudança de status: ${currentStatus} → ${input.status}`,
      },
    });

    // Se todos os pick-orders do pedido foram shipped, marca order.status=shipped
    let allSiblings: Array<{ status: string; trackingCode: string | null; carrier: string | null; storeId: string }> = [];
    let allShipped = false;
    if (input.status === 'shipped') {
      allSiblings = await this.prisma.pickOrder.findMany({
        where: { orderId: current.orderId },
        select: { status: true, trackingCode: true, carrier: true, storeId: true },
      });
      allShipped = allSiblings.every((p) => p.status === 'shipped');
      if (allShipped) {
        await this.prisma.order.update({
          where: { id: current.orderId },
          data: { status: 'shipped', trackingCode: input.trackingCode, carrier: input.carrier },
        });
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  SYNC COM WOOCOMMERCE
    //  Faz o site refletir o que a loja mudou:
    //    separating/ready → WC status 'separacao' (Em Separação)
    //    shipped          → push rastreio no meta_data; se TODOS siblings enviados
    //                       → WC status 'enviado' (fallback 'completed' se inexistente)
    //
    //  Falha aqui NÃO derruba a ação da loja — só loga e anexa warning na resposta.
    // ════════════════════════════════════════════════════════════════════════
    const isLiveOrder = (updated.order as any)?.source === 'live';
    // Pedido da LIVE: espelha o status de volta no carrinho da live (console
    // da operadora/dashboards) — e NUNCA sincroniza com o WooCommerce (o
    // wcOrderId é sintético; não existe no site).
    if (isLiveOrder && (updated.order as any)?.liveCartId) {
      const liveCartId = (updated.order as any).liveCartId as string;
      if (input.status === 'shipped' && allShipped) {
        await (this.prisma as any).livePdvCart
          .update({ where: { id: liveCartId }, data: { status: 'shipped' } })
          .catch(() => {});
      }
    }

    // ═══ EFEITOS DO ENVIO (best-effort — falha NUNCA desfaz o shipped) ═══
    //  1. Acerto intercompany ÷2,5: quem cedeu a peça recebe da "dona" da venda
    //     (LIVE → loja da live; SITE → REDE, decisão do dono 12/07). REDE→REDE
    //     não gera (mesmo dono).
    //  2. Cliente da LIVE recebe WhatsApp com o rastreio (o site já avisa via
    //     hook completed do WooCommerce).
    if (input.status === 'shipped') {
      this.afterShippedSideEffects(id, input).catch((e) =>
        this.logger.warn(`[shipped-effects] pick ${id}: ${e?.message || e}`),
      );
    }

    const wcOrderId =
      !isLiveOrder && updated.order?.wcOrderId ? Number(updated.order.wcOrderId) : null;
    const storeLabel = updated.store
      ? `${updated.store.name} (${updated.store.code})`
      : 'Loja';
    let wcSyncWarning: string | null = null;
    let wcSyncApplied: string | null = null;

    if (wcOrderId) {
      try {
        if (input.status === 'separating' || input.status === 'ready') {
          // Não sobrescreve se já tá em separação ou adiante — evita voltar de 'enviado' pra 'separacao'
          // se admin tiver adiantado manualmente. updateOrder é idempotente (WC aceita mesmo status).
          await this.wc.updateOrder(wcOrderId, { status: WC_STATUS_SEPARATING });
          await this.wc.addOrderNote(
            wcOrderId,
            `${storeLabel} iniciou a separação do pedido (FlowOps).`,
            false, // nota interna, não notifica cliente
          );
          wcSyncApplied = `site marcado como "Em Separação"`;
        } else if (input.status === 'shipped') {
          const trackCode = (input.trackingCode ?? '').trim();
          const trackCarrier = (input.carrier ?? '').trim();

          // Pega todos os rastreios (multi-loja pode ter vários)
          const allTracks = allSiblings
            .filter((p) => p.trackingCode)
            .map((p) => ({ code: p.trackingCode!, carrier: p.carrier || 'Correios' }));

          const primaryTrack = allTracks[0] ?? { code: trackCode, carrier: trackCarrier };

          // Monta payload pro WC
          const wcPayload: Parameters<typeof this.wc.updateOrder>[1] = {
            trackingNumber: primaryTrack.code,
            trackingCarrier: primaryTrack.carrier,
          };
          if (allShipped) {
            wcPayload.status = WC_STATUS_SHIPPED; // todos os siblings enviados → finaliza
          }
          await this.wc.updateOrder(wcOrderId, wcPayload);

          // Nota interna no pedido com detalhes do envio
          if (allTracks.length > 1) {
            const listing = allTracks
              .map((t) => `  • ${t.carrier}: ${t.code}`)
              .join('\n');
            await this.wc.addOrderNote(
              wcOrderId,
              `${storeLabel} enviou o pedido (FlowOps).\n` +
                `Pedido multi-loja — ${allTracks.length} envios:\n${listing}\n` +
                (allShipped
                  ? 'Todos os envios concluídos — pedido marcado como Enviado.'
                  : 'Aguardando envio das outras lojas pra finalizar.'),
              false,
            );
          } else {
            await this.wc.addOrderNote(
              wcOrderId,
              `${storeLabel} enviou o pedido (FlowOps). Rastreio: ${trackCode} (${trackCarrier}).`,
              false,
            );
          }
          wcSyncApplied = allShipped
            ? `site marcado como "Enviado" + rastreio`
            : `rastreio salvo no site (aguardando outras lojas)`;
        }
      } catch (e: any) {
        this.logger.warn(
          `Falha ao sincronizar pick-order ${id} com WC order ${wcOrderId}: ${e.message}`,
        );
        wcSyncWarning = `Não conseguiu atualizar o site: ${e.message}`;
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  AUTO-BAIXA NO ERP GIGASISTEMAS (gatilho = shipped + rastreio)
    //
    //  Assim que a filial confirma o envio com rastreio, disparamos a baixa
    //  real no `estoque` do Gigasistemas — sem esperar a matriz aprovar
    //  manualmente em /baixa-estoque. Matriz só atua como fallback quando
    //  algo falhou (cai em /retaguarda/baixas-log e pode reabrir pra re-tentar).
    //
    //  Qualquer falha aqui NÃO derruba o envio: rastreio já foi salvo, pedido
    //  já subiu pro WC, cliente já foi notificado. O erro vira log pra você
    //  tratar depois.
    // ════════════════════════════════════════════════════════════════════════
    let autoDebit: {
      attempted: boolean;
      applied: boolean;
      skipped: boolean;
      shadow: boolean;
      reason: string | null;
    } = { attempted: false, applied: false, skipped: false, shadow: false, reason: null };

    if (input.status === 'shipped') {
      autoDebit = await this.autoDebitOnShipped(id, userId);
    }

    // Emite via socket pra loja (eco) e pro admin (dashboard)
    this.gateway.emitPickOrderStatus(storeId, {
      id: updated.id,
      status: updated.status,
      trackingCode: updated.trackingCode,
      carrier: updated.carrier,
      storeId,
      orderId: current.orderId,
      order: updated.order,
    });

    return {
      id: updated.id,
      status: updated.status,
      trackingCode: updated.trackingCode,
      carrier: updated.carrier,
      updatedAt: updated.updatedAt,
      wcSyncApplied,
      wcSyncWarning,
      autoDebit,
    };
  }

  /**
   * EFEITOS DO ENVIO (best-effort, roda depois do shipped ser gravado):
   *
   * 1. ACERTO INTERCOMPANY ÷2,5 (decisão do dono 12/07 — "o site entra sim,
   *    entra como REDE"): quando a loja que despachou NÃO é a dona da venda,
   *    registra TransferOrder + InterStoreObligation por item, valor = preço
   *    CHEIO ÷ 2,5 (OrderItem.baseUnitPrice — a live grava o preço cheio;
   *    site usa o unitPrice, que já é o cheio).
   *      - dona da venda: LIVE → loja anfitriã da live · SITE → REDE (pseudo
   *        destino "SITE") · pickup-transfer → loja de retirada.
   *      - mesmo dono (REDE→REDE) ou a própria loja da live despachando =
   *        NÃO gera nada (regra do markShipped legado da live).
   * 2. WHATSAPP DE RASTREIO pra cliente da LIVE via ManyChat (o site avisa
   *    pelo hook completed do WooCommerce; a live não tem WC). Gated por
   *    MANYCHAT_RASTREIO_FLOW_NS + MANYCHAT_API_TOKEN — sem envs, pula.
   */
  private async afterShippedSideEffects(
    pickOrderId: string,
    input: { trackingCode?: string; carrier?: string },
  ) {
    const po: any = await (this.prisma as any).pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: true,
        order: { include: { items: true } },
      },
    });
    if (!po?.order) return;
    const order: any = po.order;
    const fromStore: any = po.store;
    const itens: any[] = (order.items || []).filter(
      (i: any) => i.assignedStoreId === po.storeId,
    );
    if (!itens.length) return;

    // ── resolve a "dona" da venda (destino do acerto) ──
    let destino: { code: string; name: string; tipo: string } | null = null;
    let liveCart: any = null;
    if (po.isTransfer && po.transferToStoreCode) {
      const st = await (this.prisma as any).store
        .findUnique({ where: { code: po.transferToStoreCode } })
        .catch(() => null);
      if (st) destino = { code: st.code, name: st.name, tipo: st.tipo === 'FILIAL' ? 'FILIAL' : 'REDE' };
    } else if (order.source === 'live' && order.liveCartId) {
      liveCart = await (this.prisma as any).livePdvCart
        .findUnique({ where: { id: order.liveCartId }, include: { session: true } })
        .catch(() => null);
      const liveStoreCode = liveCart?.session?.liveStoreCode;
      if (liveStoreCode) {
        const st = await (this.prisma as any).store
          .findUnique({ where: { code: liveStoreCode } })
          .catch(() => null);
        destino = st
          ? { code: st.code, name: st.name, tipo: st.tipo === 'FILIAL' ? 'FILIAL' : 'REDE' }
          : { code: liveStoreCode, name: liveCart?.session?.liveStoreName || liveStoreCode, tipo: 'REDE' };
      }
    } else {
      destino = { code: 'SITE', name: 'VENDA SITE', tipo: 'REDE' }; // site é da REDE
    }

    // ── 1) obrigação intercompany ÷2,5 ──
    try {
      const fromTipo = fromStore?.tipo === 'FILIAL' ? 'FILIAL' : 'REDE';
      const mesmaLoja = destino && fromStore?.code === destino.code;
      const mesmoDono = !destino || (fromTipo === 'REDE' && destino.tipo === 'REDE');
      if (destino && !mesmaLoja && !mesmoDono) {
        const mesReferencia = new Date().toISOString().slice(0, 7);
        for (const it of itens) {
          const transfer = await (this.prisma as any).transferOrder.create({
            data: {
              tipo: order.source === 'live' ? 'LIVE' : 'SITE',
              refCode: String(it.sku || ''),
              codigoBipado: String(it.sku || ''),
              descricao: it.productName || null,
              qtyOrigem: Number(it.quantity || 1),
              lojaOrigemCode: fromStore?.code,
              lojaOrigemName: fromStore?.name,
              lojaDestinoCode: destino.code,
              lojaDestinoName: destino.name,
              solicitanteNome: order.source === 'live' ? 'LIVE COMMERCE' : 'VENDA SITE',
              mensagem: `Pedido ${order.wcOrderNumber} expedido${input.trackingCode ? ` (rastreio ${input.trackingCode})` : ''}`,
            },
          });
          const baseUnit = Number(it.baseUnitPrice ?? it.unitPrice ?? 0);
          const precoTotal = baseUnit * Number(it.quantity || 1);
          await (this.prisma as any).interStoreObligation.create({
            data: {
              transferOrderId: transfer.id,
              fromStoreCode: fromStore?.code,
              fromStoreName: fromStore?.name,
              fromStoreTipo: fromTipo,
              toStoreCode: destino.code,
              toStoreName: destino.name,
              toStoreTipo: destino.tipo,
              refCode: String(it.sku || ''),
              sku: String(it.sku || ''),
              descricao: it.productName || null,
              qty: Number(it.quantity || 1),
              precoUnitario: baseUnit,
              precoTotal,
              divisor: PickOrdersService.DIVISOR_CUSTO,
              valorObrigacao: precoTotal / PickOrdersService.DIVISOR_CUSTO,
              mesReferencia,
              status: 'pending',
            },
          });
        }
        this.logger.log(
          `[acerto-÷2,5] pedido ${order.wcOrderNumber}: ${itens.length} item(ns) ${fromStore?.code} → ${destino.code}`,
        );
      }
    } catch (e: any) {
      this.logger.warn(`[acerto-÷2,5] pedido ${order.wcOrderNumber}: ${e?.message || e}`);
    }

    // ── 2) WhatsApp de rastreio pra cliente da LIVE ──
    if (order.source === 'live') {
      try {
        const flowNs = (process.env.MANYCHAT_RASTREIO_FLOW_NS || '').trim();
        if (!flowNs || !this.manychat.enabled) return;
        const digits = String(order.customerPhone || '').replace(/\D/g, '');
        const phone =
          digits.length === 10 || digits.length === 11
            ? '55' + digits
            : digits.startsWith('55') && (digits.length === 12 || digits.length === 13)
              ? digits
              : null;
        if (!phone) return;
        let subId = await this.manychat.findWhatsAppSubscriber(phone);
        if (!subId) {
          const created = await this.manychat.createWhatsAppSubscriber(phone, order.customerName);
          subId = created.id;
        }
        if (!subId) return;
        const primeiroNome = String(order.customerName || '').trim().split(/\s+/)[0] || 'cliente';
        await this.manychat.setCustomFieldByName(subId, 'rastreio_nome', primeiroNome);
        await this.manychat.setCustomFieldByName(subId, 'rastreio_codigo', String(input.trackingCode || ''));
        await this.manychat.setCustomFieldByName(subId, 'rastreio_transportadora', String(input.carrier || 'Correios'));
        await this.manychat.setCustomFieldByName(subId, 'rastreio_pedido', String(order.wcOrderNumber || ''));
        const r = await this.manychat.sendFlow(subId, flowNs);
        this.logger.log(
          `[rastreio-whats] pedido ${order.wcOrderNumber}: ${r.ok ? 'enviado' : `falhou (${r.error})`}`,
        );
      } catch (e: any) {
        this.logger.warn(`[rastreio-whats] pedido ${order.wcOrderNumber}: ${e?.message || e}`);
      }
    }
  }

  /**
   * AUTO-BAIXA disparada pelo `shipped`.
   *
   * Diferente de approveDebit (que é a rota manual da matriz), esse método:
   *  - NUNCA lança exception — envio da filial não pode ser bloqueado por
   *    problema de ERP. Em falha, só loga e devolve `{ reason }` pra auditoria.
   *  - Verifica dupla-baixa por 2 caminhos: debitApprovedAt já marcado OU
   *    log `debit.real.applied` já existente pro mesmo pickOrderId.
   *  - Respeita `ERP_WRITE_ENABLED` — se SHADOW, grava log de intenção e
   *    devolve `shadow:true` sem marcar o flag de aprovação (operadora ainda
   *    tem que passar no PDV manualmente nesse modo).
   */
  private async autoDebitOnShipped(
    pickOrderId: string,
    operatorUserId: string,
  ): Promise<{
    attempted: boolean;
    applied: boolean;
    skipped: boolean;
    shadow: boolean;
    reason: string | null;
  }> {
    try {
      const po = await this.prisma.pickOrder.findUnique({
        where: { id: pickOrderId },
        select: {
          id: true,
          storeId: true,
          orderId: true,
          debitApprovedAt: true,
          store: { select: { code: true } },
        } as any,
      });
      if (!po) {
        return { attempted: false, applied: false, skipped: true, shadow: false, reason: 'pick-order não encontrado após update' };
      }

      // GUARD 1: flag local já marcado
      if ((po as any).debitApprovedAt) {
        this.logger.log(`autoDebit(${pickOrderId}): já aprovado anteriormente — skip`);
        return { attempted: false, applied: false, skipped: true, shadow: false, reason: 'baixa já aprovada' };
      }

      // GUARD 2: procura log histórico (cobre caso de flag ter sido limpo via reopen)
      const prior = await this.prisma.integrationLog.findFirst({
        where: {
          source: 'erp',
          event: 'debit.real.applied',
          payload: { contains: `"pickOrderId":"${pickOrderId}"` },
        },
        select: { id: true },
      });
      if (prior) {
        this.logger.log(`autoDebit(${pickOrderId}): já tem log debit.real.applied — skip anti-dupla`);
        return { attempted: false, applied: false, skipped: true, shadow: false, reason: 'baixa já aplicada em log anterior' };
      }

      const storeCode = String(((po as any).store?.code) ?? '').trim();
      const items = await this.prisma.orderItem.findMany({
        where: { orderId: po.orderId, assignedStoreId: po.storeId },
        select: { sku: true, quantity: true, productName: true },
      });

      if (!items.length) {
        this.logger.warn(`autoDebit(${pickOrderId}): nenhum item atribuído — skip`);
        return { attempted: false, applied: false, skipped: true, shadow: false, reason: 'sem items atribuídos' };
      }

      const writeEnabled = this.erp.isWriteEnabled;

      // SHADOW — só grava intenção
      if (!writeEnabled) {
        await this.prisma.integrationLog.create({
          data: {
            source: 'pick-order',
            direction: 'internal',
            event: 'debit.auto.shadow',
            payload: JSON.stringify({
              pickOrderId,
              trigger: 'shipped',
              approvedBy: operatorUserId,
              storeId: po.storeId,
              storeCode,
              items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
              note: 'SHADOW — envio confirmado mas ERP_WRITE_ENABLED=false. Baixa manual ainda é necessária.',
            }),
            status: 200,
          },
        });
        return { attempted: true, applied: false, skipped: false, shadow: true, reason: 'shadow mode' };
      }

      // LIVE — precisa de storeCode válido pra bater no Giga
      if (!storeCode) {
        await this.prisma.integrationLog.create({
          data: {
            source: 'erp',
            direction: 'out',
            event: 'debit.real.failed',
            payload: JSON.stringify({
              pickOrderId,
              trigger: 'shipped',
              approvedBy: operatorUserId,
              error: 'store.code vazio',
            }),
            status: 500,
            error: 'store.code vazio',
          },
        });
        return { attempted: true, applied: false, skipped: false, shadow: false, reason: 'loja sem código configurado' };
      }

      const result = await this.erp.decreaseStock(
        items.map((i) => ({ sku: i.sku, qty: i.quantity, storeCode })),
      );

      if (!result.success) {
        await this.prisma.integrationLog.create({
          data: {
            source: 'erp',
            direction: 'out',
            event: 'debit.real.failed',
            payload: JSON.stringify({
              pickOrderId,
              trigger: 'shipped',
              approvedBy: operatorUserId,
              storeCode,
              items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
              error: result.error,
            }),
            status: 500,
            error: result.error?.slice(0, 500),
          },
        });
        this.logger.error(`autoDebit(${pickOrderId}) FALHOU: ${result.error}`);
        return { attempted: true, applied: false, skipped: false, shadow: false, reason: result.error ?? 'erro desconhecido no ERP' };
      }

      // SUCESSO — grava log + marca flag
      await this.prisma.integrationLog.create({
        data: {
          source: 'erp',
          direction: 'out',
          event: 'debit.real.applied',
          payload: JSON.stringify({
            pickOrderId,
            trigger: 'shipped',
            approvedBy: operatorUserId,
            storeCode,
            applied: result.applied,
          }),
          status: 200,
        },
      });

      await this.prisma.pickOrder.update({
        where: { id: pickOrderId },
        data: {
          debitApprovedAt: new Date(),
          debitApprovedBy: operatorUserId,
        } as any,
      });

      this.logger.log(`autoDebit(${pickOrderId}) OK — ${result.applied.length} item(ns) baixado(s) no Giga`);
      return { attempted: true, applied: true, skipped: false, shadow: false, reason: null };
    } catch (e: any) {
      const msg = String(e?.message || e);
      this.logger.error(`autoDebit(${pickOrderId}) exception: ${msg}`);
      // Melhor esforço pra logar (sem jogar exception pra cima)
      try {
        await this.prisma.integrationLog.create({
          data: {
            source: 'erp',
            direction: 'out',
            event: 'debit.real.failed',
            payload: JSON.stringify({ pickOrderId, trigger: 'shipped', approvedBy: operatorUserId, error: msg }),
            status: 500,
            error: msg.slice(0, 500),
          },
        });
      } catch { /* ignore */ }
      return { attempted: true, applied: false, skipped: false, shadow: false, reason: msg };
    }
  }

  /**
   * Loja sinaliza PROBLEMA no pick-order (sem estoque físico, defeito, divergência).
   *
   *  - Só aceita em status ATIVOS (new, separating). Se já bipou/separou/postou,
   *    não faz sentido "reportar problema" — manda nota interna em vez disso.
   *  - Seta issueReason + issueNote + reportedAt/By. NÃO deleta o pick-order.
   *  - Card some da fila da loja (listMine filtra issueReason != null).
   *  - Matriz vê badge vermelho em /pedidos e /separacao com motivo.
   *  - Matriz clica "Recalcular" → recalculateForWc auto-exclui a loja que reportou.
   */
  async reportIssue(
    pickOrderId: string,
    storeId: string,
    userId: string,
    input: { reason: string; note?: string },
  ) {
    const validReasons = ['out_of_stock', 'defective', 'divergence', 'other'];
    const reason = String(input.reason ?? '').trim();
    if (!validReasons.includes(reason)) {
      throw new BadRequestException(
        `reason inválido. Use: ${validReasons.join(' | ')}`,
      );
    }

    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: { select: { code: true, name: true } },
        order: { select: { id: true, wcOrderId: true, wcOrderNumber: true } },
      },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.storeId !== storeId) throw new ForbiddenException('Pick-order não é da sua loja');

    const activeStatuses: PickStatus[] = ['new', 'separating'];
    if (!activeStatuses.includes(po.status as PickStatus)) {
      throw new BadRequestException(
        `Status atual é "${po.status}" — só dá pra reportar problema em "new" ou "separating". ` +
          `Se já separou/postou, fale com a matriz direto.`,
      );
    }

    if ((po as any).issueReason) {
      throw new BadRequestException('Problema já reportado anteriormente');
    }

    const note = (input.note ?? '').toString().trim().slice(0, 500) || null;
    const now = new Date();

    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: {
        issueReason: reason,
        issueNote: note,
        issueReportedAt: now,
        issueReportedBy: userId,
      } as any,
    });

    await this.prisma.orderHistory.create({
      data: {
        orderId: po.orderId,
        userId,
        fromStatus: po.status,
        toStatus: po.status,
        note: `Loja ${po.store?.code ?? ''} reportou problema: ${reason}${note ? ' — ' + note : ''}`,
      },
    });

    await this.prisma.integrationLog.create({
      data: {
        source: 'pick-order',
        direction: 'internal',
        event: 'issue.reported',
        payload: JSON.stringify({
          pickOrderId,
          reportedBy: userId,
          storeId,
          storeCode: po.store?.code,
          reason,
          note,
        }),
        status: 200,
      },
    });

    const reasonLabels: Record<string, string> = {
      out_of_stock: 'Sem estoque físico',
      defective: 'Peça com defeito',
      divergence: 'Divergência (cor/tamanho)',
      other: 'Outro',
    };

    this.gateway.emitPickOrderIssue(storeId, {
      pickOrderId,
      orderId: po.orderId,
      wcOrderId: po.order?.wcOrderId ?? null,
      storeId,
      storeCode: po.store?.code ?? null,
      storeName: po.store?.name ?? null,
      reason,
      reasonLabel: reasonLabels[reason],
      note,
      reportedAt: now.toISOString(),
    });

    // Dispara também :removed pra loja limpar o card na hora (sem refetch)
    this.gateway.emitPickOrderRemoved(storeId, {
      orderId: po.orderId,
      pickOrderId,
    });

    return {
      id: updated.id,
      issueReason: (updated as any).issueReason,
      issueNote: (updated as any).issueNote,
      reasonLabel: reasonLabels[reason],
      reportedAt: now.toISOString(),
    };
  }

  /**
   * Matriz dispara impressão remota. Emite socket pra loja dona do pick-order.
   * O Electron da loja (em /minha-loja) recebe o evento e abre uma janela hidden
   * apontando pra /minha-loja/imprimir/{id}?autoprint=1 — essa página chama
   * window.electronAPI.silentPrintHTML() e se fecha.
   *
   * Falha rápido se:
   *  - pick-order não existe
   *  - loja não está online (Electron fechado / PC desligado)
   */
  async triggerRemotePrint(pickOrderId: string): Promise<{
    ok: boolean;
    sent: boolean;
    storeId: string;
    storeName: string | null;
    reason?: string;
  }> {
    const pick = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: { store: { select: { id: true, name: true, code: true } } },
    });
    if (!pick) throw new NotFoundException('Pick-order não encontrado');

    const storeId = pick.storeId;
    const storeName = pick.store?.name ?? null;

    if (!this.gateway.isStoreOnline(storeId)) {
      this.logger.warn(
        `[print-remote] loja ${storeName || storeId} offline — Electron não conectado`,
      );
      return {
        ok: false,
        sent: false,
        storeId,
        storeName,
        reason: 'Loja offline — Electron não está conectado. Verifique se o computador da loja está ligado e com LURDS ORDER ONE aberto.',
      };
    }

    this.gateway.emitPrintRequest(storeId, {
      pickOrderId,
      url: `/minha-loja/imprimir/${pickOrderId}?autoprint=1`,
    });

    this.logger.log(
      `[print-remote] disparado pro Electron da loja ${storeName || storeId} (pick ${pickOrderId})`,
    );

    return {
      ok: true,
      sent: true,
      storeId,
      storeName,
    };
  }
}
