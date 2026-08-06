import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PagarmeService } from '../pagarme/pagarme.service';
import { LojaOrdersService } from './loja-orders.service';

/**
 * PAGAMENTO DO SITE — o webhook não pode ser a única confirmação (itens 11 e
 * 12 da lista de lançamento).
 *
 * O buraco, medido no código em 06/08: quando o webhook da Pagar.me não chega
 * (rede, retry esgotado, deploy no meio do caminho, assinatura recusada), o
 * pedido do site fica em `awaiting_payment` PARA SEMPRE. A cliente pagou o
 * PIX, tem o comprovante na mão — e o pedido nunca cai na fila de separação.
 *
 * Existia um reconcile pro LINK das lojas (`PagarmeReconcileService`, 31/07),
 * mas ele para no meio do caminho pro site: consulta o gateway, grava
 * `pagarme_payment.status = 'paid'` e **não chama o `confirmarPagamento` do
 * pedido**. Resultado: o pagamento consta como pago no Flow e o Order continua
 * aguardando. Este serviço fecha os dois lados.
 *
 * DUAS FRENTES, propositalmente separadas:
 *
 *  1. **Reconcile (1 min)** — pedido aguardando pagamento vira pedido pago.
 *     Barato: primeiro olha o `pagarme_payment` local (o webhook pode ter
 *     gravado o status sem que o gancho do pedido rodasse); só quem continua
 *     pendente vira consulta ao gateway, com throttle por pedido.
 *
 *  2. **Conciliação (diária)** — bate pago no GATEWAY × pago no FLOW e grita
 *     o que não fecha. O reconcile conserta o que sabe consertar; a
 *     conciliação é quem descobre o que ninguém viu — inclusive o contrário
 *     (pedido pago no Flow sem cobrança correspondente).
 *
 * Cuidados iguais aos do reconcile das lojas: guard de overlap, teto por
 * ciclo, janela curta e throttle. Nunca martelar a API da Pagar.me.
 */
@Injectable()
export class LojaPagamentoReconcileService {
  private readonly logger = new Logger(LojaPagamentoReconcileService.name);

  private rodando = false;
  /** Última consulta AO VIVO por pedido — o passo local roda sempre. */
  private ultimaConsulta = new Map<string, number>();

