import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import { RoutingEngine } from './routing.engine';
import { SalesStatsService } from './sales-stats.service';
import { OrderStatus, PickStatus } from '../common/enums';
import { ehItemSemEstoque } from '../common/item-sem-estoque';
import { pedidoOnlineLiberado } from '../common/prova-pagamento';
import { diferencaDeTrocaPendente } from '../common/diferenca-troca';
import { lojasDaRotaPropria } from '../common/rota-propria';
import { RoutingCedeStats, RoutingResult, StockEntry } from './types';
import { computeCommittedStock } from './committed-stock.util';
import { buildWhatsappMessage, buildWhatsappUrl } from './whatsapp-message.util';
import { RealtimeGateway } from '../websocket/realtime.gateway';
import { ErpService } from '../erp/erp.service';
import { PushService } from '../push/push.service';
import { PickScanService } from '../pick-orders/pick-scan.service';
import { LOJA_CANAL_CODES } from '../common/loja-canal';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly engine: RoutingEngine,
    private readonly gateway: RealtimeGateway,
    private readonly salesStats: SalesStatsService,
    private readonly erp: ErpService,
    private readonly push: PushService,
    // Estorno dos bipes: desde 18/08 a peça sai do estoque no bipe, então TODO
    // caminho daqui que apaga ou reatribui um card tem que devolver o que a
    // loja já tinha separado.
    private readonly pickScans: PickScanService,
  ) {}

  /**
   * Calcula o roteamento SEM persistir (preview para aprovação manual).
   * Retorna também info de contato das lojas para montar mensagens WhatsApp.
   */
  async previewRoute(
    orderId: string,
    opts?: {
      excludeStoreCodes?: string[];
      preferStoreCode?: string | null;
      /** Troca manual do preview: lojas fixadas entram primeiro no split. */
      pinStoreCodes?: string[];
      // SWAP cirúrgico: roteia SÓ estes itens (os órfãos da loja trocada), não o
      // pedido inteiro. Sem isso, re-rotear "só São José" re-roteava as 5 peças
      // (Limeira inclusa) porque o engine recebia order.items completo.
      onlyItems?: Array<{ sku: string; quantity: number }>;
    },
  ) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: true,
        pickOrders: { select: { id: true } }, // pra excluir do `committed` ao recalcular
      },
    });
    // 🚨 A LOJA-CANAL NUNCA ENTRA NO RATEIO.
    //
    // A regra já existia em `common/loja-canal.ts` (ordem do dono, 24/08) e já
    // valia em outras DUAS queries deste mesmo arquivo — faltava justamente
    // aqui, que é a lista de candidatos que o roteador usa pra decidir. Por
    // isso a loja 13 (SITE) continuava sendo escolhida: ela não tem arara nem
    // quem separe, e o card cai num lugar onde ninguém vai buscar.
    //
    // Medido em 24/08 antes do conserto: 5 pedidos com SITE atribuído em 30
    // dias — 3 saíram na mão (ON-000046/49/50, 19/08) e 2 ficaram TRAVADOS em
    // `separating`: ON-000107 (hoje) e 198090, parado desde 10/08.
    //
    // Seguro de excluir: a loja 13 tem 53 SKUs / 58 peças (a menor da rede;
    // Itanhaém tem 89.483) e só 5 SKUs existem exclusivamente lá.
    const excludeCodes = Array.from(
      new Set([...(opts?.excludeStoreCodes ?? []).filter(Boolean), ...LOJA_CANAL_CODES]),
    );
    const stores = await this.prisma.store.findMany({
      where: {
        active: true,
        code: { notIn: excludeCodes },
      },
    });
    // Escopo dos itens a rotear: subconjunto (swap) ou pedido inteiro (padrão).
    // FRETE/MANUAL nunca são roteados: não existem no estoque de loja nenhuma
    // e viravam "ruptura" (caso ON-000001, 14/08). Filtra aqui pra valer pros
    // pedidos que JÁ nasceram com a linha de frete dentro.
    const routeItems = (
      opts?.onlyItems && opts.onlyItems.length > 0
        ? opts.onlyItems.map((i) => ({ sku: i.sku, quantity: Math.max(1, Number(i.quantity) || 1) }))
        : order.items.map((i) => ({ sku: i.sku, quantity: i.quantity }))
    ).filter((i) => !ehItemSemEstoque(i));
    const skus = routeItems.map((i) => i.sku);
    const storeCodes = stores.map((s) => s.code);
    const stock = await this.stock.getStockFor(skus, storeCodes);

    // Estoque comprometido em pick-orders ativos de OUTROS pedidos (exclui o próprio,
    // pra não descontar a si mesmo se já tinha sido roteado antes — caso de recalcular).
    const ownPickOrderIds = order.pickOrders.map((p) => p.id);
    const committed = await this.getCommittedStock(skus, storeCodes, ownPickOrderIds);
    const liquidStock = this.subtractCommitted(stock, committed);

    const result = this.engine.route({
      items: routeItems,
      stores: stores.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        cep: s.cep,
        priorityScore: s.priorityScore,
        active: s.active,
      })),
      stock: liquidStock,
      shippingCep: order.shippingCep,
      pickupStoreCode: order.pickupStoreCode, // ativa lógica de retirada em loja se preenchido
      preferStoreCode: opts?.preferStoreCode ?? null, // override manual via radio button
      pinStoreCodes: opts?.pinStoreCodes ?? [], // troca manual do preview
      // A loja que VENDEU entra primeiro no split com o que já tem em estoque
      // (17/08). Sem isto o greedy a deixava de fora mesmo com metade das
      // peças na arara — pacote e frete a mais, e o acerto ÷2,5 daquelas peças
      // indo pra outra loja. No pedido do site é o canal 13 (sem estoque), ou
      // seja, no-op.
      sellerStoreCode: (order as any).sellerStoreCode ?? null,
      juntadaGroup: await this.grupoJuntada(!!order.pickupStoreCode),
    });

    // enriquece assignments com dados da loja (whatsapp, contato)
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const assignmentsEnriched = result.assignments.map((a) => {
      const s = storeById.get(a.storeId);
      return {
        ...a,
        whatsapp: s?.whatsapp ?? null,
        contactName: s?.contactName ?? null,
        city: s?.city ?? null,
        state: s?.state ?? null,
      };
    });

    return {
      ...result,
      assignments: assignmentsEnriched,
      order: {
        id: order.id,
        wcOrderNumber: order.wcOrderNumber,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerCpf: order.customerCpf,
        customerEmail: order.customerEmail,
        shippingAddress: order.shippingAddress,
        shippingCep: order.shippingCep,
        totalAmount: order.totalAmount,
        isPickup: order.isPickup,
        pickupStoreCode: order.pickupStoreCode,
        shippingMethod: order.shippingMethod,
      },
    };
  }

  /**
   * Confirma o resultado de um routing já calculado e persiste no banco.
   * Recebe o result pra garantir que o que o usuário viu é o que foi gravado.
   */
  async confirmRoute(orderId: string, result: RoutingResult) {
    /**
     * TRAVA DE CONFERÊNCIA (20/08, decisão do dono — caso ON-000049 e os 24
     * pedidos sem prova): venda online do PDV fechada por "PIX recebido"/
     * "Link externo" NÃO vira card de separação enquanto ninguém provar o
     * dinheiro — ou o gateway registra PAGO, ou a matriz carimba a
     * conferência na tela Conferência de Vendas (hub SITE). Peça só viaja
     * com dinheiro provado. `CONFERENCIA_TRAVA=0` desliga.
     *
     * Vale pra TODOS os gatilhos (auto-atende do finalize, loja escolhida,
     * 1-CLIQUE da matriz) porque todos passam por aqui. O motoboy que fecha
     * na própria loja vendedora não passa (a peça já saiu fisicamente) — a
     * tela de conferência continua mostrando ele em vermelho.
     */
    const orderGate = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { source: true, status: true, vendaConferidaEm: true, checkoutInfo: true, wcOrderNumber: true } as any,
    });

    /**
     * TRAVA DE PEDIDO CONCLUÍDO (25/08, caso dos 22 relançados de 24/08):
     * pedido `shipped`/`delivered`/`cancelled` NÃO gera separação. As meninas
     * relançaram como venda online 22 pedidos já enviados — registro legítimo
     * — e o 1-CLIQUE/Gerar separação na aba Concluídos transformou registro
     * velho em trabalho novo: Itanhaém e São José separaram e biparam pedido
     * fantasma (66 peças baixadas em dobro, peça bipada saindo do estoque de
     * novo). Vale pra TODOS os gatilhos pelo mesmo motivo da trava acima:
     * todos passam por aqui.
     */
    const statusFinal = String((orderGate as any)?.status || '');
    if (['shipped', 'delivered', 'cancelled'].includes(statusFinal)) {
      throw new BadRequestException(
        `Pedido ${(orderGate as any)?.wcOrderNumber || orderId} já está ${statusFinal === 'cancelled' ? 'CANCELADO' : 'CONCLUÍDO/DESPACHADO'} — ` +
          `não gera separação. Se a peça ainda precisa sair de uma loja, reabra o pedido primeiro (mudando o status) pra ficar registrado de propósito.`,
      );
    }
    if (orderGate && !(await pedidoOnlineLiberado(this.prisma, orderGate as any))) {
      throw new BadRequestException(
        `Pedido ${(orderGate as any).wcOrderNumber || orderId} está AGUARDANDO CONFERÊNCIA DE PAGAMENTO — ` +
          `a venda fechou sem prova no gateway (PIX recebido/Link externo). ` +
          `Confira o dinheiro no extrato e carimbe em SITE → Conferência de Vendas; aí a separação libera.`,
      );
    }

    /**
     * TROCA DE PEÇA COM DIFERENÇA A COBRAR (21/08): a matriz trocou por uma
     * peça mais cara e o link foi pra cliente. Mesma régua da conferência —
     * peça só viaja com dinheiro provado. Libera sozinho quando o gateway
     * registra o pagamento; cortesia destrava na tela do pedido.
     */
    const trocaPendente = await diferencaDeTrocaPendente(this.prisma as any, orderId);
    if (trocaPendente.travado) {
      throw new BadRequestException(trocaPendente.motivo);
    }

    if (!result.success) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.awaiting_stock, routingResult: JSON.stringify(result) },
      });
      return { persisted: false };
    }

    // ── IDEMPOTÊNCIA (caso real 21/07: pedido #197435 DUPLICADO na loja) ──
    // confirmRoute é chamado de vários gatilhos (webhook WC — que REENTREGA —,
    // varredura do pilot, confirmação manual). Se o pedido JÁ tem pick-order
    // ATIVO (new/separating), um segundo confirm criaria cards duplicados na
    // loja. Recalcular NÃO passa por aqui com ativos: ele DELETA os ativos
    // antes de re-rotear — então pular aqui é sempre seguro.
    const ativosExistentes = await this.prisma.pickOrder.findMany({
      where: { orderId, status: { in: ['new', 'separating'] } },
      select: { id: true, storeId: true },
    });
    if (ativosExistentes.length > 0) {
      this.logger.warn(
        `[routing] confirmRoute IGNORADO pra order ${orderId}: já tem ${ativosExistentes.length} pick-order(s) ativo(s) — gatilho duplicado (webhook reentregue?)`,
      );
      return { persisted: false, alreadyRouted: true, existing: ativosExistentes };
    }

    const createdPickOrders: Array<{ id: string; storeId: string }> = [];

    // Snapshot do cliente pra loja fonte saber pra quem enviar (em caso de transferência)
    const orderForSnapshot = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        wcOrderId: true,
        wcOrderNumber: true,
        customerName: true,
        customerCpf: true,
        customerEmail: true,
        customerPhone: true,
        pickupStoreCode: true,
        shippingMethod: true,
      },
    });
    const customerSnapshotJson = JSON.stringify({
      name: orderForSnapshot.customerName,
      cpf: orderForSnapshot.customerCpf,
      email: orderForSnapshot.customerEmail,
      phone: orderForSnapshot.customerPhone,
      pickupStoreCode: orderForSnapshot.pickupStoreCode,
      shippingMethod: orderForSnapshot.shippingMethod,
      wcOrderId: orderForSnapshot.wcOrderId,
      wcOrderNumber: orderForSnapshot.wcOrderNumber,
    });

    await this.prisma.$transaction(async (tx) => {
      for (const a of result.assignments) {
        const po = await tx.pickOrder.create({
          data: {
            orderId,
            storeId: a.storeId,
            status: PickStatus.new,
            isTransfer: a.isTransfer ?? false,
            transferToStoreCode: a.transferToStoreCode ?? null,
            // Snapshot pra loja fonte atender cliente que vai retirar em outra loja
            customerSnapshot: a.isTransfer ? customerSnapshotJson : null,
          },
        });
        createdPickOrders.push({ id: po.id, storeId: a.storeId });
        for (const item of a.items) {
          await tx.orderItem.updateMany({
            where: { orderId, sku: item.sku },
            data: { assignedStoreId: a.storeId },
          });
        }
      }

      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.separating, routingResult: JSON.stringify(result) },
      });

      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: OrderStatus.pending,
          toStatus: OrderStatus.separating,
          note: `Aprovado e enviado para ${result.assignments.length} loja(s) via ${result.strategy}.`,
        },
      });
    });

    // Emite por socket pra cada loja — dispara notificação + impressão no app desktop
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          wcOrderId: true,
          wcOrderNumber: true,
          // Card verde ONLINE (14/08): o front pinta pelo source já no
          // socket, sem esperar o refetch de /pick-orders/mine.
          source: true,
          customerName: true,
          customerPhone: true,
          shippingCep: true,
          shippingAddress: true,
          totalAmount: true,
          wcDateCreated: true,
        },
      });

      for (const po of createdPickOrders) {
        const assignment = result.assignments.find((a) => a.storeId === po.storeId);
        const items = await this.prisma.orderItem.findMany({
          where: { orderId, assignedStoreId: po.storeId },
        });

        this.gateway.emitPickOrderToStore(po.storeId, {
          id: po.id,
          status: PickStatus.new,
          storeId: po.storeId,
          orderId,
          order: {
            ...order,
            items,
          },
          strategy: result.strategy,
          storeCode: assignment?.storeCode,
          storeName: assignment?.storeName,
          // ── pickup / transferência ──
          isTransfer: assignment?.isTransfer ?? false,
          transferToStoreCode: assignment?.transferToStoreCode ?? null,
          transferToStoreName: assignment?.transferToStoreName ?? null,
          pickupStoreCode: result.pickupStoreCode ?? null,
          pickupStoreName: result.pickupStoreName ?? null,
        });

        // ── PUSH NOTIFICATION ──
        // Dispara push pra TODAS vendedoras da loja (mesmo com app fechado).
        // Substitui o WhatsApp banido — notificação nativa Android/iOS.
        // Não bloqueia o fluxo se falhar.
        const totalItens = items.reduce(
          (s: number, it: any) => s + (Number(it.quantity) || 0),
          0,
        );
        // Defensivo: order pode ser null (strictNullChecks)
        const valorFmt = order?.totalAmount
          ? `R$ ${Number(order.totalAmount).toFixed(2).replace('.', ',')}`
          : '';
        const numeroPedido =
          order?.wcOrderNumber || order?.wcOrderId || po.id.slice(0, 8);
        const cliente = order?.customerName || 'Cliente';
        this.push
          .sendToStore(po.storeId, {
            title: `🛒 Pedido novo #${numeroPedido}`,
            body:
              `${cliente} · ${totalItens} ${totalItens === 1 ? 'peça' : 'peças'}` +
              (valorFmt ? ` · ${valorFmt}` : ''),
            tag: `pickorder-${po.id}`,
            icon: '/icon-192.png',
            requireInteraction: true,
            data: { url: '/minha-loja', pickOrderId: po.id, orderId },
          })
          .catch((e) =>
            this.logger.warn(`Falha ao enviar push do pedido novo: ${e?.message ?? e}`),
          );
      }
    } catch (err: any) {
      this.logger.warn(`Falha ao emitir socket de pick-order novo: ${err?.message ?? err}`);
    }

    return { persisted: true, assignments: result.assignments.length };
  }

  /**
   * Atalho: calcula e persiste em uma única operação (modo automático).
   */
  async routeOrder(orderId: string) {
    const preview = await this.previewRoute(orderId);
    await this.confirmRoute(orderId, preview as any);
    return preview;
  }

  /**
   * CONSERTO (17/08) — pedido de venda online que a LOJA VENDEDORA já entregou,
   * mas que foi roteado pra outra loja separar.
   *
   * Caso Suzano/ON-000004 (15/08): Suzano fechou a venda no caixa, escolheu
   * MOTOBOY e mandou a peça pra cliente em Mogi das Cruzes (~20 km) no mesmo
   * dia. O pedido passou o fim de semana na fila da matriz e na segunda foi
   * roteado pra SOROCABA, 150 km longe, que ia separar e enviar uma SEGUNDA
   * peça. E como a trava de baixa dupla delegou a baixa pra "quem separar", o
   * estoque de Suzano ficou fantasma: a peça saiu e o saldo não desceu.
   *
   * Este método desfaz o estrago em 1 chamada:
   *   1. apaga os cards ativos (new/separating) e tira eles do app das lojas;
   *   2. passa os itens pra loja vendedora (dona do acerto e da auditoria);
   *   3. baixa o estoque NELA — é de lá que a peça saiu;
   *   4. fecha o pedido como 'shipped' com a história registrada.
   *
   * IDEMPOTENTE: pedido já 'shipped' volta `alreadyDone` sem baixar de novo —
   * dois cliques no botão não podem baixar estoque duas vezes.
   *
   * RECUSA quando algum card já passou de "separando": se a outra loja bipou ou
   * postou, tem uma segunda peça em trânsito e isso não é conserto de sistema,
   * é decisão de gente (devolução/realinhamento).
   */
  async fecharNaLojaPedinte(orderId: string, userId?: string) {
    const order: any = await (this.prisma as any).order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: { select: { id: true, sku: true, quantity: true } },
        pickOrders: { select: { id: true, status: true, storeId: true } },
      },
    });

    if (order.source !== 'pdv_online') {
      return {
        ok: false as const,
        reason: 'nao-e-venda-online',
        message: 'Só vale pra pedido nascido de Venda Online do PDV (source pdv_online).',
      };
    }
    const sellerCode = String(order.sellerStoreCode || '').trim();
    if (!sellerCode) {
      return {
        ok: false as const,
        reason: 'sem-loja-vendedora',
        message: 'Pedido sem sellerStoreCode — não há como saber qual loja vendeu.',
      };
    }
    if (order.status === 'shipped' || order.status === 'delivered') {
      return { ok: true as const, alreadyDone: true, message: 'Pedido já estava fechado.' };
    }

    const seller = await (this.prisma as any).store.findFirst({
      where: { code: sellerCode },
      select: { id: true, code: true, name: true },
    });
    if (!seller) {
      return {
        ok: false as const,
        reason: 'loja-vendedora-nao-encontrada',
        message: `Loja vendedora ${sellerCode} não existe mais em Store.`,
      };
    }

    const avancados = order.pickOrders.filter(
      (p: any) => !['new', 'separating'].includes(p.status),
    );
    if (avancados.length > 0) {
      return {
        ok: false as const,
        reason: 'ja-separado',
        message:
          `Não dá pra fechar na ${seller.name}: ${avancados.length} card(s) já passaram de "separando" ` +
          `(${[...new Set(avancados.map((a: any) => a.status))].join(', ')}). ` +
          `Provavelmente uma SEGUNDA peça já saiu — resolva pelo fluxo de devolução/realinhamento.`,
      };
    }

    const cancelaveis = order.pickOrders
      .filter((p: any) => ['new', 'separating'].includes(p.status))
      .map((p: any) => p.id);
    const lojasNotificar = [...new Set(order.pickOrders.map((p: any) => p.storeId))] as string[];

    // Só peça baixa estoque — FRETE/MANUAL não existem no estoque.
    const pecas = order.items.filter((it: any) => !ehItemSemEstoque(it));

    /**
     * A VENDA JÁ PODE TER BAIXADO (caso ON-000140, 25/08): o fechamento
     * motoboy/auto-atende da própria vendedora baixa o estoque NA HORA e
     * marca `stockDecreasedAt` na pdv_sale. Depois, um roteamento indevido
     * arrastou o pedido de volta pra separação — e este botão, criado pro
     * caso OPOSTO (venda fechada SEM baixa, ON-000004), baixava a MESMA peça
     * de novo. Se a venda de origem já baixou na MESMA loja vendedora, o
     * passo 1 vira no-op: só cancela os cards e fecha.
     */
    let vendaJaBaixou = false;
    try {
      const ci = JSON.parse(String(order.checkoutInfo || '{}'));
      if (ci?.pdvSaleId) {
        const saleOrig: any = await (this.prisma as any).pdvSale.findUnique({
          where: { id: String(ci.pdvSaleId) },
          select: { stockDecreasedAt: true, storeCode: true },
        });
        vendaJaBaixou =
          !!saleOrig?.stockDecreasedAt &&
          String(saleOrig?.storeCode || '').trim() === seller.code;
      }
    } catch {
      /* checkoutInfo ilegível → segue o caminho antigo (baixa) */
    }

    // 1) BAIXA PRIMEIRO. Se falhar, nada muda de status e o pedido continua do
    //    jeito que estava — o inverso (marcar shipped e a baixa falhar) recria
    //    exatamente o estoque fantasma que este conserto existe pra matar.
    let baixa: any = null;
    if (!vendaJaBaixou) {
      baixa = await this.erp.decreaseStockAsync(
        pecas.map((it: any) => ({
          sku: String(it.sku),
          qty: Number(it.quantity || 1),
          storeCode: seller.code,
        })),
        { allowNegative: true, skipNotFound: true },
      );
      if (!baixa?.success) {
        return {
          ok: false as const,
          reason: 'baixa-falhou',
          message: `Baixa de estoque na ${seller.name} falhou: ${baixa?.error || 'sem detalhe'}. Nada foi alterado.`,
        };
      }
    } else {
      this.logger.log(
        `[fechar-na-vendedora] order ${orderId}: venda de origem JÁ baixou o estoque na ${seller.code} — baixa pulada, só cancela cards e fecha.`,
      );
    }

    // 1.5) Devolve o que as OUTRAS lojas já tinham bipado. A peça saiu do
    //      estoque da vendedora no passo 1; se um card indevido tinha bipes,
    //      a mesma peça está baixada duas vezes até este estorno rodar.
    const estornoBipes = await this.pickScans.revertOrderStock(orderId, {
      reason: 'reroute',
      userId: userId ?? null,
      pickOrderIds: cancelaveis,
    });

    // 2) Apaga cards, passa os itens pra vendedora e fecha o pedido.
    await this.prisma.$transaction(async (tx) => {
      if (cancelaveis.length > 0) {
        await tx.pickOrder.deleteMany({ where: { id: { in: cancelaveis } } });
      }
      await tx.orderItem.updateMany({
        where: { orderId },
        data: { assignedStoreId: seller.id },
      });
      await tx.order.update({
        where: { id: orderId },
        // `shippedAt`: a peça saiu pela vendedora agora. Ver
        // `common/janela-rastreio.ts` — `updatedAt` não serve de carimbo.
        data: { status: OrderStatus.shipped, shippedAt: new Date(), routingResult: null },
      });
      await tx.orderHistory.create({
        data: {
          orderId,
          userId: userId ?? null,
          fromStatus: order.status,
          toStatus: OrderStatus.shipped,
          note:
            `Conserto: a ${seller.name} vendeu E entregou esta venda online. ` +
            (vendaJaBaixou
              ? `estoque já tinha saído no fechamento da venda (baixa NÃO repetida)` +
                ''
              : `${pecas.length} peça(s) baixada(s) do estoque dela`) +
            (cancelaveis.length > 0
              ? `; ${cancelaveis.length} card(s) de separação indevido(s) cancelado(s)`
              : '') +
            (estornoBipes.pecas
              ? `; ${estornoBipes.pecas} peça(s) já bipada(s) devolvida(s) ao estoque da(s) loja(s) de origem.`
              : '.'),
        },
      });
    });

    // 3) Tira o card do app das lojas que estavam com ele.
    for (const storeId of lojasNotificar) {
      try {
        this.gateway.emitPickOrderRemoved?.(storeId, { orderId });
      } catch (err: any) {
        this.logger.warn(`Falha ao emitir remoção de pick-order: ${err?.message ?? err}`);
      }
    }

    this.logger.log(
      `[conserto-venda-online] ${order.wcOrderNumber} fechado na ${seller.name} — ` +
        `${pecas.length} peça(s) baixada(s), ${cancelaveis.length} card(s) cancelado(s)`,
    );

    return {
      ok: true as const,
      alreadyDone: false,
      storeCode: seller.code,
      storeName: seller.name,
      pecasBaixadas: pecas.length,
      cardsCancelados: cancelaveis.length,
      pecasEstornadas: estornoBipes.pecas,
      pecasBaixadasAgora: vendaJaBaixou ? 0 : pecas.length,
      gigaEnfileirado: !!baixa?.gigaEnfileirado,
    };
  }

  /**
   * RECALCULA a separação de um pedido já roteado.
   *
   * Por que existe: o `confirmSeparation` é idempotente (se já tem pick-order, retorna ele).
   * Quando a matriz quer reatribuir loja (ex: estoque sumiu, peça quebrada, loja offline),
   * precisamos:
   *   1. Cancelar pick-orders ATIVOS (status new/separating) — não mexe em separated/ready/shipped
   *   2. Limpar assignedStoreId dos items
   *   3. Rerodar routing (já considera estoque virtual de OUTROS pedidos)
   *   4. Criar novos pick-orders + emitir socket pras lojas
   *
   * Se o pick-order já estiver em `separated`/`ready`/`shipped` (loja já bipou ou
   * postou), bloqueia recalcular — não dá pra reatribuir uma peça que já saiu.
   *
   * Retorna { ok, cancelledCount, ... } ou { ok: false, reason }.
   */
  async recalculateForWc(
    orderId: string,
    opts?: { excludeStoreIds?: string[]; excludeStoreCodes?: string[]; forceStoreCode?: string },
  ) {
    // Se o caller passou codes (ex: ["MOEMA"]), converte pra IDs antes de seguir.
    // Mantemos o parâmetro original excludeStoreIds pra compat com chamadas internas.
    let extraExcludeIds: string[] = [];
    if (opts?.excludeStoreCodes && opts.excludeStoreCodes.length > 0) {
      const stores = await this.prisma.store.findMany({
        where: { code: { in: opts.excludeStoreCodes } },
        select: { id: true },
      });
      extraExcludeIds = stores.map((s) => s.id);
    }
    const mergedExcludeIds = Array.from(
      new Set([...(opts?.excludeStoreIds ?? []), ...extraExcludeIds]),
    );
    opts = { ...(opts ?? {}), excludeStoreIds: mergedExcludeIds };
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        pickOrders: {
          select: {
            id: true,
            status: true,
            storeId: true,
            issueReason: true,
          } as any,
        },
      },
    });

    // Bloqueio: tem pick-order que já passou de "ativo"
    //
    // EXCEÇÃO: se veio forceStoreCode (escolha manual livre da retaguarda),
    // NÃO bloqueia — vamos mexer só nos pick-orders new/separating, deixando
    // os avançados (shipped/delivered/etc) intactos. Caso típico: pedido com
    // 4 lojas, 1 já enviou (MOEMA), 3 reportaram sem estoque — retaguarda
    // quer consolidar essas 3 numa loja só sem afetar quem já enviou.
    const advanced = order.pickOrders.filter(
      (p) => !['new', 'separating'].includes(p.status),
    );
    if (advanced.length > 0 && !opts?.forceStoreCode) {
      return {
        ok: false as const,
        reason: 'advanced-status',
        message:
          `Não dá pra recalcular: ${advanced.length} pick-order(s) já passaram de "separando" ` +
          `(status: ${[...new Set(advanced.map((a) => a.status))].join(', ')}). ` +
          `Cancele/rejeite manualmente antes de reatribuir. ` +
          `(Pra forçar uma loja específica nos pick-orders ainda em "new/separating", use Escolher loja manualmente.)`,
      };
    }

    // AUTO-EXCLUSÃO: lojas que reportaram problema NESTE pedido são excluídas
    // do recalc (pra não mandar de volta pra mesma loja que disse "sem estoque").
    // Combina com excludeStoreIds opcional vindo do admin (reforço manual).
    const issueReporterStoreIds = order.pickOrders
      .filter((p) => (p as any).issueReason)
      .map((p) => p.storeId);
    const allExcludedStoreIds = Array.from(
      new Set([...(opts?.excludeStoreIds ?? []), ...issueReporterStoreIds]),
    );
    const excludedStores = allExcludedStoreIds.length
      ? await this.prisma.store.findMany({
          where: { id: { in: allExcludedStoreIds } },
          select: { id: true, code: true },
        })
      : [];
    const excludeStoreCodes = excludedStores.map((s) => s.code).filter(Boolean);

    const cancellableIds = order.pickOrders
      .filter((p) => ['new', 'separating'].includes(p.status))
      .map((p) => p.id);
    const advancedStoreIds = advanced.map((p) => p.storeId);

    // Notifica lojas afetadas pra retirar o card do app /minha-loja
    // (só as canceladas — as avançadas continuam com o card delas)
    const cancelledStoreIds = [...new Set(
      order.pickOrders
        .filter((p) => ['new', 'separating'].includes(p.status))
        .map((p) => p.storeId),
    )];

    // 0) DEVOLVE o que essas lojas já tinham bipado. Tem que ser ANTES: o
    //    `assignedStoreId` dos itens é zerado logo abaixo e a peça vai pra
    //    outra loja — sem estorno, a peça fica baixada na loja antiga E na
    //    nova, e some do estoque da rede.
    const estornoBipes = await this.pickScans.revertOrderStock(orderId, {
      reason: 'reroute',
      pickOrderIds: cancellableIds,
    });

    // 1) Cancela pick-orders cancelaveis + limpa assignedStoreId APENAS dos
    //    items que estavam neles. Items dos pick-orders avançados (já enviados)
    //    ficam intocados. Order volta pra fila de roteamento pra reatribuir.
    //
    //    ⚠️ O status aqui é `awaiting_stock`, NÃO `pending` (24/08).
    //
    //    `pending` no enum significa AGUARDANDO PAGAMENTO, e quem lê o pedido
    //    lê assim: a tela do pedido traduz pra "Pagamento pendente" e troca o
    //    bloco de Separação inteiro por "SEPARAÇÃO BLOQUEADA — PAGAMENTO NÃO
    //    CONFIRMADO" — escondendo justamente o "escolher loja manualmente",
    //    que era a saída. Beco sem saída num pedido PAGO (LP-000161: PIX de
    //    R$ 95,89 confirmado em 23/08, peça trocada em 24/08, recálculo sem
    //    loja com estoque → pending → matriz sem botão nenhum).
    //
    //    Pior: `pending` não está em `STATUS_QUE_RESERVAM` (carrinho-guard),
    //    então o pedido pago PARAVA DE SEGURAR a peça — o site podia vender a
    //    mesma peça pra outra cliente enquanto essa esperava.
    //
    //    `awaiting_stock` é o que o próprio `confirmRoute` já grava quando dá
    //    ruptura (linha ~188) — mesmo caso, mesmo estado: pago, sem card,
    //    esperando estoque. Ele reserva, aparece na aba Processando e não
    //    mente sobre dinheiro.
    await this.prisma.$transaction(async (tx) => {
      if (cancellableIds.length > 0) {
        await tx.pickOrder.deleteMany({ where: { id: { in: cancellableIds } } });
      }
      // Limpa assignedStoreId só dos items NÃO atribuídos a lojas avançadas
      // (que precisam preservar o vínculo).
      if (advancedStoreIds.length > 0) {
        await tx.orderItem.updateMany({
          where: {
            orderId,
            OR: [
              { assignedStoreId: null },
              { assignedStoreId: { notIn: advancedStoreIds } },
            ],
          },
          data: { assignedStoreId: null },
        });
      } else {
        await tx.orderItem.updateMany({
          where: { orderId },
          data: { assignedStoreId: null },
        });
      }
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.awaiting_stock, routingResult: null },
      });
      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: OrderStatus.awaiting_stock,
          note: `Recalcular separação: ${cancellableIds.length} pick-order(s) cancelado(s) pra reatribuir` +
                (advanced.length > 0 ? ` (${advanced.length} já avançado(s) preservado(s))` : '') +
                (estornoBipes.pecas ? ` · ${estornoBipes.pecas} peça(s) já bipada(s) devolvida(s) ao estoque` : '') + '.',
        },
      });
    });

    // 2) Emite socket pras lojas antigas pra remover o card
    for (const storeId of cancelledStoreIds) {
      try {
        this.gateway.emitPickOrderRemoved?.(storeId, { orderId });
      } catch (err: any) {
        this.logger.warn(`Falha ao emitir remoção de pick-order: ${err?.message ?? err}`);
      }
    }

    // 3a) FORÇA loja específica (escolha manual livre, mesmo SEM estoque).
    // Bypassa o routing — cria 1 pick-order pra loja escolhida.
    //
    // Items que vão pra loja forçada: APENAS os ÓRFÃOS (assignedStoreId = null).
    // Items dos pick-orders avançados (ex: MOEMA já enviou) ficam preservados.
    if (opts?.forceStoreCode) {
      const forcedStore = await this.prisma.store.findFirst({
        where: { code: opts.forceStoreCode },
        select: { id: true, code: true, name: true },
      });
      if (!forcedStore) {
        return {
          ok: false as const,
          reason: 'force-store-not-found',
          message: `Loja ${opts.forceStoreCode} não encontrada/ativa.`,
        };
      }
      // Pega apenas items SEM atribuição (órfãos pós-cancelamento dos new/separating).
      // Items das lojas avançadas continuam com assignedStoreId preservado.
      const orphanItems = (
        await this.prisma.orderItem.findMany({
          where: { orderId, assignedStoreId: null },
          select: { sku: true, quantity: true },
        })
      ).filter((it) => !ehItemSemEstoque(it)); // FRETE/MANUAL não se separa
      if (orphanItems.length === 0) {
        return {
          ok: false as const,
          reason: 'no-orphan-items',
          message: 'Não há items disponíveis pra reatribuir — todos já estão em pick-orders avançados.',
        };
      }
      const fakeResult: any = {
        success: true,
        strategy: 'force-manual',
        assignments: [
          {
            storeId: forcedStore.id,
            isTransfer: false,
            items: orphanItems.map((it) => ({ sku: it.sku, qty: it.quantity })),
          },
        ],
      };
      await this.confirmRoute(orderId, fakeResult);
      const newPickOrders = await this.prisma.pickOrder.findMany({
        where: { orderId },
        include: { store: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return {
        ok: true as const,
        cancelledCount: cancellableIds.length,
        strategy: 'force-manual',
        forcedStoreCode: forcedStore.code,
        excludedStoreCodes: [],
        pickOrders: newPickOrders.map((p) => ({
          id: p.id,
          status: p.status,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    }

    // 3b) Roda routing fresco (já considera commited de OUTROS pedidos) + exclui
    // lojas que reportaram problema nesse pedido
    const preview = await this.previewRoute(orderId, { excludeStoreCodes });

    if (!preview.success) {
      return {
        ok: false as const,
        reason: excludeStoreCodes.length ? 'sem-estoque-excluindo-loja' : 'sem-estoque',
        message: excludeStoreCodes.length
          ? `Recalculei excluindo ${excludeStoreCodes.join(', ')} (que reportaram problema) ` +
            `e nenhuma OUTRA loja tem estoque suficiente. Pedido ficou aguardando estoque — ` +
            `verifique estoque ou divida manualmente.`
          : 'Recalculei e nenhuma loja tem estoque suficiente agora. ' +
            'O pedido ficou aguardando estoque — verifique estoque ou divida manualmente.',
        missing: preview.missing,
        cancelledCount: cancellableIds.length,
        excludedStoreCodes: excludeStoreCodes,
      };
    }

    // 4) Confirma → cria novos pick-orders + emite socket pras lojas novas
    await this.confirmRoute(orderId, preview as any);

    const newPickOrders = await this.prisma.pickOrder.findMany({
      where: { orderId },
      include: { store: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true as const,
      cancelledCount: cancellableIds.length,
      strategy: preview.strategy,
      excludedStoreCodes: excludeStoreCodes,
      pickOrders: newPickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })),
    };
  }

  /**
   * SWAP CIRÚRGICO de UM pick-order específico.
   *
   * Caso de uso: pedido tem split em N lojas, uma delas (ex: Sorocaba) já enviou,
   * outra (ex: Vinhedo) reportou problema e precisa trocar. Um recalc total
   * cancelaria tudo (incluindo Sorocaba que já está shipped). Esse método
   * cancela APENAS o pick-order específico e re-roteia SOMENTE os items que
   * estavam atribuídos pra ele.
   *
   * Pré-condições:
   *  - O pick-order alvo está em new/separating (não pode trocar quem já bipou/enviou)
   *  - Os outros pick-orders do mesmo Order ficam INTOCADOS
   *
   * Steps:
   *  1. Carrega o pick-order alvo + valida status
   *  2. Identifica items atribuídos pra essa loja
   *  3. Cancela o pick-order alvo (delete) + desatribui items (assignedStoreId=null)
   *  4. Roda routing SÓ pros items órfãos, excluindo loja alvo + lojas que reportaram problema
   *  5. Cria novo(s) pick-order(s) pros items órfãos
   *  6. Mantém os outros pick-orders intactos
   *
   * Retorna { ok, newPickOrders, oldStoreCode } ou { ok: false, reason }.
   */
  async swapSinglePickOrder(
    pickOrderId: string,
    opts?: { excludeStoreCodes?: string[]; forceAdvanced?: boolean; forceStoreCode?: string },
  ) {
    const pickOrder = await this.prisma.pickOrder.findUnique({
      where: { id: pickOrderId },
      include: {
        store: { select: { id: true, code: true, name: true } },
        order: { select: { id: true } },
      },
    });
    if (!pickOrder) {
      return {
        ok: false as const,
        reason: 'pick-order-not-found',
        message: 'Pick-order não encontrado.',
      };
    }

    // Status que requerem ação ESPECIAL antes de trocar:
    //   - separated  → loja bipou mas não enviou. Sem efeito no Giga (baixa
    //                  só rola no shipped). Só apaga pick-order.
    //   - ready      → idem
    //   - shipped    → loja já postou e Giga JÁ FOI BAIXADO. Precisa estornar
    //                  Giga (increaseStock) antes de trocar pra outra loja
    //                  fazer a baixa lá.
    //
    // Permite trocar a qualquer momento — o caller (frontend) já avisou o
    // operador das consequências antes de chamar.
    const ADVANCED_NEEDING_REVERSE = ['shipped', 'delivered'];
    const needsErpReverse = ADVANCED_NEEDING_REVERSE.includes(pickOrder.status);

    const orderId = pickOrder.order.id;
    const oldStoreCode = pickOrder.store.code;
    const oldStoreId = pickOrder.store.id;

    // Items atribuídos pra essa loja (pra re-rotear só eles)
    const itemsAssigned = await this.prisma.orderItem.findMany({
      where: { orderId, assignedStoreId: oldStoreId },
      select: { id: true, sku: true, quantity: true },
    });

    if (itemsAssigned.length === 0) {
      // Pick-order existe mas sem items vinculados — só apaga o pick-order.
      // ESTORNA MESMO ASSIM: item desatribuído não quer dizer peça não bipada
      // (o vínculo com a loja some no reroteamento, o bipe não). Sem isto o
      // card é apagado com as peças fora do estoque e a linha do bipe vira
      // órfã — ninguém mais tem como saber que a loja tinha peça pra devolver.
      const estornoOrfao = await this.pickScans.revertPickOrderStock(pickOrderId, {
        reason: 'store_swap',
      });
      await this.prisma.pickOrder.delete({ where: { id: pickOrderId } });
      try {
        this.gateway.emitPickOrderRemoved?.(oldStoreId, { orderId });
      } catch {}
      return {
        ok: false as const,
        reason: 'no-items',
        message:
          'Esta loja não tinha items atribuídos. Pick-order removido sem realocação.' +
          (estornoOrfao.pecas
            ? ` ${estornoOrfao.pecas} peça(s) já bipada(s) foram devolvidas ao estoque da ${oldStoreCode}.`
            : ''),
      };
    }

    // Lojas a excluir: alvo (sempre) + lojas que reportaram problema neste pedido
    // + opcionais do admin
    const otherPickOrdersOfOrder = await this.prisma.pickOrder.findMany({
      where: { orderId, id: { not: pickOrderId } },
      select: { storeId: true, status: true, issueReason: true } as any,
    });
    const issueReporterStoreIds = (otherPickOrdersOfOrder as any[])
      .filter((p) => p.issueReason)
      .map((p) => p.storeId);
    // Também exclui lojas que JÁ ESTÃO atendendo o mesmo pedido (não duplica peça)
    const otherActiveStoreIds = (otherPickOrdersOfOrder as any[])
      .filter((p) => ['new', 'separating', 'separated', 'ready', 'shipped'].includes(p.status))
      .map((p) => p.storeId);

    const allExcludedStoreIds = Array.from(
      new Set([oldStoreId, ...issueReporterStoreIds, ...otherActiveStoreIds]),
    );
    const excludedStores = await this.prisma.store.findMany({
      where: { id: { in: allExcludedStoreIds } },
      select: { id: true, code: true },
    });
    const excludeStoreCodes = Array.from(
      new Set([
        ...excludedStores.map((s) => s.code).filter(Boolean),
        ...(opts?.excludeStoreCodes ?? []),
      ]),
    );

    // 1.0) Se loja JÁ ENVIOU (shipped/delivered) → estorna Giga primeiro.
    // Senão a peça fica fantasma em duas lojas (a antiga continua sem ela
    // fisicamente mas Giga acha que foi vendida; a nova vai dar baixa de
    // novo no shipped).
    let erpReverseResult: any = null;
    if (needsErpReverse) {
      try {
        const stockItems = itemsAssigned.map((it: any) => ({
          sku: it.sku,
          qty: it.quantity || 1,
          storeCode: oldStoreCode,
        }));
        erpReverseResult = await this.erp.increaseStockAsync(stockItems);
        if (erpReverseResult.success) {
          this.logger.log(
            `[swap] estorno Giga OK pra loja ${oldStoreCode}: ${itemsAssigned.length} item(ns) voltaram pro estoque`,
          );
        } else {
          this.logger.warn(
            `[swap] estorno Giga FALHOU pra loja ${oldStoreCode}: ${erpReverseResult.error}. Continuando swap mesmo assim — operador deve corrigir manualmente.`,
          );
        }
      } catch (e: any) {
        this.logger.error(`[swap] estorno Giga exception: ${e?.message || e}`);
      }
    }

    // 1.1) Bipes da loja antiga. Quando o passo acima já devolveu o pedido
    //      INTEIRO (shipped/delivered), aqui só carimba as linhas —
    //      `jaEstornadoPeloCaller` existe pra isso: devolver de novo criaria
    //      peça que não existe. Nos demais status o estorno sai daqui, e é o
    //      único: o card vai ser apagado logo abaixo.
    const estornoBipes = await this.pickScans.revertPickOrderStock(pickOrderId, {
      reason: 'store_swap',
      jaEstornadoPeloCaller: needsErpReverse,
    });

    // 1) Cancela o pick-order alvo + desatribui SOMENTE os items dele
    await this.prisma.$transaction(async (tx) => {
      await tx.pickOrder.delete({ where: { id: pickOrderId } });
      await tx.orderItem.updateMany({
        where: { orderId, assignedStoreId: oldStoreId },
        data: { assignedStoreId: null },
      });
      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: pickOrder.status,
          toStatus: 'separating',
          note:
            `Swap cirúrgico: pick-order da loja ${oldStoreCode} cancelado (status era "${pickOrder.status}") pra reatribuir ` +
            `${itemsAssigned.length} item(ns). ` +
            (needsErpReverse
              ? `Estorno Giga: ${erpReverseResult?.success ? 'OK' : 'FALHOU (' + (erpReverseResult?.error || 'erro') + ')'}. `
              : '') +
            (estornoBipes.pecas ? `${estornoBipes.pecas} peça(s) bipada(s) devolvida(s) ao estoque da ${oldStoreCode}. ` : '') +
            `Outros pick-orders intactos.`,
        },
      });
    });

    // 2) Notifica loja antiga pra remover o card do app
    try {
      this.gateway.emitPickOrderRemoved?.(oldStoreId, { orderId });
    } catch (err: any) {
      this.logger.warn(`Falha ao emitir remoção de pick-order: ${err?.message ?? err}`);
    }

    // 3) Roteamento: se forceStoreCode foi passado (escolha manual livre da
    // retaguarda), bypassa o routing e cria pick-order direto pra essa loja
    // com os items órfãos. Senão, usa previewRoute normal.
    if (opts?.forceStoreCode) {
      const forcedStore = await this.prisma.store.findFirst({
        where: { code: opts.forceStoreCode },
        select: { id: true, code: true, name: true },
      });
      if (!forcedStore) {
        return {
          ok: false as const,
          reason: 'force-store-not-found',
          message: `Loja ${opts.forceStoreCode} não encontrada/ativa.`,
        };
      }
      const fakeResult: any = {
        success: true,
        strategy: 'swap-force-manual',
        assignments: [
          {
            storeId: forcedStore.id,
            isTransfer: false,
            items: itemsAssigned.map((it: any) => ({ sku: it.sku, qty: it.quantity })),
          },
        ],
      };
      await this.confirmRoute(orderId, fakeResult);
      const newPickOrders = await this.prisma.pickOrder.findMany({
        where: { orderId, storeId: forcedStore.id },
        include: { store: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      return {
        ok: true as const,
        oldStoreCode,
        forcedStoreCode: forcedStore.code,
        itemsReassigned: itemsAssigned.length,
        pickOrders: newPickOrders.map((p) => ({
          id: p.id,
          status: p.status,
          storeCode: p.store.code,
          storeName: p.store.name,
        })),
      };
    }

    // Senão: routing automático (busca loja com estoque, exclui as problemáticas).
    // CRÍTICO: roteia SÓ os itens órfãos (os da loja trocada) — não o pedido
    // inteiro. Sem o onlyItems, re-rotear "só São José" re-roteava as outras
    // lojas junto (bug: "roteia tudo").
    const preview = await this.previewRoute(orderId, {
      excludeStoreCodes,
      onlyItems: itemsAssigned.map((it: any) => ({ sku: it.sku, quantity: it.quantity })),
    });

    if (!preview.success) {
      return {
        ok: false as const,
        reason: 'sem-estoque-excluindo-loja',
        message:
          `Cancelei o pick-order da ${oldStoreCode} mas nenhuma OUTRA loja tem ` +
          `estoque pra ${itemsAssigned.length} item(ns). Items ficaram sem loja — ` +
          `verifique estoque ou divida manualmente.`,
        missing: preview.missing,
        oldStoreCode,
        excludedStoreCodes: excludeStoreCodes,
      };
    }

    // 4) Confirma criando APENAS pick-orders pra items que ainda não estão atribuídos
    // (preserva os pick-orders das outras lojas que já estavam OK)
    await this.confirmRoute(orderId, preview as any);

    const newPickOrders = await this.prisma.pickOrder.findMany({
      where: {
        orderId,
        storeId: { not: oldStoreId },
        // Pega só os pick-orders criados agora (created após início do método)
      },
      include: { store: { select: { code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true as const,
      oldStoreCode,
      excludedStoreCodes: excludeStoreCodes,
      itemsReassigned: itemsAssigned.length,
      pickOrders: newPickOrders.map((p) => ({
        id: p.id,
        status: p.status,
        storeCode: p.store.code,
        storeName: p.store.name,
      })),
    };
  }

  /**
   * MOVER PEÇA(S) DE UMA LOJA PRA OUTRA — por PEÇA, não pelo card inteiro.
   *
   * 🔴 LP-000244 (25–26/08): pedido de 4 peças, VINHEDO + LIMEIRA. Limeira não
   * tinha UMA das três dela (SMILE PRETA 48) e reportou problema — mas
   * `reportIssue` é POR CARD, então as outras duas, que ela tinha, caíram
   * junto. A retaguarda usou "↔ Trocar loja", que também é POR CARD
   * (`swapSinglePickOrder` move TODOS os `itemsAssigned`) — e as três peças
   * viajaram grudadas pra Jundiaí, depois Suzano, depois Moema. Cada loja
   * recusava por causa da MESMA peça e devolvia as outras duas junto: três
   * rodadas, 21 horas, nenhuma peça mais perto da cliente. E das lojas
   * escolhidas na mão, três tinham saldo ZERO da peça em questão.
   *
   * Aqui a unidade é a PEÇA: a loja que tem 2 das 3 fica com as 2.
   *
   * Garantias:
   *  - peça já BIPADA não se move (o estoque já saiu naquela loja) — pra essa
   *    o caminho continua sendo o card inteiro, que estorna;
   *  - NUNCA cria um 2º card pra mesma loja no mesmo pedido: o filtro de peça
   *    do card é por `assignedStoreId`, então dois cards mostrariam as peças
   *    um do outro (caso ON-000106, em que Campinas foi acusada de não ter
   *    enviado o que já tinha postado);
   *  - card de origem que fica sem peça nenhuma é apagado, com estorno de bipe
   *    órfão — mesma regra do swap;
   *  - a JUNTADA acompanha: o card novo nasce feeder da âncora vigente (ou
   *    âncora, se for ela), e o método AVISA se a âncora ficou sem card — era
   *    esse silêncio que deixou a caixa REM-2026-001480 viajando pra uma loja
   *    que tinha saído do pedido.
   */
  async moverItensParaLoja(
    orderId: string,
    orderItemIds: string[],
    toStoreCode: string,
    opts?: { userId?: string | null },
  ) {
    const ids = Array.from(
      new Set((orderItemIds || []).map((s) => String(s || '').trim()).filter(Boolean)),
    );
    if (!ids.length) throw new BadRequestException('Escolha ao menos uma peça pra mover.');

    const order: any = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, status: true, wcOrderId: true, wcOrderNumber: true, source: true,
        customerName: true, customerCpf: true, customerEmail: true, customerPhone: true,
        shippingMethod: true,
      },
    });
    if (!order) throw new BadRequestException('Pedido não encontrado.');
    if (['shipped', 'delivered', 'cancelled'].includes(String(order.status))) {
      throw new BadRequestException(
        `Pedido está "${order.status}" — não se remexe na separação de pedido que já saiu ou foi cancelado.`,
      );
    }

    const alvo = await this.prisma.store.findFirst({
      where: { code: String(toStoreCode || '').trim(), active: true },
      select: { id: true, code: true, name: true },
    });
    if (!alvo) throw new BadRequestException(`Loja ${toStoreCode} não encontrada ou inativa.`);

    const itens: any[] = await this.prisma.orderItem.findMany({
      where: { id: { in: ids }, orderId },
      select: {
        id: true, sku: true, quantity: true, ref: true, cor: true, tamanho: true,
        productName: true, assignedStoreId: true,
      },
    });
    if (itens.length !== ids.length) {
      throw new BadRequestException('Alguma das peças não é deste pedido — recarregue a tela.');
    }
    const mover = itens.filter((i) => i.assignedStoreId !== alvo.id);
    if (!mover.length) {
      return {
        ok: true as const, movidos: 0, jaEstavam: true,
        paraStoreCode: alvo.code, paraStoreName: alvo.name,
      };
    }

    const cards: any[] = await this.prisma.pickOrder.findMany({
      where: { orderId },
      include: { store: { select: { id: true, code: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const ATIVOS = ['new', 'separating', 'separated', 'ready'];
    const cardAtivoDa = (storeId: string) =>
      cards.find((c) => c.storeId === storeId && ATIVOS.includes(c.status));

    // Peça já BIPADA não viaja: a baixa de estoque já aconteceu naquela loja.
    const origemIds = Array.from(
      new Set(mover.map((i) => i.assignedStoreId).filter(Boolean)),
    ) as string[];
    for (const storeId of origemIds) {
      const card = cardAtivoDa(storeId);
      if (!card) continue;
      const skus = mover.filter((i) => i.assignedStoreId === storeId).map((i) => String(i.sku));
      const bipadas: any[] = await (this.prisma as any).pickOrderScan.findMany({
        where: { pickOrderId: card.id, sku: { in: skus }, revertedAt: null },
        select: { sku: true },
      });
      if (bipadas.length) {
        throw new BadRequestException(
          `${card.store.code} já BIPOU ${[...new Set(bipadas.map((b) => b.sku))].join(', ')} — ` +
            `a peça já saiu do estoque de lá. Peça pra loja desfazer o bipe, ou troque o card ` +
            `inteiro em "↔ Trocar loja" (esse caminho estorna).`,
        );
      }
    }

    // Destino: NUNCA um segundo card pra mesma loja no mesmo pedido.
    const cardAlvo = cardAtivoDa(alvo.id);
    const cardAlvoFechado = cards.find(
      (c) => c.storeId === alvo.id && ['shipped', 'delivered'].includes(c.status),
    );
    if (!cardAlvo && cardAlvoFechado) {
      throw new BadRequestException(
        `${alvo.code} já postou a parte dela deste pedido (card ${cardAlvoFechado.status}). ` +
          `Peça nova pra lá criaria um segundo card, que mostraria também o que ela já enviou.`,
      );
    }

    // JUNTADA vigente — quem é a âncora hoje.
    const feeders = cards.filter(
      (c) => ATIVOS.includes(c.status) && c.isTransfer && c.transferToStoreCode,
    );
    const ancoraCode: string | null = feeders.length ? String(feeders[0].transferToStoreCode) : null;
    const snapshotJuntada = ancoraCode
      ? JSON.stringify({
          name: order.customerName,
          cpf: order.customerCpf,
          email: order.customerEmail,
          phone: order.customerPhone,
          shippingMethod: order.shippingMethod,
          wcOrderId: order.wcOrderId,
          wcOrderNumber: order.wcOrderNumber,
          juntadaAncoraStoreCode: ancoraCode,
        })
      : null;

    let cardCriado: any = null;
    let statusAlvo: string = cardAlvo?.status ?? PickStatus.new;

    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.updateMany({
        where: { id: { in: mover.map((i) => i.id) } },
        data: { assignedStoreId: alvo.id },
      });

      if (cardAlvo) {
        // Card que já tinha terminado volta pra fila — chegou peça nova nele.
        if (['separated', 'ready'].includes(cardAlvo.status)) {
          await tx.pickOrder.update({
            where: { id: cardAlvo.id },
            data: { status: PickStatus.separating },
          });
          statusAlvo = PickStatus.separating;
        }
      } else {
        const ehAncora = !!ancoraCode && alvo.code === ancoraCode;
        cardCriado = await tx.pickOrder.create({
          data: {
            orderId,
            storeId: alvo.id,
            status: PickStatus.new,
            isTransfer: !!ancoraCode && !ehAncora,
            transferToStoreCode: ancoraCode && !ehAncora ? ancoraCode : null,
            customerSnapshot: ancoraCode && !ehAncora ? snapshotJuntada : null,
          },
        });
      }
    });

    // Card de origem que ficou sem peça nenhuma sai da fila da loja.
    const cardsRemovidos: string[] = [];
    for (const storeId of origemIds) {
      const card = cardAtivoDa(storeId);
      if (!card) continue;
      const resto = await this.prisma.orderItem.count({
        where: { orderId, assignedStoreId: storeId },
      });
      if (resto > 0) continue;
      // Bipe órfão (peça bipada e depois desatribuída) volta pro estoque da loja.
      await this.pickScans
        .revertPickOrderStock(card.id, { reason: 'store_swap', userId: opts?.userId ?? null })
        .catch(() => null);
      await this.prisma.pickOrder.delete({ where: { id: card.id } });
      cardsRemovidos.push(card.store.code);
      try {
        this.gateway.emitPickOrderRemoved?.(storeId, { orderId, pickOrderId: card.id });
      } catch { /* best-effort */ }
    }

    const nomeDaPeca = (i: any) =>
      [i.ref || i.sku, [i.cor, i.tamanho].filter(Boolean).join(' ')].filter(Boolean).join(' ');
    const deLojas = Array.from(
      new Set(
        origemIds.map((sid) => cards.find((c) => c.storeId === sid)?.store?.code).filter(Boolean),
      ),
    ) as string[];

    await this.prisma.orderHistory.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: order.status,
        note:
          `Peça movida na mão: ${mover.map(nomeDaPeca).join(', ')}` +
          (deLojas.length ? ` de ${deLojas.join('/')}` : '') +
          ` pra ${alvo.code} (${alvo.name}). ` +
          `${mover.length} peça(s) — o resto do card ficou onde estava.` +
          (cardsRemovidos.length
            ? ` Card da ${cardsRemovidos.join('/')} ficou sem peça e foi removido.`
            : ''),
      },
    });

    // Loja de destino vê a peça na hora (o app da loja não recarrega sozinho).
    try {
      const itensDoAlvo = await this.prisma.orderItem.findMany({
        where: { orderId, assignedStoreId: alvo.id },
      });
      if (cardCriado) {
        const ordemSocket = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: {
            id: true, wcOrderId: true, wcOrderNumber: true, source: true, customerName: true,
            customerPhone: true, shippingCep: true, shippingAddress: true, totalAmount: true,
            wcDateCreated: true,
          },
        });
        this.gateway.emitPickOrderToStore(alvo.id, {
          id: cardCriado.id,
          status: PickStatus.new,
          storeId: alvo.id,
          orderId,
          order: { ...ordemSocket, items: itensDoAlvo },
          strategy: 'item-move-manual',
          storeCode: alvo.code,
          storeName: alvo.name,
          isTransfer: !!cardCriado.isTransfer,
          transferToStoreCode: cardCriado.transferToStoreCode ?? null,
        });
      } else if (cardAlvo) {
        this.gateway.emitPickOrderStatus(alvo.id, { id: cardAlvo.id, status: statusAlvo });
      }
    } catch (e: any) {
      this.logger.warn(`[mover-item] socket pra ${alvo.code} falhou: ${e?.message || e}`);
    }

    // A JUNTADA ficou coerente? Âncora sem card = caixa viajando pra ninguém.
    const depois: any[] = await this.prisma.pickOrder.findMany({
      where: { orderId, status: { in: ATIVOS } },
      include: { store: { select: { code: true } } },
    });
    let avisoJuntada: string | null = null;
    const feedersDepois = depois.filter((c) => c.isTransfer && c.transferToStoreCode);
    if (feedersDepois.length) {
      const anc = String(feedersDepois[0].transferToStoreCode);
      const temAncora = depois.some((c) => !c.isTransfer && c.store?.code === anc);
      if (!temAncora) {
        avisoJuntada =
          `A juntada aponta pra loja ${anc}, que NÃO tem card neste pedido — as caixas dos ` +
          `feeders viajam pra quem não separa nada. Escolha a âncora de novo ou mande uma peça pra ${anc}.`;
        this.logger.warn(`[mover-item] ${order.wcOrderNumber}: ${avisoJuntada}`);
      }
    }

    this.logger.log(
      `[mover-item] ${order.wcOrderNumber}: ${mover.length} peça(s) ` +
        `${deLojas.join('/') || '(sem loja)'} → ${alvo.code}` +
        (cardsRemovidos.length ? ` · card ${cardsRemovidos.join('/')} removido` : ''),
    );

    return {
      ok: true as const,
      movidos: mover.length,
      pecas: mover.map((i) => ({
        id: i.id, sku: i.sku, ref: i.ref, cor: i.cor, tamanho: i.tamanho,
      })),
      deStoreCodes: deLojas,
      paraStoreCode: alvo.code,
      paraStoreName: alvo.name,
      cardCriado: cardCriado
        ? {
            id: cardCriado.id,
            isTransfer: !!cardCriado.isTransfer,
            transferToStoreCode: cardCriado.transferToStoreCode ?? null,
          }
        : null,
      cardsRemovidos,
      avisoJuntada,
    };
  }

  /**
   * Grupo da JUNTADA automática = a rota própria do carro (Itanhaém/Praia
   * Grande/Santos, configurável em SystemSetting). Retirada não junta (a
   * REGRA 0 do pickup manda). Kill-switch: ROUTING_JUNTADA_TRIO=0.
   */
  private async grupoJuntada(isPickup: boolean): Promise<string[]> {
    if (isPickup) return [];
    if (String(process.env.ROUTING_JUNTADA_TRIO || '').trim() === '0') return [];
    try {
      return await lojasDaRotaPropria(this.prisma as any);
    } catch {
      return [];
    }
  }

  /**
   * ANTI-OVERBOOKING — LIGADO por padrão desde 22/08 (ordem do dono).
   *
   * "No roteamento deve se levar em conta as peças pedidas na loja, pois
   *  enquanto a peça não é baixada ela pode ser pedida várias vezes."
   *
   * Ficou desligado por muito tempo com a justificativa de "prometer a venda":
   * na prática quem pagava a promessa era a loja, que recebia dois cards pra
   * mesma peça e descobria no balcão. `ROUTING_ANTI_OVERBOOKING=0` (ou
   * `false`/`off`) volta o comportamento antigo — qualquer outro valor mantém
   * ligado, inclusive o `true` que já esteja setado em produção.
   */
  private get antiOverbookingEnabled(): boolean {
    const v = String(process.env.ROUTING_ANTI_OVERBOOKING ?? '').trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off';
  }

  /**
   * ESTOQUE COMPROMETIDO em pick-orders ATIVOS (status new/separating/separated).
   *
   * Pra cada (storeCode, sku), quanto a loja JÁ DEVE entregar e ainda não tirou
   * do estoque. É esse número que o roteamento desconta antes de escolher a
   * loja — peça prometida não pode ser prometida de novo.
   *
   * A conta é PENDENTE = esperado − já baixado no bipe (`computeCommittedStock`).
   * Reservar a quantidade cheia depois de 18/08 seria contar a mesma peça duas
   * vezes (o bipe JÁ baixou o que passou no leitor) e criaria ruptura falsa —
   * pedido parado na matriz com a peça na arara.
   *
   * Card em `ready`/`shipped` não entra: o estoque já caiu. Card com
   * `debitApprovedAt` também não, mesmo em `separated` — é o caso da live que
   * nasce bipada e da aprovação manual da matriz.
   *
   * `excludePickOrderIds` permite ignorar pick-orders do próprio pedido sendo
   * recalculado (pra não descontar a si mesmo do estoque disponível).
   *
   * RETORNO: Map com chave `${storeCode}::${sku}` → qty comprometida
   */
  async getCommittedStock(
    skus: string[],
    storeCodes: string[],
    excludePickOrderIds: string[] = [],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!skus.length || !storeCodes.length) return out;
    if (!this.antiOverbookingEnabled) {
      return out; // map vazio → subtractCommitted não tira nada → liquid = real
    }

    // Map storeId → storeCode (engine trabalha com storeCode mas FK é storeId)
    const stores = await this.prisma.store.findMany({
      where: { code: { in: storeCodes } },
      select: { id: true, code: true },
    });
    const codeByStoreId = new Map(stores.map((s) => [s.id, s.code]));
    const storeIds = stores.map((s) => s.id);
    if (storeIds.length === 0) return out;

    // Pick-orders ATIVOS (não enviados / não baixados)
    const activePickOrders = await this.prisma.pickOrder.findMany({
      where: {
        storeId: { in: storeIds },
        status: { in: ['new', 'separating', 'separated'] },
        ...(excludePickOrderIds.length > 0 ? { id: { notIn: excludePickOrderIds } } : {}),
      },
      select: { id: true, orderId: true, storeId: true, debitApprovedAt: true },
    });
    if (activePickOrders.length === 0) return out;

    const orderIds = [...new Set(activePickOrders.map((p) => p.orderId))];

    // Items desses pedidos, SÓ os atribuídos a uma das lojas em jogo.
    //
    // A atribuição é ESTRITA no `assignedStoreId` — o fallback "sem loja? usa a
    // do card" que existia aqui reservava justamente a peça que a loja tinha
    // acabado de reportar como "não achei": o report zera o `assignedStoreId` e
    // baixa a quantidade fantasma, então o chute segurava peça que já saiu do
    // estoque e que ninguém vai separar. É o mesmo critério do
    // `pendingDebitItems` do bipe e do `finishSeparation`.
    const items = await this.prisma.orderItem.findMany({
      where: {
        orderId: { in: orderIds },
        sku: { in: skus },
        assignedStoreId: { in: storeIds },
      },
      select: { orderId: true, sku: true, quantity: true, assignedStoreId: true },
    });
    const itemsByCard = new Map<string, Array<{ sku: string; quantity: number }>>();
    for (const it of items) {
      const key = `${it.orderId}::${it.assignedStoreId}`;
      const arr = itemsByCard.get(key);
      if (arr) arr.push({ sku: it.sku, quantity: it.quantity });
      else itemsByCard.set(key, [{ sku: it.sku, quantity: it.quantity }]);
    }

    // O que JÁ saiu do estoque no bipe destes cards (1 linha = 1 peça). Mesmo
    // filtro do `debitedBySku`: bipe estornado ou em shadow não baixou nada,
    // então continua contando como prometido.
    const scans = await this.prisma.pickOrderScan.findMany({
      where: {
        pickOrderId: { in: activePickOrders.map((p) => p.id) },
        sku: { in: skus },
        revertedAt: null,
        stockDecreasedAt: { not: null },
        stockIncreasedAt: null,
      },
      select: { pickOrderId: true, sku: true },
    });
    const debitedByCard = new Map<string, Map<string, number>>();
    for (const s of scans) {
      let m = debitedByCard.get(s.pickOrderId);
      if (!m) {
        m = new Map<string, number>();
        debitedByCard.set(s.pickOrderId, m);
      }
      m.set(s.sku, (m.get(s.sku) ?? 0) + 1);
    }

    return computeCommittedStock(
      activePickOrders.map((po) => ({
        pickOrderId: po.id,
        storeCode: codeByStoreId.get(po.storeId) ?? '',
        debitApproved: !!po.debitApprovedAt,
        items: itemsByCard.get(`${po.orderId}::${po.storeId}`) ?? [],
        debited: debitedByCard.get(po.id),
      })),
    );
  }

  /**
   * Aplica `committed` num array de StockEntry, retornando estoque LÍQUIDO (real - reservado).
   * Linhas que ficariam com qty <= 0 são removidas pra não confundir o engine.
   *
   * O log das linhas ZERADAS não é enfeite: é a única pista de por que uma loja
   * que a Consulta mostra com peça não apareceu no roteamento. Card esquecido
   * aberto há dias segura a peça pra sempre — e sem esta linha o diagnóstico
   * vira "sumiu estoque".
   */
  private subtractCommitted(
    stockEntries: StockEntry[],
    committed: Map<string, number>,
  ): StockEntry[] {
    if (committed.size === 0) return stockEntries;
    const out: StockEntry[] = [];
    const zeradas: string[] = [];
    for (const e of stockEntries) {
      const reserved = committed.get(`${e.storeCode}::${e.sku}`) ?? 0;
      const liquid = e.availableQty - reserved;
      if (liquid > 0) out.push({ ...e, availableQty: liquid });
      else if (reserved > 0) zeradas.push(`${e.storeCode}/${e.sku} (${e.availableQty}−${reserved})`);
    }
    if (zeradas.length) {
      this.logger.log(
        `[routing] ${zeradas.length} opção(ões) fora por peça JÁ PROMETIDA a card aberto: ${zeradas.slice(0, 10).join(', ')}` +
          (zeradas.length > 10 ? ` … +${zeradas.length - 10}` : ''),
      );
    }
    return out;
  }

  /**
   * Pick-orders ATIVOS do pedido WC informado (pode não existir Order local ainda → []).
   * Usado pra excluir o próprio pedido do `committed` ao rodar preview/recalcular.
   */
  private async findOwnPickOrderIdsForWc(wcOrderId: number): Promise<string[]> {
    const order = await this.prisma.order.findFirst({
      where: { wcOrderId },
      select: {
        pickOrders: {
          where: { status: { in: ['new', 'separating', 'separated'] } },
          select: { id: true },
        },
      },
    });
    return order?.pickOrders.map((p) => p.id) ?? [];
  }

  /**
   * Preview de separação para um pedido que veio direto do WooCommerce
   * (sem passar pelo banco local). Usa a mesma engine: tenta 1 loja só,
   * se não der, divide entre múltiplas lojas.
   *
   * Recebe os dados já extraídos do WC pra não criar dep circular com
   * WooCommerceService (o controller de orders faz o fetch).
   */
  async previewSeparationForWc(input: {
    wcOrderId: number;
    wcOrderNumber: string;
    orderDateIso: string;
    totalAmount: number;
    paymentMethod: string;
    items: Array<{ sku: string; quantity: number; productName: string; variant?: string }>;
    customerName: string;
    customerPhone?: string | null;
    customerEmail?: string | null;
    customerCpf?: string | null;
    shippingMethod: string;
    /** Se preenchido, força retirada em loja nessa store (já resolvido pelo controller). */
    pickupStoreCode?: string | null;
    isPickup?: boolean;
    /**
     * Loja preferida (override manual via radio button). Se cobrir todos os
     * itens, vira a loja escolhida em vez do pickBest automático.
     */
    preferStoreCode?: string | null;
    /**
     * Troca manual do preview ("↔ Trocar loja" no card): lojas EXCLUÍDAS saem
     * do roteamento; lojas FIXADAS entram primeiro no split com o que cobrem.
     * A loja de retirada nunca é excluída (destino é fixo).
     */
    excludeStoreCodes?: string[];
    pinStoreCodes?: string[];
    address: {
      street?: string | null;
      number?: string | null;
      complement?: string | null;
      neighborhood?: string | null;
      city?: string | null;
      state?: string | null;
      postcode?: string | null;
    };
    orderUrl?: string;
  }) {
    // Sem SKU não dá pra achar estoque; FRETE/MANUAL não TÊM estoque pra achar
    // (a linha de frete do pedido online dava "ruptura" — caso ON-000001).
    const validItems = input.items.filter((i) => i.sku?.trim() && !ehItemSemEstoque(i));
    if (validItems.length === 0) {
      throw new BadRequestException(
        'Nenhum item do pedido tem SKU preenchido. Não dá pra localizar estoque.',
      );
    }

    // A LOJA-CANAL NÃO SEPARA (dono, 24/08): ela RECEBE a peça no acerto entre
    // lojas, não tem arara pra ceder. Ver `common/loja-canal.ts` — 3 cards
    // caíram nela em 90 dias e ficaram parados em `new`, porque não há quem
    // separe do outro lado.
    const stores = await this.prisma.store.findMany({
      where: { active: true, code: { notIn: LOJA_CANAL_CODES } },
    });
    if (stores.length === 0) {
      throw new BadRequestException(
        'Nenhuma loja ativa cadastrada. Cadastra pelo menos uma em /lojas.',
      );
    }

    const skus = [...new Set(validItems.map((i) => i.sku))];
    const storeCodes = stores.map((s) => s.code);
    const stockEntries = await this.stock.getStockFor(skus, storeCodes);

    // Estoque comprometido em pick-orders ativos de OUTROS pedidos (mesma engine
    // do previewRoute pra evitar prometer a mesma peça duas vezes). Quando esse
    // preview é pra recalcular um pedido WC já roteado, descontamos os pick-orders
    // do próprio (vão ser cancelados/recriados pelo recalcular).
    const ownPickOrderIds = await this.findOwnPickOrderIdsForWc(input.wcOrderId);
    const committed = await this.getCommittedStock(skus, storeCodes, ownPickOrderIds);
    const liquidStock = this.subtractCommitted(stockEntries, committed);

    // Troca manual do preview: a loja excluída sai SÓ do roteamento — a lista
    // completa (`stores`) continua alimentando alternativesBySku, senão a loja
    // sumia do próprio modal de troca. Loja de retirada nunca sai (destino fixo).
    const excludeCodes = (input.excludeStoreCodes ?? []).filter(
      (c) => c && c !== input.pickupStoreCode,
    );
    const routableStores = excludeCodes.length
      ? stores.filter((s) => !excludeCodes.includes(s.code))
      : stores;

    const result = this.engine.route({
      items: validItems.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      stores: routableStores.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        cep: s.cep,
        priorityScore: s.priorityScore,
        active: s.active,
      })),
      stock: liquidStock,
      shippingCep: input.address.postcode ?? undefined,
      pickupStoreCode: input.pickupStoreCode ?? null,
      preferStoreCode: input.preferStoreCode ?? null,
      pinStoreCodes: input.pinStoreCodes ?? [],
      juntadaGroup: await this.grupoJuntada(!!input.pickupStoreCode),
    });

    // Enriquece cada grupo com dados da loja + itens completos + mensagem WhatsApp
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const itemBySku = new Map(validItems.map((i) => [i.sku, i]));

    const groups = result.assignments.map((a) => {
      const store = storeById.get(a.storeId);
      const groupItems = a.items.map((ai) => {
        const full = itemBySku.get(ai.sku);
        return {
          sku: ai.sku,
          quantity: ai.quantity,
          productName: full?.productName ?? '',
          variant: full?.variant,
        };
      });

      const message = buildWhatsappMessage({
        wcOrderNumber: input.wcOrderNumber,
        orderDateIso: input.orderDateIso,
        totalAmount: input.totalAmount,
        paymentMethod: input.paymentMethod,
        items: groupItems,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        shippingMethod: input.shippingMethod,
        address: input.address,
        storeName: store?.name,
        orderUrl: input.orderUrl,
        // Sinaliza transferência na própria mensagem pra loja fonte saber
        isTransfer: a.isTransfer ?? false,
        transferToStoreName: a.transferToStoreName ?? null,
        customerCpf: input.customerCpf ?? null,
        customerEmail: input.customerEmail ?? null,
      } as any);

      return {
        storeId: a.storeId,
        storeCode: a.storeCode,
        storeName: a.storeName,
        storeCity: store?.city ?? null,
        storeState: store?.state ?? null,
        whatsapp: store?.whatsapp ?? null,
        contactName: store?.contactName ?? null,
        items: groupItems,
        whatsappMessage: message,
        whatsappUrl: buildWhatsappUrl(store?.whatsapp, message),
        // ── pickup / transferência ──
        isTransfer: a.isTransfer ?? false,
        transferToStoreCode: a.transferToStoreCode ?? null,
        transferToStoreName: a.transferToStoreName ?? null,
      };
    });

    // Lojas alternativas (que também têm estoque) pra override manual.
    //
    // `availableQty` aqui é LÍQUIDO (real − prometido a outros cards): era por
    // esta lista que o "↔ Trocar loja" recriava na mão o overbooking que o
    // roteamento automático evita — a loja aparecia com 1 peça que já estava
    // reservada pra outro pedido. `reservedQty` vai junto pra tela explicar.
    const alternativesBySku: Record<string, Array<{ storeId: string; storeCode: string; storeName: string; availableQty: number; reservedQty: number; whatsapp: string | null }>> = {};
    for (const sku of skus) {
      alternativesBySku[sku] = stores
        .map((s) => {
          const stk = stockEntries.find((e) => e.storeCode === s.code && e.sku === sku);
          const reservado = committed.get(`${s.code}::${sku}`) ?? 0;
          return {
            storeId: s.id,
            storeCode: s.code,
            storeName: s.name,
            availableQty: Math.max(0, (stk?.availableQty ?? 0) - reservado),
            reservedQty: reservado,
            whatsapp: s.whatsapp ?? null,
          };
        })
        // Loja que só tem peça PROMETIDA fica na lista com 0 disponível: sumir
        // dela em silêncio é o que fazia a matriz perguntar "cadê a peça que a
        // Consulta mostra?". Aparecer com 0 + o motivo responde sozinho.
        .filter((x) => x.availableQty > 0 || x.reservedQty > 0)
        .sort((a, b) => b.availableQty - a.availableQty);
    }

    // ── Lojas alternativas que TAMBÉM cobrem o pedido inteiro ──
    // Pega TODAS as lojas marcadas como fullCoverage=true no scoreBreakdown,
    // remove a loja escolhida (groups[0].storeCode) e devolve as top 5 ordenadas
    // por estoque disponível (pra UI mostrar como radio buttons "outras opções").
    // Só faz sentido em single-store — em multi/pickup/insufficient deixa vazio.
    const chosenStoreCode = groups[0]?.storeCode;
    const alternativeFullStores =
      result.strategy === 'single-store'
        ? (result.scoreBreakdown || [])
            .filter((sb) => sb.fullCoverage && sb.storeCode !== chosenStoreCode)
            .sort((a, b) => b.stockBuffer - a.stockBuffer)
            .slice(0, 5)
            .map((sb) => ({
              storeCode: sb.storeCode,
              storeName: sb.storeName,
              stockBuffer: sb.stockBuffer,
              finalScore: sb.finalScore,
            }))
        : [];

    return {
      success: result.success,
      strategy: result.strategy,
      shippingMethod: input.shippingMethod,
      isPickup: input.isPickup ?? false,
      pickupStoreCode: result.pickupStoreCode ?? input.pickupStoreCode ?? null,
      pickupStoreName: result.pickupStoreName ?? null,
      // JUNTADA automática (21/08): o trio da rota própria cobre o pedido →
      // as peças se encontram nesta loja âncora e saem num pacote só.
      consolidateStoreCode: result.consolidateStoreCode ?? null,
      consolidateStoreName: result.consolidateStoreName ?? null,
      customer: {
        name: input.customerName,
        cpf: input.customerCpf ?? null,
        email: input.customerEmail ?? null,
        phone: input.customerPhone ?? null,
      },
      groups,
      missing: result.missing.map((m) => {
        const full = itemBySku.get(m.sku);
        return {
          sku: m.sku,
          quantity: m.quantity,
          productName: full?.productName ?? '',
        };
      }),
      alternativesBySku,
      alternativeFullStores,
      scoreBreakdown: result.scoreBreakdown ?? [],
    };
  }

  /**
   * BATELADA DE PEDIDOS — rota N pedidos de uma vez com:
   *   1. ESTOQUE VIRTUAL compartilhado (a mesma peça não é alocada pra 2 pedidos)
   *   2. PROPORCIONALIDADE INVERSA baseada em venda 30d (cede quem vendeu menos)
   *
   * Uso esperado: matriz clica "Separar todos os pedidos de hoje" na tela da fila
   * WC. Em vez de chamar previewSeparationForWc N vezes (cada uma com estoque
   * fresco), esse método roda N em sequência mantendo:
   *   - um `stockMap` que decrementa a cada assignment feito (memoria local)
   *   - um `cedeStats` que incrementa `currentCedeByStore` a cada peça alocada
   *
   * Retorna uma lista de preview[] — cada item é estruturalmente igual ao
   * retorno de previewSeparationForWc (groups/missing/scoreBreakdown...).
   *
   * Não persiste — preview pra aprovação manual antes de chamar confirmRoute
   * batch ou confirmSeparationForWc por pedido.
   */
  async previewBatchForWc(
    orders: Array<Parameters<RoutingService['previewSeparationForWc']>[0]>,
  ) {
    if (!orders?.length) return { previews: [], cedeSummary: null };

    // A LOJA-CANAL NÃO SEPARA (dono, 24/08): ela RECEBE a peça no acerto entre
    // lojas, não tem arara pra ceder. Ver `common/loja-canal.ts` — 3 cards
    // caíram nela em 90 dias e ficaram parados em `new`, porque não há quem
    // separe do outro lado.
    const stores = await this.prisma.store.findMany({
      where: { active: true, code: { notIn: LOJA_CANAL_CODES } },
    });
    if (stores.length === 0) {
      throw new BadRequestException(
        'Nenhuma loja ativa cadastrada. Cadastra pelo menos uma em /lojas.',
      );
    }
    const storeCodes = stores.map((s) => s.code);

    // 1) coleta TODOS os SKUs da batelada pra fazer UM fetch só de estoque
    const allSkus = new Set<string>();
    for (const o of orders) {
      for (const it of o.items) {
        if (it.sku && it.sku.trim()) allSkus.add(it.sku.trim());
      }
    }
    const stockEntries = await this.stock.getStockFor([...allSkus], storeCodes);

    // Estoque comprometido em pick-orders ativos de pedidos FORA da batelada (excluindo
    // os pick-orders dos próprios pedidos WC sendo recalculados, se existirem).
    const ownPickOrderIdsArr = await Promise.all(
      orders.map((o) => this.findOwnPickOrderIdsForWc(o.wcOrderId)),
    );
    const ownPickOrderIds = ownPickOrderIdsArr.flat();
    const committedExternal = await this.getCommittedStock(
      [...allSkus],
      storeCodes,
      ownPickOrderIds,
    );

    // 2) stockMap (storeCode+sku → qty) mutável — decrementa a cada alocação INTERNA
    //    da batelada. O baseline JÁ vem reduzido pelo committed externo.
    const stockMap = new Map<string, number>();
    for (const e of stockEntries) {
      const reserved = committedExternal.get(`${e.storeCode}::${e.sku}`) ?? 0;
      const liquid = Math.max(0, e.availableQty - reserved);
      stockMap.set(`${e.storeCode}::${e.sku}`, liquid);
    }
    const getStock = (storeCode: string, sku: string) =>
      stockMap.get(`${storeCode}::${sku}`) ?? 0;

    // 3) calcula targetQuota por loja (elegíveis = todas ativas)
    const quotas = await this.salesStats.getCedeQuotas(storeCodes, 30);
    const cedeStats: RoutingCedeStats = {
      targetQuotaByStore: quotas.targetQuotaByStore,
      salesShareByStore: quotas.salesShareByStore,
      currentCedeByStore: Object.fromEntries(storeCodes.map((c) => [c, 0])),
      totalCedeSoFar: 0,
      windowDays: quotas.windowDays,
    };

    const previews: any[] = [];

    // 4) roda pedido por pedido usando o mesmo stockMap + cedeStats
    for (const input of orders) {
      const validItems = input.items.filter((i) => i.sku?.trim() && !ehItemSemEstoque(i));
      if (validItems.length === 0) {
        previews.push({
          wcOrderNumber: input.wcOrderNumber,
          success: false,
          strategy: 'insufficient-stock',
          missing: input.items.map((i) => ({
            sku: i.sku,
            quantity: i.quantity,
            productName: i.productName,
          })),
          groups: [],
          error: 'Nenhum item tem SKU.',
        });
        continue;
      }

      // reconstrói stock entries a partir do stockMap ATUALIZADO (pra esse pedido
      // enxergar as baixas virtuais dos pedidos anteriores da batelada).
      const skusThis = [...new Set(validItems.map((i) => i.sku.trim()))];
      const stockForEngine: StockEntry[] = [];
      for (const sku of skusThis) {
        for (const code of storeCodes) {
          const qty = getStock(code, sku);
          if (qty > 0) {
            stockForEngine.push({ storeCode: code, sku, availableQty: qty });
          }
        }
      }

      const result = this.engine.route({
        items: validItems.map((i) => ({ sku: i.sku, quantity: i.quantity })),
        stores: stores.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          cep: s.cep,
          priorityScore: s.priorityScore,
          active: s.active,
        })),
        stock: stockForEngine,
        shippingCep: input.address?.postcode ?? undefined,
        pickupStoreCode: input.pickupStoreCode ?? null,
        cedeStats, // <-- HABILITA proporcionalidade
      });

      // 5) DECREMENTA stock virtual + incrementa cede counters
      //    (só faz isso nos assignments que são VENDA SITE = não-transfer pickup;
      //    transfer-to-pickup também debita porque a peça sai do estoque da loja fonte)
      for (const a of result.assignments) {
        for (const it of a.items) {
          const key = `${a.storeCode}::${it.sku}`;
          const cur = stockMap.get(key) ?? 0;
          const next = Math.max(0, cur - it.quantity);
          stockMap.set(key, next);
        }

        // Só conta como "cessão" quando a loja está atendendo pedido de ENVIO (site),
        // não quando o cliente escolheu RETIRAR na própria loja (pickup-lock),
        // porque nesse caso a peça é vendida LOCALMENTE, não cedida ao e-commerce.
        const isPickupLockAtSelf = result.strategy === 'pickup-lock';
        if (!isPickupLockAtSelf) {
          const qtyCedida = a.items.reduce((s, it) => s + it.quantity, 0);
          cedeStats.currentCedeByStore[a.storeCode] =
            (cedeStats.currentCedeByStore[a.storeCode] ?? 0) + qtyCedida;
          cedeStats.totalCedeSoFar += qtyCedida;
        }
      }

      // 6) monta preview igual ao previewSeparationForWc
      const storeById = new Map(stores.map((s) => [s.id, s]));
      const itemBySku = new Map(validItems.map((i) => [i.sku, i]));
      const groups = result.assignments.map((a) => {
        const store = storeById.get(a.storeId);
        const groupItems = a.items.map((ai) => {
          const full = itemBySku.get(ai.sku);
          return {
            sku: ai.sku,
            quantity: ai.quantity,
            productName: full?.productName ?? '',
            variant: full?.variant,
          };
        });
        const message = buildWhatsappMessage({
          wcOrderNumber: input.wcOrderNumber,
          orderDateIso: input.orderDateIso,
          totalAmount: input.totalAmount,
          paymentMethod: input.paymentMethod,
          items: groupItems,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          shippingMethod: input.shippingMethod,
          address: input.address,
          storeName: store?.name,
          orderUrl: input.orderUrl,
          isTransfer: a.isTransfer ?? false,
          transferToStoreName: a.transferToStoreName ?? null,
          customerCpf: input.customerCpf ?? null,
          customerEmail: input.customerEmail ?? null,
        } as any);
        return {
          storeId: a.storeId,
          storeCode: a.storeCode,
          storeName: a.storeName,
          storeCity: store?.city ?? null,
          storeState: store?.state ?? null,
          whatsapp: store?.whatsapp ?? null,
          contactName: store?.contactName ?? null,
          items: groupItems,
          whatsappMessage: message,
          whatsappUrl: buildWhatsappUrl(store?.whatsapp, message),
          isTransfer: a.isTransfer ?? false,
          transferToStoreCode: a.transferToStoreCode ?? null,
          transferToStoreName: a.transferToStoreName ?? null,
        };
      });

      previews.push({
        wcOrderId: input.wcOrderId,
        wcOrderNumber: input.wcOrderNumber,
        success: result.success,
        strategy: result.strategy,
        shippingMethod: input.shippingMethod,
        isPickup: input.isPickup ?? false,
        pickupStoreCode: result.pickupStoreCode ?? input.pickupStoreCode ?? null,
        pickupStoreName: result.pickupStoreName ?? null,
        customer: {
          name: input.customerName,
          cpf: input.customerCpf ?? null,
          email: input.customerEmail ?? null,
          phone: input.customerPhone ?? null,
        },
        groups,
        missing: result.missing.map((m) => {
          const full = itemBySku.get(m.sku);
          return {
            sku: m.sku,
            quantity: m.quantity,
            productName: full?.productName ?? '',
          };
        }),
        scoreBreakdown: result.scoreBreakdown ?? [],
      });
    }

    // 7) Snapshot final do cedeStats pra UI mostrar equilíbrio alcançado
    const cedeSummary = {
      windowDays: cedeStats.windowDays ?? 30,
      totalCedeSoFar: cedeStats.totalCedeSoFar,
      byStore: storeCodes.map((code) => {
        const ceded = cedeStats.currentCedeByStore[code] ?? 0;
        const quota = cedeStats.targetQuotaByStore[code] ?? 0;
        const salesShare = cedeStats.salesShareByStore?.[code] ?? 0;
        const actualShare = cedeStats.totalCedeSoFar > 0 ? ceded / cedeStats.totalCedeSoFar : 0;
        const store = stores.find((s) => s.code === code);
        return {
          storeCode: code,
          storeName: store?.name ?? code,
          salesShare: Number(salesShare.toFixed(4)),
          targetQuota: Number(quota.toFixed(4)),
          ceded,
          actualShare: Number(actualShare.toFixed(4)),
          delta: Number((quota - actualShare).toFixed(4)),
        };
      }),
    };

    return { previews, cedeSummary };
  }
}
