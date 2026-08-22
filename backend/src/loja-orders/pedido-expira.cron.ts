import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * PEDIDO QUE NUNCA FOI PAGO VIRA CANCELADO (dono, 22/08/2026).
 *
 * Regra dele, literal: "após 5 dias os pedidos em aguardando pagamento viram
 * CANCELADOS (falta de pagamento)".
 *
 * O que motivou: investigando o checkout recusando PIX em loop, a varredura
 * mostrou 17 pedidos parados em `awaiting_payment` — 8 deles com mais de 5
 * dias, o mais antigo de 03/08. Pedido que fica "aguardando" pra sempre suja
 * a lista, o relatório e a leitura de quem abre a tela: um pedido de duas
 * semanas atrás continua parecendo que pode pagar a qualquer momento.
 *
 * ⚠️ ISTO NÃO LIBERA ESTOQUE, e é de propósito. `awaiting_payment` NUNCA
 * reservou peça: `CarrinhoGuardService.HORAS_PENDENTE = 0` tira o não-pago da
 * conta por decisão do dono ("perder venda todo dia é venda perdida CERTA;
 * venda dupla tem conserto"). Quem prendia estoque era pedido PAGO parado em
 * `separating` — e nesse a ordem foi clara: **não mexer**. O conserto de lá é
 * o teto de idade da reserva no guard, que não altera pedido nenhum.
 *
 * Regras que não se negociam:
 *  - Só `awaiting_payment` com `paidAt` nulo. Pedido pago não é tocado, nunca.
 *  - RECHECA `paidAt` no `updateMany` (a condição vai no WHERE, não só na
 *    busca): entre achar e cancelar cabe um webhook de pagamento, e cancelar
 *    pedido que acabou de ser pago é o pior erro possível aqui.
 *  - Só `source: 'ecommerce'`. Pedido do WooCommerce tem dono lá fora e o
 *    Flow é espelho; `pdv_online` é venda de loja, que a vendedora fecha na
 *    mão. Cancelar pedido de outra origem seria decidir por sistema alheio.
 *  - `cancelledAt` carimbado junto — sem data, ninguém sabe se o cancelamento
 *    foi da cliente, da loja ou deste cron.
 *
 * Kill-switch: `PEDIDO_EXPIRA=0`. Ajuste: `PEDIDO_EXPIRA_DIAS` (default 5).
 */
@Injectable()
export class PedidoExpiraCron {
  private readonly logger = new Logger(PedidoExpiraCron.name);

  private rodando = false;

  /**
   * Teto por ciclo. A fila normal é de unidades por semana; um número alto só
   * apareceria em backlog histórico, e aí é melhor drenar em vários ciclos do
   * que dar um UPDATE gigante de uma vez.
   */
  private static readonly MAX_POR_CICLO = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get ligado(): boolean {
    return String(this.config.get<string>('PEDIDO_EXPIRA') ?? '1') !== '0';
  }

  /**
   * Piso de 1 dia: cancelar em horas mataria o PIX de 24h ainda válido — a
   * cliente que gera o código à noite e paga de manhã é caso normal, não
   * abandono.
   */
  private get dias(): number {
    const n = Number(this.config.get<string>('PEDIDO_EXPIRA_DIAS'));
    return Number.isFinite(n) && n >= 1 ? n : 5;
  }

  /** 04:10 — fora do horário de loja e depois da virada do dia. */
  @Cron('0 10 4 * * *')
  async ciclo(): Promise<void> {
    if (!this.ligado || this.rodando) return;
    this.rodando = true;
    try {
      await this.varrer();
    } catch (e: any) {
      this.logger.warn(`[pedido-expira] ciclo falhou: ${e?.message ?? e}`);
    } finally {
      this.rodando = false;
    }
  }

  private async varrer(): Promise<void> {
    const dias = this.dias;
    const limite = new Date(Date.now() - dias * 86_400_000);

    const alvos = await (this.prisma as any).order.findMany({
      where: {
        source: 'ecommerce',
        status: 'awaiting_payment',
        paidAt: null,
        createdAt: { lt: limite },
      },
      select: { id: true, wcOrderNumber: true, createdAt: true, totalAmount: true },
      orderBy: { createdAt: 'asc' },
      take: PedidoExpiraCron.MAX_POR_CICLO,
    });

    if (!alvos.length) return;

    /**
     * O `paidAt: null` e o `status` vão DE NOVO no where do update, não só na
     * busca acima. Entre o `findMany` e este `updateMany` cabe o webhook da
     * Pagar.me: sem a recheca, um pedido pago nesse intervalo seria cancelado
     * com o dinheiro já na conta. O `updateMany` filtra no próprio UPDATE, que
     * é atômico — o pedido que pagou simplesmente não é afetado.
     */
    const r = await (this.prisma as any).order.updateMany({
      where: {
        id: { in: alvos.map((o: any) => o.id) },
        status: 'awaiting_payment',
        paidAt: null,
      },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    if (r.count) {
      const numeros = alvos.slice(0, 10).map((o: any) => o.wcOrderNumber ?? o.id).join(', ');
      this.logger.log(
        `[pedido-expira] ${r.count} pedido(s) cancelado(s) por falta de pagamento ` +
          `(>${dias} dias em awaiting_payment): ${numeros}${alvos.length > 10 ? '…' : ''}`,
      );
    }
    if (r.count !== alvos.length) {
      // Diferença = pedido que pagou entre a busca e o update. É bom sinal, e
      // vale registrar: silêncio aqui esconderia uma corrida de verdade.
      this.logger.log(
        `[pedido-expira] ${alvos.length - r.count} pedido(s) escaparam do cancelamento (pagaram no meio)`,
      );
    }
  }
}