  /** PIX vale 2h; 72h cobre o pagamento tardio e o webhook que voltou atrasado. */
  private static readonly JANELA_H = 72;
  private static readonly MAX_POR_CICLO = 40;
  /** Consulta ao vivo no máximo 1×/3min por pedido. */
  private static readonly THROTTLE_MS = 180_000;
  /** Antes disso o webhook ainda é o caminho normal — não vale gastar consulta. */
  private static readonly IDADE_MINIMA_MS = 90_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pagarme: PagarmeService,
    private readonly orders: LojaOrdersService,
  ) {}

  /* ───────────────────────────── RECONCILE ─────────────────────────────── */

  @Cron('*/60 * * * * *')
  async reconciliar(): Promise<void> {
    if (process.env.LOJA_PAGAMENTO_RECONCILE === '0') return;
    if (this.rodando) return;
    this.rodando = true;

    try {
      const desde = new Date(Date.now() - LojaPagamentoReconcileService.JANELA_H * 3600_000);
      const pendentes: any[] = await (this.prisma as any).order
        .findMany({
          where: {
            source: 'ecommerce',
            status: 'awaiting_payment',
            paidAt: null,
            createdAt: { gte: desde },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: { id: true, wcOrderNumber: true, createdAt: true },
        })
        .catch(() => []);
      if (!pendentes.length) return;

      const agora = Date.now();
      let confirmados = 0;
      let consultados = 0;

      for (const o of pendentes) {
        if (consultados >= LojaPagamentoReconcileService.MAX_POR_CICLO) break;
        // Pedido recém-criado: o webhook ainda é o caminho esperado.
        if (agora - new Date(o.createdAt).getTime() < LojaPagamentoReconcileService.IDADE_MINIMA_MS) {
          continue;
        }

        // PASSO 1 — o banco local já sabe? (webhook gravou o pagamento mas o
        // gancho do pedido não rodou). De graça, e é o caso mais comum.
        const pagamento = await (this.prisma as any).pagarmePayment
          .findFirst({
            where: { saleId: o.id },
            orderBy: { createdAt: 'desc' },
            select: { pagarmeOrderId: true, status: true },
          })
          .catch(() => null);

        if (pagamento?.status === 'paid') {
          if (await this.confirmar(o, 'pagamento local já constava pago')) confirmados++;
          continue;
        }

        // PASSO 2 — perguntar ao gateway, com throttle.
        if (!pagamento?.pagarmeOrderId) continue;
        const ultima = this.ultimaConsulta.get(o.id) || 0;
        if (agora - ultima < LojaPagamentoReconcileService.THROTTLE_MS) continue;
        this.ultimaConsulta.set(o.id, agora);
        consultados++;

        try {
          // `checkOrderStatus` já persiste o status novo no PagarmePayment.
          const r: any = await this.pagarme.checkOrderStatus(pagamento.pagarmeOrderId);
          if (String(r?.status || '').toLowerCase() !== 'paid') continue;
          if (await this.confirmar(o, 'gateway confirmou fora do webhook')) confirmados++;
        } catch (e: any) {
          // Pedido some do gateway, rede cai: não derruba o ciclo.
          this.logger.warn(`[loja-reconcile] consulta falhou (${o.wcOrderNumber}): ${e?.message || e}`);
        }
      }

      if (confirmados) {
        this.logger.log(
          `[loja-reconcile] ${confirmados} pedido(s) confirmado(s) fora do webhook · ${consultados} consulta(s) ao gateway`,
        );
      }
      if (this.ultimaConsulta.size > 2000) this.ultimaConsulta.clear();
    } finally {
      this.rodando = false;
    }
  }

  /** Confirma pelo caminho idempotente de sempre. `already` não conta. */
  private async confirmar(order: any, motivo: string): Promise<boolean> {
    try {
      const r = await this.orders.confirmarPagamento(order.id);
      if (r.ok && !r.already) {
        this.logger.warn(
          `[loja-reconcile] pedido ${order.wcOrderNumber} estava PAGO e parado — ${motivo}. Liberado pra separação.`,
        );
        return true;
      }
    } catch (e: any) {
      this.logger.error(`[loja-reconcile] falha ao confirmar ${order.wcOrderNumber}: ${e?.message || e}`);
    }
    return false;
  }

  /* ─────────────────── PEDIDO PAGO E PARADO (item 75) ──────────────────── */

  /**
   * O dinheiro entrou e o pedido não andou.
   *
   * O reconcile acima cuida do pedido que ficou preso ANTES do pagamento. Este
   * cuida do contrário, que é pior: pagou, virou `processing`, caiu na fila da
   * retaguarda — e ficou lá. Ninguém roteou, ninguém separou. O sistema está
   * "funcionando": o pedido tem status válido, sem erro em log nenhum. Só que
   * a cliente está esperando.
   *
   * Não conserta nada de propósito. Roteamento é decisão da matriz, e um cron
   * escolhendo loja sozinho é pior que o pedido parado. O que ele faz é
   * GRITAR — que é exatamente o que faltava pro item 111 (a pessoa nomeada pra
   * olhar todo dia) ter o que olhar.
   *
   * Roda de hora em hora: é problema de horas, não de segundos, e alarme a
   * cada minuto vira alarme que ninguém lê.
   */
  @Cron('0 15 * * * *')
  async alertarPedidoParado(): Promise<void> {
    if (process.env.LOJA_ALERTA_PARADO === '0') return;

    const horas = Math.max(1, Number(process.env.LOJA_ALERTA_PARADO_HORAS) || 4);
    const limite = new Date(Date.now() - horas * 3600_000);
    // Janela de 7 dias: mais velho que isso não é "parou hoje", é backlog —
    // e repetir a mesma lista pra sempre é o que faz o alerta virar ruído.
    const desde = new Date(Date.now() - 7 * 24 * 3600_000);

    const parados: any[] = await (this.prisma as any).order
      .findMany({
        where: {
          source: 'ecommerce',
          paidAt: { not: null, lt: limite, gte: desde },
          // `processing` = pago e aguardando roteamento. Quem já andou saiu
          // deste status; quem cancelou também.
          status: 'processing',
        },
        orderBy: { paidAt: 'asc' },
        take: 100,
        select: { wcOrderNumber: true, paidAt: true, totalAmount: true, isPickup: true },
      })
      .catch(() => []);

    if (!parados.length) return;

    const total = parados.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0);
    const maisAntigo = parados[0];
    const horasParado = Math.floor((Date.now() - new Date(maisAntigo.paidAt).getTime()) / 3600_000);

    this.logger.warn(
      `[loja-parado] ${parados.length} pedido(s) PAGO(S) e sem andar há mais de ${horas}h ` +
        `(R$ ${total.toFixed(2)} no total). O mais antigo é o ${maisAntigo.wcOrderNumber}, parado há ${horasParado}h. ` +
        `Números: ${parados.slice(0, 25).map((o) => o.wcOrderNumber).join(', ')}` +
        (parados.length > 25 ? ` … +${parados.length - 25}` : ''),
    );
  }

  /**
   * A mesma lista, sob demanda — é o que a tela da retaguarda mostra pra quem
   * é o responsável do dia (item 111).
   */
  async pedidosParados(horas = 4) {
    const limite = new Date(Date.now() - Math.max(1, horas) * 3600_000);
    const desde = new Date(Date.now() - 7 * 24 * 3600_000);

    const parados: any[] = await (this.prisma as any).order.findMany({
      where: {
        source: 'ecommerce',
        paidAt: { not: null, lt: limite, gte: desde },
        status: 'processing',
      },
      orderBy: { paidAt: 'asc' },
      take: 200,
      select: {
        id: true,
        wcOrderNumber: true,
        paidAt: true,
        totalAmount: true,
        customerName: true,
        shippingCep: true,
        isPickup: true,
        pickupStoreCode: true,
      },
    });

    return {
      horas,
      total: parados.length,
      valor: Math.round(parados.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0) * 100) / 100,
      pedidos: parados.map((o) => ({
        ...o,
        horasParado: Math.floor((Date.now() - new Date(o.paidAt).getTime()) / 3600_000),
      })),
    };
  }

  /* ──────────────────────────── CONCILIAÇÃO ────────────────────────────── */

  /**
   * 07h05 — depois do movimento da madrugada e antes de a loja abrir, pra
   * quem for olhar já achar o relatório pronto.
   */
  @Cron('0 5 7 * * *')
  async conciliacaoDiaria(): Promise<void> {
    if (process.env.LOJA_CONCILIACAO === '0') return;

    const fim = new Date();
    fim.setHours(0, 0, 0, 0);
    const inicio = new Date(fim.getTime() - 24 * 3600_000);

    const r = await this.conciliar(inicio, fim).catch((e) => {
      this.logger.error(`[loja-conciliacao] falhou: ${e?.message || e}`);
      return null;
    });
    if (!r) return;

    const dia = inicio.toISOString().slice(0, 10);
    if (!r.divergencias.length) {
      this.logger.log(
        `[loja-conciliacao] ${dia}: ${r.resumo.pedidosPagos} pedido(s) pago(s), R$ ${r.resumo.totalFlow.toFixed(2)} — bate com o gateway ✔`,
      );
      return;
    }

    // WARN, não LOG: divergência de dinheiro tem que aparecer em qualquer
    // filtro de log que alguém use.
    this.logger.warn(
      `[loja-conciliacao] ${dia}: ${r.divergencias.length} DIVERGÊNCIA(S) — ` +
        r.divergencias
          .slice(0, 20)
          .map((d) => `${d.pedido || d.pagarmeOrderId}: ${d.tipo}`)
          .join(' · '),
    );
  }

  /**
   * Compara, no período, o que o GATEWAY diz que recebeu com o que o FLOW diz
   * que está pago. Três divergências possíveis, e cada uma dói de um jeito:
   *
   *  - `pago_no_gateway_nao_no_flow` → a cliente pagou e ninguém separou.
   *    É a pior: tem dinheiro na conta e pedido parado.
   *  - `pago_no_flow_sem_cobranca`   → pedido liberado sem cobrança
   *    correspondente. Ou é confirmação manual, ou é peça saindo de graça.
   *  - `valor_divergente`            → cobrou diferente do pedido.
   *
   * Não escreve nada: é leitura pura, pra rodar sob demanda na retaguarda ou
   * pelo cron sem medo de efeito colateral.
   */
  async conciliar(inicio: Date, fim: Date) {
    const pedidos: any[] = await (this.prisma as any).order.findMany({
      where: { source: 'ecommerce', createdAt: { gte: inicio, lt: fim } },
      select: {
        id: true,
        wcOrderNumber: true,
        status: true,
        paidAt: true,
        totalAmount: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const ids = pedidos.map((p) => p.id);
    const pagamentos: any[] = ids.length
      ? await (this.prisma as any).pagarmePayment.findMany({
          where: { saleId: { in: ids } },
          select: {
            saleId: true,
            pagarmeOrderId: true,
            status: true,
            valor: true,
            paidAt: true,
            method: true,
          },
        })
      : [];

    // Um pedido pode ter mais de uma tentativa de cobrança (cartão recusado e
    // depois PIX): vale a PAGA; sem nenhuma paga, a mais recente.
    const porPedido = new Map<string, any>();
    for (const p of pagamentos) {
      const atual = porPedido.get(p.saleId);
      if (!atual || (p.status === 'paid' && atual.status !== 'paid')) porPedido.set(p.saleId, p);
    }

    const divergencias: Array<{
      tipo: string;
      pedido: string | null;
      pagarmeOrderId: string | null;
      detalhe: string;
    }> = [];

    let pedidosPagos = 0;
    let totalFlow = 0;
    let totalGateway = 0;

    for (const o of pedidos) {
      const pg = porPedido.get(o.id);
      const pagoNoFlow = !!o.paidAt;
      const pagoNoGateway = pg?.status === 'paid';

      if (pagoNoFlow) {
        pedidosPagos++;
        totalFlow += Number(o.totalAmount) || 0;
      }
      if (pagoNoGateway) totalGateway += Number(pg.valor) || 0;

      if (pagoNoGateway && !pagoNoFlow) {
        divergencias.push({
          tipo: 'pago_no_gateway_nao_no_flow',
          pedido: o.wcOrderNumber,
          pagarmeOrderId: pg.pagarmeOrderId ?? null,
          detalhe: `gateway pagou R$ ${Number(pg.valor).toFixed(2)} em ${pg.paidAt?.toISOString?.() ?? '?'} e o pedido segue ${o.status}`,
        });
        continue;
      }
      if (pagoNoFlow && !pagoNoGateway) {
        divergencias.push({
          tipo: 'pago_no_flow_sem_cobranca',
          pedido: o.wcOrderNumber,
          pagarmeOrderId: pg?.pagarmeOrderId ?? null,
          detalhe: pg
            ? `cobrança existe com status "${pg.status}" mas o pedido consta pago`
            : 'pedido consta pago e não há cobrança registrada',
        });
        continue;
      }
      if (pagoNoFlow && pagoNoGateway) {
        const dif = Math.abs(Number(pg.valor) - Number(o.totalAmount));
        if (dif > 0.011) {
          divergencias.push({
            tipo: 'valor_divergente',
            pedido: o.wcOrderNumber,
            pagarmeOrderId: pg.pagarmeOrderId ?? null,
            detalhe: `pedido R$ ${Number(o.totalAmount).toFixed(2)} × cobrança R$ ${Number(pg.valor).toFixed(2)}`,
          });
        }
      }
    }

    return {
      periodo: { inicio: inicio.toISOString(), fim: fim.toISOString() },
      resumo: {
        pedidos: pedidos.length,
        pedidosPagos,
        totalFlow: Math.round(totalFlow * 100) / 100,
        totalGateway: Math.round(totalGateway * 100) / 100,
        diferenca: Math.round((totalFlow - totalGateway) * 100) / 100,
      },
      divergencias,
    };
  }
}
