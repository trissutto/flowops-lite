import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CashbackService } from './cashback.service';

/**
 * A REDE DE SEGURANÇA DO SALDO CONSUMIDO.
 *
 * O cashback sai do ledger no momento em que a compra é montada — no PDV
 * quando a vendedora aplica, no site quando o pedido nasce. Se aquela compra
 * morre, o saldo tem que voltar; senão a cliente perde dinheiro por causa de
 * uma venda que nunca existiu, e ninguém fica sabendo.
 *
 * ── POR QUE UM CRON, SE OS CAMINHOS JÁ DEVOLVEM ──
 *
 * Porque são MUITOS caminhos, e a lista cresce. Hoje devolvem na hora: o
 * `removePayment` e o `cancel` do PDV, o estorno master, o `descartarPedido`
 * do checkout (cobrança que estourou) e o cron que expira pedido não pago. Mas
 * existem pelo menos outros dois — o PATCH de status da retaguarda e o delete
 * direto do pedido — e amanhã existirá um sétimo. Um cron que pergunta "este
 * uso ainda tem uma compra viva atrás?" cobre inclusive o caminho que ainda
 * não foi escrito.
 *
 * A devolução é **idempotente** (`estornadoEm`), então o cron e o caminho
 * imediato podem rodar os dois sobre o mesmo uso sem devolver em dobro. Quem
 * chegar segundo não acha linha pendente.
 *
 * ── A CARÊNCIA DE 30 MINUTOS EXISTE POR UM MOTIVO ──
 *
 * Entre consumir o saldo e o pedido aparecer no banco há uma janela de
 * milissegundos; e no PDV a venda fica `open` enquanto a cliente decide. Varrer
 * sem carência devolveria saldo de compra que está ACONTECENDO — a cliente
 * veria o desconto sumir do caixa na frente dela. Meia hora é folgado o
 * bastante pra nenhuma corrida entrar e curto o bastante pra ninguém ficar sem
 * o saldo por muito tempo.
 *
 * ⚠️ **Uso órfão devolve; uso sem resposta do banco NÃO.** Se a consulta
 * falhar, o ciclo sai sem fazer nada — a regra de ouro da casa é que fonte
 * muda vira erro honesto, nunca decisão. Devolver por engano aqui seria
 * creditar saldo em cima de venda boa.
 */
@Injectable()
export class CashbackDevolucaoCron {
  private readonly logger = new Logger(CashbackDevolucaoCron.name);

  /** Uso mais novo que isso não é varrido (ver a carência acima). */
  private static readonly CARENCIA_MIN = 30;
  /** Teto por ciclo: devolução é escrita, não vale travar o banco de hora em hora. */
  private static readonly LOTE = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cashback: CashbackService,
  ) {}

  @Cron('0 25 * * * *')
  async varrer(): Promise<{ devolvidos: number; total: number } | null> {
    const corte = new Date(Date.now() - CashbackDevolucaoCron.CARENCIA_MIN * 60_000);

    let orfaos: Array<{ sale_id: string; motivo: string }>;
    try {
      /**
       * Um uso é órfão quando a compra que ele abateu está CANCELADA ou não
       * existe mais em nenhuma das duas tabelas de venda.
       *
       * O `NOT EXISTS` duplo é o que impede o pior desfecho: se olhasse só
       * `orders`, todo uso de venda de PDV pareceria órfão e o cron devolveria
       * saldo de venda boa, todo dia, em silêncio.
       */
      orfaos = await (this.prisma as any).$queryRawUnsafe(
        `SELECT DISTINCT u.sale_id,
                CASE
                  WHEN o.id IS NOT NULL THEN 'pedido cancelado'
                  WHEN s.id IS NOT NULL THEN 'venda cancelada'
                  ELSE 'compra apagada'
                END AS motivo
           FROM cashback_usos u
           LEFT JOIN orders     o ON o.id = u.sale_id AND o.status = 'cancelled'
           LEFT JOIN pdv_sales  s ON s.id = u.sale_id AND s.status = 'cancelled'
          WHERE u.estornado_em IS NULL
            AND u.created_at < $1
            AND (
              o.id IS NOT NULL
              OR s.id IS NOT NULL
              OR (
                NOT EXISTS (SELECT 1 FROM orders    o2 WHERE o2.id = u.sale_id)
                AND NOT EXISTS (SELECT 1 FROM pdv_sales s2 WHERE s2.id = u.sale_id)
              )
            )
          LIMIT $2`,
        corte,
        CashbackDevolucaoCron.LOTE,
      );
    } catch (e: any) {
      // Erro SOBE como log e o ciclo NÃO devolve nada. Ver o aviso no topo.
      this.logger.error(`[cashback-devolucao] varredura falhou, nada devolvido: ${e?.message}`);
      return null;
    }

    if (!orfaos.length) return { devolvidos: 0, total: 0 };

    let devolvidos = 0;
    let total = 0;
    for (const o of orfaos) {
      const r = await this.cashback.estornarUso(String(o.sale_id), `rede de segurança — ${o.motivo}`);
      if (r.devolvido > 0) {
        devolvidos += 1;
        total = Math.round((total + r.devolvido) * 100) / 100;
      }
    }

    if (devolvidos > 0) {
      this.logger.warn(
        `[cashback-devolucao] ${devolvidos} compra(s) morta(s) ainda seguravam saldo — ` +
          `R$ ${total.toFixed(2)} devolvido(s) pras clientes`,
      );
    }
    return { devolvidos, total };
  }
}
