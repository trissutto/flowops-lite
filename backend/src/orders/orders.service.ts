import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus } from '../common/enums';
import { extractCpf, detectPickup } from '../woocommerce/wc-order-extract.util';
import { extractAttributionRaw } from '../woocommerce/attribution.util';
import { lerComplementoBairroWc, montarComplementoBairroWc, montarNumeroWc } from '../common/endereco-wc';
import { pedidoPago, pedidoCancelado } from '../common/pedido-pago';
import { cpfValido, emailOk } from '../common/dados-cliente-online';
import { localBrPhone, localBrPhoneValido } from '../lib/phone-br';
import { SQL_CAMPANHAS_ROAS } from './campanhas-roas.sql';
import { contasDeLoja } from '../common/contas-de-anuncio';

/**
 * Uma linha como o Postgres devolve. Tudo que é dinheiro sai da query já em
 * `float8` e o que é contagem em `int` — `numeric` e `bigint` do Prisma viram
 * objeto/BigInt e o `JSON.stringify` do Nest morre com 500 mudo.
 */
interface LinhaCampanhaCrua {
  campanhaId: string | null;
  campanha: string;
  rede: string | null;
  pedidos: number;
  receita: number;
  naoPagos: number;
  naoPagosReceita: number;
  recuperados: number;
  recuperadosValor: number;
  voltouSozinha: number;
  voltouSozinhaValor: number;
  cancelados: number;
  gasto: number | null;
  cliques: number | null;
  impressoes: number | null;
  sessoes: number;
  pedidosOffline: number;
  receitaOffline: number;
  /** O pedido trazia utm_id? Distingue "anúncio não manda" de "id não casa". */
  comUtmId: boolean;
  source: string | null;
  medium: string | null;
  origensDistintas: number;
  origemPct: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cache em memória das lojas ativas (TTL 5 min).
   * Evita um findMany em CADA import de pedido (webhook + cada item do poller).
   * Lojas mudam raríssimas vezes; 5 min de defasagem é aceitável.
   */
  private activeStoresCache: { data: Array<{ code: string; name: string; city: string | null }>; expires: number } | null = null;
  private static readonly ACTIVE_STORES_TTL = 5 * 60_000;

