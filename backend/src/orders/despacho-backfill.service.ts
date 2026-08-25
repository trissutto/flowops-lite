import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * DE ONDE VEM O `shippedAt` DOS PEDIDOS QUE JÁ ESTAVAM DESPACHADOS (25/08/2026).
 *
 * A coluna nasceu hoje. Sem preencher o passado, todo pedido antigo cairia no
 * plano B (`updatedAt`) — que é exatamente o defeito que ela veio matar: o dono
 * atribuiu a vendedora a um pedido concluído e ele **voltou pra "Em trânsito"**,
 * porque tocar a linha carimba `updatedAt` com agora.
 *
 * A arqueologia, em ordem de confiança:
 *   1. `order_history.to_status = 'shipped'` — o registro EXPLÍCITO do
 *      despacho, escrito pelos três caminhos que fecham o pedido (card da loja,
 *      venda online fechada na vendedora, status aplicado pela matriz). Como
 *      pedido dividido gera uma linha por caixa, o MAX é quando a última saiu —
 *      que é quando o pedido virou `shipped` de fato.
 *   2. `pick_orders.updated_at` do card despachado — pro pedido cujo histórico
 *      se perdeu. Vale porque card quase não é tocado depois de enviado.
 *   3. `orders.updated_at` — último recurso, o mesmo palpite de antes. Só sobra
 *      pra pedido sem histórico E sem card.
 *
 * Rodar isto CONGELA a classificação de hoje: daqui pra frente nenhuma edição
 * na linha muda de aba um pedido que já saiu.
 *
 * Idempotente por construção (`shipped_at IS NULL`): no segundo boot acha zero
 * linha e não faz nada. Nunca derruba a subida — se a coluna ainda não existe
 * (push do Prisma falhou), loga e segue; a leitura tem o plano B.
 */
@Injectable()
export class DespachoBackfillService implements OnModuleInit {
  private readonly logger = new Logger(DespachoBackfillService.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Não segura o boot: a API sobe e o backfill acontece atrás.
    setTimeout(() => void this.preencher(), 5_000).unref?.();
  }

  async preencher(): Promise<number> {
    try {
      const linhas = await this.prisma.$executeRawUnsafe(`
        UPDATE orders o
           SET shipped_at = COALESCE(
                 (SELECT MAX(h.created_at) FROM order_history h
                   WHERE h.order_id = o.id AND h.to_status = 'shipped'),
                 (SELECT MAX(p.updated_at) FROM pick_orders p
                   WHERE p.order_id = o.id AND p.status = 'shipped'),
                 o.updated_at
               )
         WHERE o.shipped_at IS NULL
           AND o.status IN ('shipped', 'delivered')
      `);
      if (linhas > 0) {
        this.logger.log(
          `[despacho-backfill] ${linhas} pedido(s) ganharam carimbo de despacho ` +
            `(shipped_at) — "Em trânsito" e "Concluídos" param de depender do updatedAt.`,
        );
      }
      return Number(linhas) || 0;
    } catch (e: any) {
      this.logger.warn(
        `[despacho-backfill] não rodou (${e?.message || e}) — a leitura cai no ` +
          `plano B (updatedAt) até a próxima subida.`,
      );
      return 0;
    }
  }
}
