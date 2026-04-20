import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { WooCommerceService } from '../woocommerce/woocommerce.service';
import { ErpService } from '../erp/erp.service';

// Status do pick-order:
//   new          → chegou, filial não começou
//   separating   → filial clicou "Iniciar Separação", bipagem em andamento
//   separated    → filial bipou 100%, aguardando matriz aprovar baixa
//   ready        → matriz aprovou baixa (estoque baixado no ERP), pronto pra postar
//   shipped      → filial postou e adicionou rastreio
export type PickStatus = 'new' | 'separating' | 'separated' | 'ready' | 'shipped';
const VALID_STATUSES: PickStatus[] = ['new', 'separating', 'separated', 'ready', 'shipped'];

// Transições permitidas (não deixa voltar um status atrás, por segurança)
const NEXT_ALLOWED: Record<PickStatus, PickStatus[]> = {
  new: ['separating', 'ready'],       // pode pular "separating" se quiser marcar já pronto
  separating: ['separated', 'ready'], // ready direto é fallback manual do admin (pula bipagem)
  separated: ['ready', 'separating'], // matriz aprova → ready; matriz rejeita → volta pra separating
  ready: ['shipped'],
  shipped: [],                        // ponto final
};

/**
 * Mapeamento do status INTERNO do pick-order (loja) → status no WooCommerce.
 *   - separating/ready → 'separacao' (em separação no site)
 *   - shipped (quando TODOS os pick-orders siblings já foram enviados) → 'enviado'
 *     (se o WC não aceitar 'enviado', o retry no WooCommerceService cai pra 'completed')
 */
const WC_STATUS_SEPARATING = 'separacao';
const WC_STATUS_SHIPPED = 'enviado';

@Injectable()
export class PickOrdersService {
  private readonly logger = new Logger(PickOrdersService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    @Inject(forwardRef(() => WooCommerceService))
    private readonly wc: WooCommerceService,
    private readonly erp: ErpService,
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
      items: items.map((i) => ({
        id: i.id,
        sku: i.sku,
        productName: i.productName,
        quantity: i.quantity,
        ean: eanMap[i.sku] ?? null, // null = sem EAN no ERP → operador precisa reportar
      })),
    };
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

    return {
      id: updated.id,
      status: updated.status,
      wcOrderId: updated.order?.wcOrderId ?? null,
      itemsScanned: scans.length,
    };
  }

  /**
   * Lista os pick-orders DA loja do user logado.
   * Filtro default: status ativos (new, separating, ready). `all=true` traz shipped também.
   */
  async listMine(storeId: string, opts?: { all?: boolean }) {
    const where: any = { storeId };
    if (!opts?.all) {
      where.status = { in: ['new', 'separating', 'separated', 'ready'] };
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
      where: { status: 'separated' },
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
   * Matriz aprova a baixa — transiciona `separated` → `ready`.
   *
   * FASE 1 (SHADOW MODE): grava payload da baixa em integration_logs mas NÃO
   * toca no Gigasistemas. Operadora continua fazendo baixa manual no PDV SITE.
   * Comparação diária detecta divergências.
   *
   * FASE 3 (futuro): substituir o log por call real ao Gigasistemas (INSERT
   * em movimento_estoque + UPDATE em estoque dentro de transação).
   */
  async approveDebit(pickOrderId: string, operatorUserId: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, status: true, storeId: true, orderId: true },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.status !== 'separated') {
      throw new BadRequestException(`Status atual é "${po.status}" — só aprova de "separated"`);
    }

    const items = await this.prisma.orderItem.findMany({
      where: { orderId: po.orderId, assignedStoreId: po.storeId },
      select: { sku: true, quantity: true, productName: true },
    });

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
          items: items.map((i) => ({ sku: i.sku, qty: i.quantity, name: i.productName })),
          note: 'SHADOW MODE — baixa ainda não é aplicada no Gigasistemas',
        }),
        status: 200,
      },
    });

    const updated = await this.prisma.pickOrder.update({
      where: { id: pickOrderId },
      data: { status: 'ready' },
    });

    // Notifica a loja em tempo real (card muda pra "Pronto" → botão Enviar libera)
    this.gateway.emitPickOrderStatus(po.storeId, {
      id: updated.id,
      status: 'ready',
    });

    return {
      id: updated.id,
      status: updated.status,
      shadowMode: true,
      itemsCount: items.length,
    };
  }

  /**
   * Matriz rejeita a baixa — volta pra `separating` pra loja revisar.
   * Grava motivo no log pra loja consultar.
   */
  async rejectDebit(pickOrderId: string, operatorUserId: string, reason: string) {
    const po = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      select: { id: true, status: true, storeId: true },
    });
    if (!po) throw new NotFoundException('Pick-order não encontrado');
    if (po.status !== 'separated') {
      throw new BadRequestException(`Status atual é "${po.status}" — só rejeita de "separated"`);
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
    return rows.map((r) => ({
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
      isTransfer: (r as any).isTransfer ?? false,
      transferToStoreCode: (r as any).transferToStoreCode ?? null,
    }));
  }

  /**
   * Detalhe de 1 pick-order. Valida que pertence à loja do user.
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
    return {
      id: row.id,
      status: row.status,
      trackingCode: row.trackingCode,
      carrier: row.carrier,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
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
        shippingCep: row.order.shippingCep,
        shippingAddress: row.order.shippingAddress,
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
        order: { select: { wcOrderNumber: true, wcOrderId: true, customerName: true } },
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
    const wcOrderId = updated.order?.wcOrderId ? Number(updated.order.wcOrderId) : null;
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
