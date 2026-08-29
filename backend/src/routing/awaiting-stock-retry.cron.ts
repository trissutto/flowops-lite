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
      // `updatedAt asc` = fila que ROTACIONA: cada tentativa carimba o pedido
      // (o confirmRoute regrava awaiting_stock), então quem acabou de ser
      // tentado vai pro fim. Com `createdAt` os 20 mais velhos em ruptura
      // permanente monopolizariam toda rodada e os novos nunca seriam vistos.
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
        try {
          // Checagem BARATA antes da cara: pedido online sem conferência de
          // pagamento vai falhar no confirmRoute de qualquer jeito — pular
          // aqui poupa a leitura de estoque inteira.
          if (!(await pedidoOnlineLiberado(this.prisma, p as any))) {
            // Carimba pra rotacionar mesmo sem tentar (senão ele volta pro
            // topo da fila em toda rodada).
            await this.prisma.order.update({
              where: { id: p.id },
              data: { updatedAt: new Date() } as any,
            });
            continue;
          }
          const r: any = await this.routing.routeOrder(p.id);
          if (r?.persisted) {
            roteados++;
            this.logger.log(
              `[awaiting-retry] pedido ${p.wcOrderNumber || p.id} SAIU da ruptura — roteado sozinho`,
            );
          }
        } catch (e: any) {
          // Trava de conferência/troca ou erro pontual: fica pra próxima.
          this.logger.debug(
            `[awaiting-retry] ${p.wcOrderNumber || p.id} ainda não: ${e?.message || e}`,
          );
          // Carimba pra rotacionar: erro que estoura ANTES do confirmRoute
          // (troca pendente etc.) não regrava o pedido, e sem carimbo ele
          // voltaria pro topo da fila em toda rodada.
          await this.prisma.order
            .update({ where: { id: p.id }, data: { updatedAt: new Date() } as any })
            .catch(() => null);
        }
      }
      if (roteados > 0) {
        this.logger.log(`[awaiting-retry] rodada: ${roteados}/${pedidos.length} pedido(s) destravados`);
      }
    } finally {
      this.rodando = false;
    }
  }
}