  private async getActiveStores() {
    const now = Date.now();
    if (this.activeStoresCache && this.activeStoresCache.expires > now) {
      return this.activeStoresCache.data;
    }
    const data = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });
    this.activeStoresCache = { data, expires: now + OrdersService.ACTIVE_STORES_TTL };
    return data;
  }

  /** Invalida o cache de lojas ativas (chamar após criar/editar/desativar loja). */
  invalidateActiveStoresCache() {
    this.activeStoresCache = null;
  }

  /**
   * Upsert de pedido vindo do WooCommerce.
   * Retorna o id interno + se deve disparar roteamento.
   * Quando shouldRoute=true, devolve também os campos usados na emissão WS
   * (evita um findUnique redundante no poller).
   */
  async upsertFromWooCommerce(wc: any): Promise<{
    orderId: string;
    shouldRoute: boolean;
    wasCreated: boolean;
    order?: { id: string; wcOrderNumber: string | null; customerName: string | null; totalAmount: number | null; status: string; createdAt: Date };
  }> {
    const wcOrderId = Number(wc.id);
    // PEÇA É PEÇA (29/08): linha do WC com quantity N vira N linhas de 1 —
    // troca, cancelamento, rateio do split e bipe operam POR LINHA (caso
    // LP-001005: 2× do mesmo SKU numa linha só quebrava esses fluxos).
    const items = (wc.line_items ?? []).flatMap((li: any) => {
      const qtd = Math.max(1, Math.floor(Number(li.quantity) || 1));
      const linha = {
        sku: String(li.sku || `wc-${li.product_id}`),
        productName: li.name,
        quantity: 1,
        unitPrice: li.price ? Number(li.price) : null,
      };
      return Array.from({ length: qtd }, () => ({ ...linha }));
    });

    const shipping = wc.shipping ?? {};
    const status = this.mapStatus(wc.status);

    // Data real do WC (quando o cliente fez o pedido no site)
    const wcCreated = wc.date_created_gmt
      ? new Date(wc.date_created_gmt + 'Z')
      : wc.date_created
      ? new Date(wc.date_created)
      : null;

    // CPF do cliente (extraído de meta_data do WC conforme plugin utilizado)
    const customerCpf = extractCpf(wc);

    // Detecta retirada em loja — precisa das stores ativas pra mapear a loja escolhida
    // (cacheado em memória; ver getActiveStores)
    const activeStores = await this.getActiveStores();
    const pickup = detectPickup(wc, activeStores);

    if (pickup.isPickup && !pickup.pickupStoreCode) {
      this.logger.warn(
        `Pedido WC #${wc.id} é retirada em loja mas não mapeou store. ` +
          `Cidade detectada: "${pickup.unresolvedCityName ?? 'nenhuma'}". ` +
          `Método: "${pickup.shippingMethodTitle}". ` +
          `Cadastre a Store correspondente em /lojas.`,
      );
    }

    // Atribuição de marketing (de qual campanha veio) — Order Attribution do WC.
    const attr = extractAttributionRaw(wc.meta_data ?? []);

    const payload = {
      wcOrderNumber: String(wc.number ?? wc.id),
      status,
      customerName: `${shipping.first_name ?? ''} ${shipping.last_name ?? ''}`.trim() ||
                    `${wc.billing?.first_name ?? ''} ${wc.billing?.last_name ?? ''}`.trim(),
      customerEmail: wc.billing?.email,
      // Sem o DDI: "+5511…" colado no telefone virava número de ninguém no
      // pedido (ver `localBrPhone`). Ausente continua ausente — update de
      // webhook sem billing.phone NÃO pode apagar o que o pedido já tem.
      customerPhone: wc.billing?.phone == null ? wc.billing?.phone : localBrPhone(wc.billing.phone) || null,
      customerCpf,
      shippingCep: (shipping.postcode ?? wc.billing?.postcode ?? '').replace(/\D/g, ''),
      shippingAddress: JSON.stringify(shipping),
      totalAmount: wc.total ? Number(wc.total) : null,
      isPickup: pickup.isPickup,
      pickupStoreCode: pickup.pickupStoreCode,
      shippingMethod: pickup.shippingMethodTitle,
      wcDateCreated: wcCreated,
      // Só grava atribuição quando o WC mandou algo (source/campaign) — assim um
      // webhook de update sem meta_data NÃO apaga a campanha capturada no 1º toque.
      ...(attr.sourceType || attr.utmSource || attr.utmCampaign
        ? {
            utmSource: attr.utmSource,
            utmMedium: attr.utmMedium,
            utmCampaign: attr.utmCampaign,
            utmId: attr.utmId,
            utmContent: attr.utmContent,
          }
        : {}),
    };

    const existing = await this.prisma.order.findUnique({ where: { wcOrderId } });

    if (existing) {
      // Pode sobrescrever o status se ainda não começou o fluxo operacional.
      // Se já está em separating/ready/shipped/delivered, NÃO mexe.
      const canOverwriteStatus = ['pending', 'processing', 'awaiting_stock', 'cancelled', 'failed'].includes(existing.status);
      const nextStatus = canOverwriteStatus ? status : existing.status;

      await this.prisma.order.update({
        where: { id: existing.id },
        data: {
          ...payload,
          status: nextStatus,
          // Carimbo do despacho na entrada de status (ver
          // `common/janela-rastreio.ts`). Só na TRANSIÇÃO: reimportar um
          // pedido já despachado não pode rejuvenescer a caixa.
          ...(nextStatus === OrderStatus.shipped && existing.status !== OrderStatus.shipped
            ? { shippedAt: new Date() }
            : {}),
        },
      });
      this.logger.log(`Order #${wc.id} atualizado (${existing.status} → ${nextStatus}).`);
      const shouldRoute = canOverwriteStatus && nextStatus === OrderStatus.processing;
      return {
        orderId: existing.id,
        shouldRoute,
        wasCreated: false,
        order: shouldRoute
          ? {
              id: existing.id,
              wcOrderNumber: payload.wcOrderNumber,
              customerName: payload.customerName,
              totalAmount: payload.totalAmount,
              status: nextStatus,
              createdAt: existing.createdAt,
            }
          : undefined,
      };
    }

    const created = await this.prisma.order.create({
      data: {
        wcOrderId,
        ...payload,
        items: { create: items },
      },
    });
    this.logger.log(`Order #${wc.id} criado (internal ${created.id}, ${items.length} itens, status ${status}).`);
    const shouldRouteCreated = status === OrderStatus.processing;
    return {
      orderId: created.id,
      shouldRoute: shouldRouteCreated,
      wasCreated: true,
      order: shouldRouteCreated
        ? {
            id: created.id,
            wcOrderNumber: created.wcOrderNumber,
            customerName: created.customerName,
            totalAmount: created.totalAmount,
            status: created.status,
            createdAt: created.createdAt,
          }
        : undefined,
    };
  }

  /**
   * Mapeia status do WooCommerce para status interno do FlowOps.
   *
   * Diferença crítica:
   *   pending    → aguardando pagamento (NÃO separar)
   *   processing → pago, precisa separar (✓ dispara roteamento)
   */
  private mapStatus(wcStatus: string): OrderStatus {
    const s = (wcStatus ?? '').toLowerCase().replace(/^wc-/, '');

    if (['completed', 'delivered', 'entregue', 'finished'].includes(s)) return OrderStatus.delivered;
    if (['cancelled', 'canceled', 'refunded', 'expired', 'pix-expired', 'boleto-expired', 'trash'].includes(s)) return OrderStatus.cancelled;
    if (['failed', 'malsucedido'].includes(s)) return OrderStatus.failed;
    if (['shipped', 'sent', 'enviado', 'dispatched'].includes(s)) return OrderStatus.shipped;
    if (['ready', 'ready-to-ship', 'pronto'].includes(s)) return OrderStatus.ready;

    // PAGOS — prontos pra separação
    if (['processing', 'pago', 'paid', 'approved', 'em-separacao'].includes(s)) return OrderStatus.processing;

    // AGUARDANDO PAGAMENTO
    if (['pending', 'on-hold', 'checkout-draft', 'pending-payment', 'pix-pending', 'boleto-pending', 'aguardando'].includes(s)) return OrderStatus.pending;

    this.logger.debug(`Status WC desconhecido: "${wcStatus}" → mapeado para pending`);
    return OrderStatus.pending;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const result: Record<string, number> = {};
    for (const r of rows) result[r.status] = r._count.status;
    return result;
  }

  /**
   * Financeiro/Analítico: agrega pedidos no intervalo [from, to] (inclusive).
   *
   * Fonte de verdade: tabela local `orders` (espelho do WC alimentado pelo webhook+poll).
   * Data usada: wcDateCreated (quando o cliente fez o pedido no site). Fallback pra createdAt
   * se wcDateCreated estiver null (pedidos antigos antes do fix).
   *
   * Retorna KPIs agregados + breakdowns (por status / loja / dia / produto / pickup).
   * Pickups, transferências e fretes separados pra o CEO ter visibilidade de origem e destino.
   */
  /**
   * GASTO → RECEITA → ROAS por campanha, no intervalo [from, to] (SP).
   *
   * Junta quatro fontes num lugar só, todas casadas por `campaign.id`:
   *   - gasto: `meta_ads_gasto_dia` + `google_ads_gasto_dia` (contas de ECOMM);
   *   - receita: `orders` PAGOS (régua de `common/pedido-pago.ts`);
   *   - sessões: `site_eventos` (denominador da conversão);
   *   - receita ASSISTIDA: carrinho largado que virou venda pelo WhatsApp/PDV.
   *
   * ⚠️ ROAS de linha sem gasto casado é `null`, NUNCA zero — ausência de dado
   * não é desempenho ruim, e a diferença decide se a campanha é desligada.
   * O motivo de cada falta vai em `motivoSemGasto` e o total em
   * `reconciliacao`: buraco que a tela não mostra vira decisão errada.
   *
   * NÃO é retroativo: só vale a partir de quando o anúncio passou a mandar UTM.
   */
  async campanhasReport(fromStr: string, toStr: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
      throw new Error('from e to devem estar no formato YYYY-MM-DD');
    }
    const from = new Date(`${fromStr}T00:00:00-03:00`);
    const to = new Date(`${toStr}T23:59:59.999-03:00`);
    if (to < from) throw new Error('to deve ser >= from');

    const linhas = await this.prisma.$queryRawUnsafe<LinhaCampanhaCrua[]>(
      SQL_CAMPANHAS_ROAS,
      from,
      to,
      // Contas de LOJA FÍSICA fora do denominador desta tela — ver
      // `common/contas-de-anuncio.ts`. Lista vazia não exclui nada.
      contasDeLoja(),
    );

    const SEM = 'Sem campanha / Direto';
    const n = (v: unknown) => Number(v ?? 0);

    const campanhas = linhas.map((l) => {
      const gasto = l.gasto == null ? null : n(l.gasto);
      const receita = n(l.receita);
      const receitaOffline = n(l.receitaOffline);
      const pedidos = n(l.pedidos);
      const sessoes = n(l.sessoes);
      const temGasto = gasto != null && gasto > 0;

      return {
        campanhaId: l.campanhaId ?? null,
        campanha: l.campanha === '(sem campanha)' ? SEM : l.campanha,
        rede: l.rede ?? null,
        comUtm: l.campanha !== '(sem campanha)',
        source: l.source ?? null,
        medium: l.medium ?? null,
        origemPct: n(l.origemPct),
        origensDistintas: n(l.origensDistintas),

        pedidos,
        receita,
        ticketMedio: pedidos > 0 ? receita / pedidos : 0,
        naoPagos: n(l.naoPagos),
        naoPagosReceita: n(l.naoPagosReceita),
        /**
         * RECUPERADO: a tentativa não pagou, mas a MESMA pessoa fechou uma
         * venda paga em até 14 dias — o atendimento foi atrás e salvou.
         *
         * ⚠️ NÃO somar isto à receita: o dinheiro da venda recuperada já está
         * em `receita` (se veio com UTM) ou em `receitaOffline` (se não veio).
         * Aqui é a CONTAGEM da tentativa que acabou bem, pra a tela parar de
         * cobrar da campanha uma perda que não existiu.
         */
        recuperados: n(l.recuperados),
        recuperadosValor: n(l.recuperadosValor),
        /**
         * Pagou depois SEM ninguém chamar. Fica separado de `recuperados` de
         * propósito: recuperação é mérito do time, retentativa espontânea não.
         * Juntar os dois faria a tela dar crédito por trabalho que não houve.
         */
        voltouSozinha: n(l.voltouSozinha),
        voltouSozinhaValor: n(l.voltouSozinhaValor),
        cancelados: n(l.cancelados),

        gasto,
        cliques: l.cliques == null ? null : n(l.cliques),
        impressoes: l.impressoes == null ? null : n(l.impressoes),
        /** ROAS só existe quando há gasto casado. Sem gasto NÃO é ROAS zero. */
        roas: temGasto ? receita / gasto : null,
        roasComAssistida: temGasto ? (receita + receitaOffline) / gasto : null,
        custoPorPedido: temGasto && pedidos > 0 ? gasto / pedidos : null,

        sessoes,
        /**
         * Conversão pode passar de 100% e isso NÃO é bug: a origem do pedido
         * vale 30 dias de último clique, mas a sessão só conta dentro do
         * período escolhido. A tela marca em vez de esconder.
         */
        conversao: sessoes > 0 ? (pedidos / sessoes) * 100 : null,
        conversaoSuspeita: sessoes > 0 && pedidos > sessoes,

        pedidosOffline: n(l.pedidosOffline),
        receitaOffline,

        /**
         * Por que esta linha não tem gasto casado. É o que transforma um buraco
         * mudo em tarefa: `sem_id` = o anúncio não manda utm_id (caso do Google
         * até 24/08); `id_nao_casa` = manda id de CONJUNTO em vez de campanha.
         */
        motivoSemGasto:
          // Gasto casado (mesmo que R$ 0,00 no período) não tem motivo nenhum:
          // a campanha existe no espelho, só não rodou. Dizer "não manda o id"
          // aqui manda o dono consertar UTM que já está certa.
          gasto != null
            ? null
            : !l.comUtmId
              ? (l.campanha === '(sem campanha)' ? 'direto' : 'sem_id')
              : 'id_nao_casa',
      };
    });

    const soma = (f: (c: (typeof campanhas)[number]) => number) =>
      campanhas.reduce((acc, c) => acc + f(c), 0);

    const totalPedidos = soma((c) => c.pedidos);
    const totalReceita = soma((c) => c.receita);
    const totalGasto = soma((c) => c.gasto ?? 0);
    const totalReceitaOffline = soma((c) => c.receitaOffline);
    const totalSessoes = soma((c) => c.sessoes);

    // RECONCILIAÇÃO: o que não casou dos dois lados. Sem isto o ROAS parece
    // pior do que é e ninguém descobre por quê.
    const semGasto = campanhas.filter((c) => c.gasto == null && c.receita > 0 && c.comUtm);
    const semReceita = campanhas.filter((c) => (c.gasto ?? 0) > 0 && c.pedidos === 0);

    return {
      from: fromStr,
      to: toStr,
      totalPedidos,
      totalReceita,
      totalNaoPagos: soma((c) => c.naoPagos),
      totalNaoPagosReceita: soma((c) => c.naoPagosReceita),
      totalRecuperados: soma((c) => c.recuperados),
      totalRecuperadosValor: soma((c) => c.recuperadosValor),
      totalVoltouSozinha: soma((c) => c.voltouSozinha),
      totalVoltouSozinhaValor: soma((c) => c.voltouSozinhaValor),
      totalCancelados: soma((c) => c.cancelados),
      ticketMedioGeral: totalPedidos > 0 ? totalReceita / totalPedidos : 0,

      totalGasto,
      totalReceitaOffline,
      totalPedidosOffline: soma((c) => c.pedidosOffline),
      roas: totalGasto > 0 ? totalReceita / totalGasto : null,
      roasComAssistida: totalGasto > 0 ? (totalReceita + totalReceitaOffline) / totalGasto : null,
      totalSessoes,
      conversaoGeral: totalSessoes > 0 ? (totalPedidos / totalSessoes) * 100 : null,

      reconciliacao: {
        receitaSemGasto: semGasto.reduce((a, c) => a + c.receita, 0),
        linhasSemGasto: semGasto.length,
        gastoSemReceita: semReceita.reduce((a, c) => a + (c.gasto ?? 0), 0),
        linhasGastoSemReceita: semReceita.length,
        semId: campanhas.filter((c) => c.motivoSemGasto === 'sem_id').length,
        idNaoCasa: campanhas.filter((c) => c.motivoSemGasto === 'id_nao_casa').length,
      },

      campanhas,
    };
  }


  async analytics(fromStr: string, toStr: string) {
    // Parse das datas do query string (formato YYYY-MM-DD).
    // Usa timezone America/Sao_Paulo (-03:00) porque o CEO pensa em horário local,
    // não em UTC. from = 00:00 de from; to = 23:59:59.999 de to.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
      throw new Error('from e to devem estar no formato YYYY-MM-DD');
    }
    const from = new Date(`${fromStr}T00:00:00-03:00`);
    const to   = new Date(`${toStr}T23:59:59.999-03:00`);
    if (to < from) {
      throw new Error('to deve ser >= from');
    }

    // Coalesce: wcDateCreated se existe, senão createdAt. Filtra inclusive.
    const whereDate = {
      OR: [
        { wcDateCreated: { gte: from, lte: to } },
        { AND: [{ wcDateCreated: null }, { createdAt: { gte: from, lte: to } }] },
      ],
    };

    // 1) Puxa pedidos do período com items e pick-orders (pra saber loja que separou)
    const orders = await this.prisma.order.findMany({
      where: whereDate,
      include: {
        items: true,
        pickOrders: { include: { store: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Só entra no faturamento o pedido que virou DINHEIRO — régua única em
    // common/pedido-pago.ts. Antes esta linha excluía 'cancelled' e 'failed',
    // e deixava passar 'payment_failed' (cartão recusado) e 'awaiting_payment'
    // (PIX/link nunca pago), que juntos inflavam a receita do site novo em
    // 24,7% (medição de 24/08). Agora eles saem do total e viram `unpaid*`.
    // "Enviado" = tem pelo menos 1 pick-order com status shipped OU order.status shipped/delivered
    const isShipped = (o: typeof orders[number]) =>
      ['shipped', 'delivered'].includes(o.status) ||
      o.pickOrders.some((p) => ['shipped', 'delivered'].includes(p.status));

    // 2) KPIs agregados
    let totalOrders = 0;
    let totalRevenue = 0;
    let cancelledCount = 0;
    let cancelledRevenue = 0;
    let shippedCount = 0;
    let shippedRevenue = 0;
    let pickupCount = 0;
    let pickupRevenue = 0;
    let shippingCount = 0;       // frete (não pickup)
    let shippingRevenue = 0;
    let transferCount = 0;       // pedidos com pelo menos 1 pick-order de transferência
    let inProgressCount = 0;     // ainda não enviado, não cancelado
    let unpaidCount = 0;         // cartão recusado / PIX vencido: nunca virou dinheiro
    let unpaidRevenue = 0;

    for (const o of orders) {
      const amt = Number(o.totalAmount ?? 0);
      totalOrders++;
      if (pedidoCancelado(o)) {
        cancelledCount++;
        cancelledRevenue += amt;
        continue;
      }
      // Nunca pagou ≠ cancelou. Fica em balde próprio pra o buraco aparecer
      // na tela em vez de sumir dentro de "cancelados".
      if (!pedidoPago(o)) {
        unpaidCount++;
        unpaidRevenue += amt;
        continue;
      }
      totalRevenue += amt;
      if (isShipped(o)) {
        shippedCount++;
        shippedRevenue += amt;
      } else {
        inProgressCount++;
      }
      if (o.isPickup) {
        pickupCount++;
        pickupRevenue += amt;
      } else {
        shippingCount++;
        shippingRevenue += amt;
      }
      if (o.pickOrders.some((p) => p.isTransfer)) transferCount++;
    }

    // 3) Breakdown por status local
    const byStatusMap = new Map<string, { count: number; revenue: number }>();
    for (const o of orders) {
      const k = o.status;
      const cur = byStatusMap.get(k) ?? { count: 0, revenue: 0 };
      cur.count++;
      cur.revenue += Number(o.totalAmount ?? 0);
      byStatusMap.set(k, cur);
    }
    const byStatus = Array.from(byStatusMap.entries())
      .map(([status, v]) => ({ status, ...v }))
      .sort((a, b) => b.count - a.count);

    // 4) Breakdown por loja que separou (pick-orders não-transferência)
    //    Uma order pode render 1+ pick-orders. Contamos o pick-order, não a order,
    //    pra refletir esforço real de cada loja. Valor: rateado proporcional a itens.
    const byStoreMap = new Map<string, {
      storeCode: string;
      storeName: string;
      pickOrders: number;         // qtd de ordens de separação recebidas
      shipped: number;             // qtd enviadas
      transferOut: number;         // qtd separadas pra transferir pra outra loja
      revenue: number;             // soma do valor dos pedidos (sem ratear)
      approved: number;            // pick-orders com baixa aprovada
    }>();
    for (const o of orders) {
      if (!pedidoPago(o)) continue;
      const amt = Number(o.totalAmount ?? 0);
      // Dedup: se um pedido tem 2 pick-orders na mesma loja, ainda conta só 1 na revenue da loja.
      const storesHit = new Set<string>();
      for (const p of o.pickOrders) {
        const code = p.store.code;
        const name = p.store.name;
        const cur = byStoreMap.get(code) ?? {
          storeCode: code, storeName: name,
          pickOrders: 0, shipped: 0, transferOut: 0, revenue: 0, approved: 0,
        };
        cur.pickOrders++;
        if (['shipped', 'delivered'].includes(p.status)) cur.shipped++;
        if (p.isTransfer) cur.transferOut++;
        if (p.debitApprovedAt) cur.approved++;
        if (!storesHit.has(code)) {
          cur.revenue += amt / Math.max(1, o.pickOrders.length); // rateia se multi-loja
          storesHit.add(code);
        }
        byStoreMap.set(code, cur);
      }
    }
    const byStore = Array.from(byStoreMap.values())
      .sort((a, b) => b.pickOrders - a.pickOrders);

    // 5) Breakdown por dia (série temporal pra gráfico de linha)
    const byDayMap = new Map<string, { count: number; revenue: number }>();
    for (const o of orders) {
      if (!pedidoPago(o)) continue;
      const date = o.wcDateCreated ?? o.createdAt;
      // Converte pra YYYY-MM-DD em horário de SP (-03:00)
      const key = new Date(date.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      const cur = byDayMap.get(key) ?? { count: 0, revenue: 0 };
      cur.count++;
      cur.revenue += Number(o.totalAmount ?? 0);
      byDayMap.set(key, cur);
    }
    const byDay = Array.from(byDayMap.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // 6) Top produtos (soma quantidade + valor estimado por unitPrice)
    const byProductMap = new Map<string, { sku: string; productName: string; quantity: number; revenue: number }>();
    for (const o of orders) {
      if (!pedidoPago(o)) continue;
      for (const it of o.items) {
        const cur = byProductMap.get(it.sku) ?? {
          sku: it.sku,
          productName: it.productName ?? '(sem nome)',
          quantity: 0,
          revenue: 0,
        };
        cur.quantity += it.quantity;
        cur.revenue += Number(it.unitPrice ?? 0) * it.quantity;
        byProductMap.set(it.sku, cur);
      }
    }
    const topProducts = Array.from(byProductMap.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 20);

    // Denominador = só pedido pago. Tirar apenas os cancelados deixaria o
    // recusado/não-pago no divisor e achataria o ticket médio de graça.
    const paidOrders = totalOrders - cancelledCount - unpaidCount;

    const avgTicket = totalRevenue > 0 && paidOrders > 0
      ? totalRevenue / paidOrders
      : 0;

    const shipmentRate = paidOrders > 0
      ? shippedCount / paidOrders
      : 0;

    return {
      period: {
        from: fromStr,
        to: toStr,
        days: Math.round((to.getTime() - from.getTime()) / 86400000) + 1,
      },
      kpis: {
        totalOrders,
        totalRevenue,
        avgTicket,
        cancelledCount,
        cancelledRevenue,
        unpaidCount,
        unpaidRevenue,
        shippedCount,
        shippedRevenue,
        inProgressCount,
        pickupCount,
        pickupRevenue,
        shippingCount,
        shippingRevenue,
        transferCount,
        shipmentRate,
      },
      byStatus,
      byStore,
      byDay,
      topProducts,
    };
  }

  async list(params: { status?: OrderStatus; page?: number; limit?: number }) {
    const take = params.limit ?? 20;
    const skip = ((params.page ?? 1) - 1) * take;
    const where = params.status ? { status: params.status } : {};
    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where, skip, take,
        orderBy: { createdAt: 'desc' },
        include: { items: true, pickOrders: { include: { store: true } } },
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data, total, page: params.page ?? 1, limit: take };
  }

  async getById(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { assignedStore: true } },
        pickOrders: { include: { store: true } },
        history: { orderBy: { createdAt: 'desc' }, include: { user: true } },
      },
    });
    if (!order) throw new NotFoundException('Pedido não encontrado');
    return order;
  }

  /**
   * CORRIGE O ENDEREÇO DE ENTREGA de um pedido — o que faltava pra operadora.
   *
   * O endereço do pedido é um SNAPSHOT (`shippingAddress`, JSON) gravado no
   * checkout, e a etiqueta lê dele. Não existia rota nenhuma pra mexer nisso:
   * a operadora via o complemento errado na hora de postar e não tinha o que
   * clicar. Editar o cadastro do cliente não resolvia, porque o pedido carrega
   * a cópia.
   *
   * Espelha no cadastro do cliente (decisão do dono, 04/08): quem corrigiu o
   * endereço na hora de postar corrigiu a informação de verdade — deixar o
   * cadastro velho só garante que o próximo pedido nasce errado de novo.
   *
   * Grava o de→para em `IntegrationLog`, igual à edição de endereço da live:
   * endereço errado manda a peça pro lugar errado, então precisa de rastro de
   * quem mudou o quê.
   */
  async atualizarEnderecoEntrega(
    wcOrderId: number,
    input: {
      cep?: string; endereco?: string; numero?: string; complemento?: string;
      bairro?: string; cidade?: string; uf?: string;
      nome?: string; telefone?: string;
    },
    actor?: { userId?: string | null; name?: string | null; storeCode?: string | null },
  ) {
    const order: any = await (this.prisma as any).order.findUnique({ where: { wcOrderId } });
    if (!order) throw new NotFoundException('Pedido não encontrado');

    let atual: any = {};
    try { atual = JSON.parse(order.shippingAddress || '{}'); } catch { /* snapshot cru */ }
    const antes = lerComplementoBairroWc(atual);

    const limpo = (v?: string, max = 120) => String(v ?? '').trim().slice(0, max) || '';
    const cep = String(input.cep ?? atual.postcode ?? '').replace(/\D/g, '');
    const endereco = limpo(input.endereco ?? atual.address_1_rua ?? '');
    const numero = limpo(input.numero ?? atual.number ?? '', 20);
    const complemento = limpo(input.complemento ?? antes.complemento, 80);
    const bairro = limpo(input.bairro ?? antes.bairro, 80);
    const cidade = limpo(input.cidade ?? atual.city ?? '', 80);
    const uf = limpo(input.uf ?? atual.state ?? '', 2).toUpperCase();

    // `address_1` continua sendo "rua, número" porque os cards da loja e a
    // impressão mostram esse texto pronto — mas `number` vai junto, separado,
    // que é o que a etiqueta prefere ler.
    const novo = {
      ...atual,
      ...(input.nome !== undefined
        ? (() => {
            const p = limpo(input.nome).split(/\s+/);
            return { first_name: p[0] || '', last_name: p.slice(1).join(' ') };
          })()
        : {}),
      ...(input.telefone !== undefined ? { phone: String(input.telefone).replace(/\D/g, '') } : {}),
      address_1: [endereco, numero].filter(Boolean).join(', '),
      ...montarComplementoBairroWc(complemento, bairro),
      ...montarNumeroWc(numero),
      city: cidade,
      state: uf,
      postcode: cep,
    };

    const mudancas = ([
      ['cep', atual.postcode, cep],
      ['endereco', atual.address_1, novo.address_1],
      ['complemento', antes.complemento, complemento],
      ['bairro', antes.bairro, bairro],
      ['cidade', atual.city, cidade],
      ['uf', atual.state, uf],
    ] as Array<[string, any, any]>)
      .filter(([, de, para]) => String(de ?? '').trim() !== String(para ?? '').trim())
      .map(([campo, de, para]) => ({ campo, de: de ?? null, para: para ?? null }));

    // NOME vai também em `customerName` — é dele que a etiqueta, o push
    // "Pedido novo" e a NF-e leem (17/08: ON-000009 saiu "Cliente" e o modal
    // não tinha como corrigir; gravar só no JSON do endereço não mudava nada).
    const nomeNovo = input.nome !== undefined ? limpo(input.nome) : undefined;
    if (nomeNovo !== undefined && String(order.customerName ?? '').trim() !== nomeNovo) {
      mudancas.push({ campo: 'nome', de: order.customerName ?? null, para: nomeNovo || null });
    }

    const atualizado = await (this.prisma as any).order.update({
      where: { wcOrderId },
      data: {
        shippingAddress: JSON.stringify(novo),
        shippingCep: cep || null,
        ...(nomeNovo ? { customerName: nomeNovo } : {}),
      },
    });

    // Espelho no cadastro do cliente — casa pelo CPF, que é a chave de pessoa
    // do CRM. Sem CPF não dá pra saber de quem é: grava só no pedido.
    const cpf = String(order.customerCpf || '').replace(/\D/g, '');
    if (cpf.length === 11 && (cep || endereco || cidade)) {
      try {
        const cliente = await (this.prisma as any).customer.findFirst({ where: { cpf } });
        if (cliente) {
          const dados = {
            cep: cep || null, street: endereco || null, number: numero || null,
            complement: complemento || null, district: bairro || null,
            city: cidade || null, state: uf || null,
          };
          const existente = await (this.prisma as any).customerAddress.findFirst({
            where: { customerId: cliente.id },
          });
          if (existente) {
            await (this.prisma as any).customerAddress.update({ where: { id: existente.id }, data: dados });
          } else {
            await (this.prisma as any).customerAddress.create({
              data: { customerId: cliente.id, type: 'entrega', isPrimary: true, ...dados },
            });
          }
        }
      } catch (e) {
        // Falha no espelho NÃO derruba a correção: o pedido — que é o que vai
        // virar etiqueta agora — já está salvo.
        this.logger.warn(`[endereco] espelho no cadastro falhou (pedido ${wcOrderId}): ${(e as Error).message}`);
      }
    }

    if (mudancas.length) {
      await (this.prisma as any).integrationLog.create({
        data: {
          source: 'orders', direction: 'internal', event: 'order.address.edit',
          payload: JSON.stringify({
            wcOrderId,
            por: { userId: actor?.userId ?? null, nome: actor?.name ?? null, loja: actor?.storeCode ?? null },
            mudancas,
          }),
        },
      }).catch((e: any) => this.logger.warn(`[endereco] auditoria falhou (${wcOrderId}): ${e?.message || e}`));
    }

    this.logger.log(
      `[endereco] pedido ${wcOrderId} corrigido por ${actor?.name ?? 'sistema'}: ` +
      (mudancas.map((m) => m.campo).join(', ') || 'sem mudança'),
    );

    return { ok: true, shipping: novo, mudancas, orderId: atualizado.id };
  }

  /**
   * CORRIGE OS DADOS DA CLIENTE no pedido — CPF, e-mail e WhatsApp.
   *
   * Irmão do `atualizarEnderecoEntrega` logo acima, pela mesma razão de
   * existir: o pedido carrega um SNAPSHOT desses campos e é dele que tudo lê
   * (aviso de WhatsApp, e-mail de status, NF-e, crédito de peça faltante —
   * que recusa pedido sem CPF). Não havia como corrigir: telefone gravado
   * "55119595822" (o +55 colado no checkout engolia os últimos dígitos)
   * ficava errado pra sempre e o aviso ia pro nada.
   *
   * Contrato: campo NÃO enviado não muda; enviado vazio LIMPA (CPF de outra
   * pessoa é pior que pedido sem CPF). Valor enviado é validado de verdade —
   * CPF com dígito verificador, telefone com DDD. O DDI 55 é removido aqui
   * (`localBrPhone`), então colar "+55 11 9…" inteiro conserta em vez de
   * quebrar.
   *
   * NÃO espelha no cadastro do cliente de propósito: o CRM casa pessoa por
   * CPF/telefone — se o que está sendo corrigido É a chave, o espelho
   * atualizaria a ficha de outra pessoa.
   */
  async atualizarDadosCliente(
    wcOrderId: number,
    input: { cpf?: string; email?: string; telefone?: string },
    actor?: { userId?: string | null; name?: string | null; storeCode?: string | null },
  ) {
    const order: any = await (this.prisma as any).order.findUnique({ where: { wcOrderId } });
    if (!order) throw new NotFoundException('Pedido não encontrado');

    const data: Record<string, any> = {};
    const mudancas: Array<{ campo: string; de: string | null; para: string | null }> = [];
    const registrar = (campo: string, de: any, para: string | null) => {
      if (String(de ?? '').trim() === String(para ?? '')) return;
      mudancas.push({ campo, de: de ?? null, para });
    };

    if (input.cpf !== undefined) {
      const cpf = String(input.cpf).replace(/\D/g, '');
      if (cpf && !cpfValido(cpf)) {
        throw new BadRequestException('CPF inválido — confira os dígitos (o verificador não bate).');
      }
      registrar('cpf', order.customerCpf, cpf || null);
      data.customerCpf = cpf || null;
    }

    if (input.email !== undefined) {
      const email = String(input.email).trim();
      if (email && !emailOk(email)) {
        throw new BadRequestException('E-mail inválido — é pra lá que vai o aviso do pedido.');
      }
      registrar('email', order.customerEmail, email || null);
      data.customerEmail = email || null;
    }

    if (input.telefone !== undefined) {
      const tel = localBrPhone(input.telefone);
      if (tel && !localBrPhoneValido(tel)) {
        throw new BadRequestException(
          'Telefone inválido — precisa de DDD + número (celular tem 11 dígitos com o 9 na frente). ' +
            'Se veio com +55, confira se não faltou dígito no FIM do número.',
        );
      }
      registrar('telefone', order.customerPhone, tel || null);
      data.customerPhone = tel || null;

      // O telefone também vive no snapshot do endereço — é de lá que a
      // etiqueta e a pré-postagem dos Correios leem o contato.
      try {
        const ship = JSON.parse(order.shippingAddress || '{}');
        ship.phone = tel;
        data.shippingAddress = JSON.stringify(ship);
      } catch {
        /* snapshot cru — o campo do pedido já foi corrigido */
      }
    }

    if (!mudancas.length) {
      return {
        ok: true,
        mudancas: [],
        customerCpf: order.customerCpf || '',
        billing: { email: order.customerEmail || '', phone: order.customerPhone || '' },
      };
    }

    const atualizado = await (this.prisma as any).order.update({ where: { wcOrderId }, data });

    await (this.prisma as any).integrationLog
      .create({
        data: {
          source: 'orders', direction: 'internal', event: 'order.customer.edit',
          payload: JSON.stringify({
            wcOrderId,
            por: { userId: actor?.userId ?? null, nome: actor?.name ?? null, loja: actor?.storeCode ?? null },
            mudancas,
          }),
        },
      })
      .catch((e: any) => this.logger.warn(`[dados-cliente] auditoria falhou (${wcOrderId}): ${e?.message || e}`));

    this.logger.log(
      `[dados-cliente] pedido ${wcOrderId} corrigido por ${actor?.name ?? 'sistema'}: ` +
        mudancas.map((m) => m.campo).join(', '),
    );

    return {
      ok: true,
      mudancas,
      customerCpf: atualizado.customerCpf || '',
      billing: { email: atualizado.customerEmail || '', phone: atualizado.customerPhone || '' },
    };
  }
}
