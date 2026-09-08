import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RoutingService } from './routing.service';
import { pedidoOnlineLiberado } from '../common/prova-pagamento';

/**
 * RE-ROTEAMENTO DO `awaiting_stock` (dono, 29/08 — sugestão nº 6).
 *
 * Pedido em ruptura ficava parado até ALGUÉM olhar — mas ruptura de rede é
 * quase sempre TEMPORÁRIA: a remessa dá entrada, o realinhamento cria a
 * peça, uma devolução volta pro estoque. Este cron re-tenta o roteamento
 * de tempos em tempos; quando a rede voltou a cobrir, o pedido vira card
 * sozinho (o confirmRoute já emite socket + push pras lojas).
 *
 * Seguro por construção:
 *  - `routeOrder` = previewRoute + confirmRoute — as MESMAS travas do fluxo
 *    manual valem (conferência de pagamento, troca pendente, idempotência
 *    de card ativo). Pedido travado só loga e fica pra próxima rodada.
 *  - Sem cobertura, o confirmRoute regrava `awaiting_stock` — estado igual,
 *    zero efeito colateral.
 *  - Teto por rodada + pedidos mais antigos primeiro.
 *
 * Desde 08/09 a mesma rodada também recolhe o PEDIDO PAGO "SEPARANDO" SEM
 * CARD (ver `reRotearSeparandoSemCard`).
 *
 * Kill-switch: ROUTING_RETRY_AWAITING=0.
 */
@Injectable()
export class AwaitingStockRetryCron {
  private readonly logger = new Logger(AwaitingStockRetryCron.name);
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
  ) {}

  @Cron('*/10 * * * *')
  async tick() {
    if (String(process.env.ROUTING_RETRY_AWAITING ?? '').trim() === '0') return;
    if (this.rodando) return; // guard de overlap — rodada longa não empilha
    this.rodando = true;
    try {
      await this.reRotearRuptura();
      await this.reRotearSeparandoSemCard();
    } finally {
      this.rodando = false;
    }
  }

  /** `awaiting_stock`: a rede voltou a cobrir? Vira card sozinho. */
  private async reRotearRuptura() {
    const pedidos: any[] = await this.prisma.order.findMany({
      where: { status: 'awaiting_stock' },
      select: {
        id: true, wcOrderNumber: true, source: true,
        vendaConferidaEm: true, checkoutInfo: true,
      } as any,
      orderBy: { updatedAt: 'asc' },
      take: 20,
    });
    if (!pedidos.length) return;
    let roteados = 0;
    for (const p of pedidos) {
      const r = await this.tentar(p, 'awaiting-retry');
      if (r === 'roteado') {
        roteados++;
        this.logger.log(
          `[awaiting-retry] pedido ${p.wcOrderNumber || p.id} SAIU da ruptura — roteado sozinho`,
        );
      }
    }
    if (roteados > 0) {
      this.logger.log(`[awaiting-retry] rodada: ${roteados}/${pedidos.length} pedido(s) destravados`);
    }
  }

  /**
   * PAGO, "SEPARANDO" E SEM CARD NENHUM (08/09 — LP-000311, LP-001042, ON-000004).
   *
   * Três jeitos de um pedido pago ficar sem loja olhando pra ele, todos com o
   * status parado em `separating`, que nenhuma tela lista como pendência:
   *  - "forçar loja"/swap criava o card SEM peça (chave `qty` × `quantity`) e a
   *    limpeza de cards vazios apagava no mesmo segundo (LP-000311, 28/08);
   *  - a retaguarda remove o card na mão e não roteia de novo (LP-001042,
   *    ON-000004);
   *  - o roteamento falha no meio.
   * A cliente descobre sozinha: o LP-000311 ficou 11 dias assim até ela
   * cobrar. Aqui o pedido volta pro motor: com estoque vira card (socket +
   * push pra loja); sem estoque vira `awaiting_stock`, que a rodada acima já
   * vigia. Só pedido do Flow (site novo e venda online do PDV) — os "separando"
   * do WooCommerce antigo (58 de maio a agosto) são história, não fila. E só
   * depois de 15 min sem ninguém mexer, pra não atropelar um operador no meio
   * de uma troca manual.
   */
  private async reRotearSeparandoSemCard() {
    const quietoDesde = new Date(Date.now() - 15 * 60 * 1000);
    const pedidos: any[] = await this.prisma.order.findMany({
      where: {
        status: 'separating',
        source: { in: ['ecommerce', 'pdv_online'] },
        paidAt: { not: null },
        updatedAt: { lt: quietoDesde },
        pickOrders: { none: {} },
        items: { some: { cancelledAt: null } },
      } as any,
      select: {
        id: true, wcOrderNumber: true, source: true,
        vendaConferidaEm: true, checkoutInfo: true, createdAt: true,
      } as any,
      orderBy: { updatedAt: 'asc' },
      take: 20,
    });
    if (!pedidos.length) return;
    for (const p of pedidos) {
      const dias = Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86_400_000);
      const r = await this.tentar(p, 'sem-card');
      if (r === 'roteado') {
        this.logger.warn(
          `[sem-card] pedido ${p.wcOrderNumber || p.id} estava PAGO e "separando" sem card nenhum ` +
            `há ${dias} dia(s) — voltou pro motor de roteamento`,
        );
      } else if (r === 'sem-estoque') {
        this.logger.warn(
          `[sem-card] pedido ${p.wcOrderNumber || p.id} estava PAGO e "separando" sem card há ${dias} dia(s) ` +
            `e a rede NÃO cobre as peças — virou awaiting_stock (vigiado a cada 10 min)`,
        );
      }
    }
  }

  /**
   * Uma tentativa de roteamento com as mesmas travas do fluxo manual. Pedido
   * que ainda não pode (pagamento sem prova, exceção do motor) só ganha um
   * toque no `updatedAt` pra ir pro fim da fila.
   */
  private async tentar(p: any, tag: string): Promise<'roteado' | 'sem-estoque' | 'adiado'> {
    try {
      if (!(await pedidoOnlineLiberado(this.prisma, p as any))) {
        await this.prisma.order.update({
          where: { id: p.id },
          data: { updatedAt: new Date() } as any,
        });
        return 'adiado';
      }
      const r: any = await this.routing.routeOrder(p.id);
      return r?.persisted ? 'roteado' : 'sem-estoque';
    } catch (e: any) {
      this.logger.debug(`[${tag}] ${p.wcOrderNumber || p.id} ainda não: ${e?.message || e}`);
      await this.prisma.order
        .update({ where: { id: p.id }, data: { updatedAt: new Date() } as any })
        .catch(() => null);
      return 'adiado';
    }
  }
}
