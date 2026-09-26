import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PickOrdersService } from './pick-orders.service';

/**
 * VARREDURA DO PEDIDO QUE JÁ SAIU E NINGUÉM FECHOU (26/09).
 *
 * O pedido só fechava no instante em que a ÚLTIMA caixa era postada pelo
 * `updateStatus`. Qualquer caminho que mudasse card ou peça por fora daquele
 * instante deixava o pedido `separating` pra sempre:
 *
 *   - o cron da postagem dos Correios marcava o card `shipped` com um usuário
 *     que não existe, o histórico estourava a FK e o fechamento nunca rodava
 *     (11 pedidos em 26/09, o mais velho com 33 dias — ON-000112);
 *   - a matriz cancelava a peça pendente com crédito e nada reavaliava;
 *   - o feeder da juntada virava `shipped` pelo cron da remessa.
 *
 * Enquanto preso, o pedido fica vermelho na fila, reserva estoque no checkout
 * por 15 dias (peça já postada descontada de novo) e nunca vira ENTREGUE (o
 * rastreio só promove `shipped`): prazo de troca e pós-venda não começam.
 *
 * Cada porta agora chama `tentarFecharPedido`; esta varredura é a rede de
 * segurança pra qualquer caminho novo que mude card sem passar por lá. O SQL
 * só ESCOLHE candidatos baratos (todos os cards postados, nenhum reporte
 * aberto); quem decide é a régua de peça pendente dentro de
 * `tentarFecharPedido` — pedido com peça sem dono continua aberto e visível.
 *
 * Só pedido do Flow (site novo, venda online do PDV, live): os "separando" do
 * WooCommerce antigo são história, não fila. Kill-switch:
 * `PEDIDO_FECHAMENTO_RECONCILE=0`.
 */
@Injectable()
export class PedidoFechamentoReconcileCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(PedidoFechamentoReconcileCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pickOrders: PickOrdersService,
  ) {}

  private get enabled(): boolean {
    return String(process.env.PEDIDO_FECHAMENTO_RECONCILE ?? '1').trim() !== '0';
  }

  /** Primeira rodada 90s depois do boot — o app já está servindo e não disputa a subida. */
  onApplicationBootstrap() {
    const t = setTimeout(() => void this.run(), 90_000);
    (t as any).unref?.();
  }

  @Cron('*/10 * * * *', { name: 'pedido-fechamento-reconcile' })
  async run(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const candidatos: Array<{ id: string; num: string | null }> = await this.prisma.$queryRaw`
        SELECT o.id, o.wc_order_number AS num
          FROM orders o
         WHERE o.status NOT IN ('shipped', 'delivered', 'cancelled')
           AND o.source IN ('live', 'ecommerce', 'pdv_online')
           AND EXISTS (SELECT 1 FROM pick_orders p WHERE p.order_id = o.id)
           AND NOT EXISTS (
                 SELECT 1 FROM pick_orders p
                  WHERE p.order_id = o.id AND p.status NOT IN ('shipped', 'delivered', 'cancelled'))
           AND NOT EXISTS (
                 SELECT 1 FROM pick_order_item_reports r
                  WHERE r.order_id = o.id AND r.resolved_at IS NULL)
           -- quem acabou de ser tocado pode estar no meio de um updateStatus
           AND o.updated_at < now() - interval '2 minutes'
         ORDER BY o.created_at
         LIMIT 50`;
      if (!candidatos.length) return;

      let fechados = 0;
      const presos: string[] = [];
      for (const c of candidatos) {
        try {
          const r = await this.pickOrders.tentarFecharPedido(c.id, { origem: 'varredura de fechamento' });
          if (r.fechou) fechados++;
          else presos.push(`${c.num || c.id}: ${r.motivo}`);
        } catch (e: any) {
          this.logger.warn(`[fechamento] ${c.num || c.id}: ${e?.message || e}`);
        }
      }
      this.logger.log(
        `[fechamento] ${fechados}/${candidatos.length} pedido(s) com tudo postado fechado(s)` +
          (presos.length ? ` · seguem abertos: ${presos.slice(0, 8).join(' · ')}${presos.length > 8 ? ' …' : ''}` : ''),
      );
    } catch (e: any) {
      this.logger.error(`[fechamento] varredura falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }
}
