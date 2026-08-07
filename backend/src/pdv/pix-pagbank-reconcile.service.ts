import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PdvService } from './pdv.service';

/**
 * PIX PAGO QUE NINGUÉM FECHOU — a rede de segurança do PDV (dono 07/08).
 *
 * ── O PROBLEMA ──
 *
 * Venda de R$119,90 em Sorocaba: cliente pagou o PIX PagBank às 13:03, o
 * pagamento entrou na conta, e a venda ficou presa como "open" por horas.
 * Só apareceu porque a loja avisou. Motivo: quem fechava a venda era o
 * POLLING no navegador da vendedora — se a aba fechar, a rede cair ou o PDV
 * for trocado de máquina entre o cliente pagar e a tela confirmar, ninguém
 * mais fecha aquela venda. O dinheiro fica na conta e a venda não existe.
 *
 * O webhook do PagBank JÁ grava `pagbank_payments.status='paid'` — o dado
 * sempre esteve lá. O que faltava era alguém olhar.
 *
 * ── POR QUE UM CRON, E NÃO O WEBHOOK CHAMANDO O PDV ──
 *
 * A primeira tentativa foi o webhook chamar o PDV direto. Isso obrigou o
 * módulo do PagBank a importar o do PDV, fechando o ciclo
 * Pagbank→Pdv→Crediarios→Pagbank. O NestJS resolve módulos na INICIALIZAÇÃO:
 * o backend parou de subir e derrubou a operação inteira (07/08). Não era
 * bug de PIX — era o servidor não ligando.
 *
 * Aqui não existe dependência nova: este serviço mora no PdvModule (que já
 * tem o PdvService) e lê a tabela do PagBank pelo Prisma, que todo mundo já
 * usa. Mesmo padrão do `ErpOutboxService` ao lado e do reconciliador de
 * pagamento da live.
 *
 * ── COMPORTAMENTO ──
 *
 * O polling da tela continua sendo o caminho rápido quando a aba está aberta;
 * isto é o seguro pra quando ele falha. Latência de até 30s — a vendedora
 * raramente percebe, e é infinitamente melhor que a venda sumir.
 *
 * Kill-switch: `PIX_RECONCILE=0` desliga sem deploy.
 */
@Injectable()
export class PixPagbankReconcileService {
  private readonly logger = new Logger(PixPagbankReconcileService.name);
  private running = false;

  /** Teto por ciclo — reconciliação é exceção, não fluxo de massa. */
  private static readonly BATCH = 20;
  /** Só olha pagamento recente: venda de dias atrás vira caso pra humano. */
  private static readonly JANELA_HORAS = 24;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdv: PdvService,
  ) {}

  private get ligado(): boolean {
    return String(process.env.PIX_RECONCILE ?? '1') !== '0';
  }

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'pix-pagbank-reconcile' })
  async tick(): Promise<void> {
    if (!this.ligado) return;
    if (this.running) return; // guard de overlap — nunca empilha ciclo
    this.running = true;
    try {
      await this.reconciliar();
    } catch (e: any) {
      // Reconciliador que quebra não pode derrubar nada: só loga e tenta no
      // próximo ciclo. O estado no banco não muda com a falha.
      this.logger.error(`[pix-reconcile] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  private async reconciliar(): Promise<void> {
    const desde = new Date(Date.now() - PixPagbankReconcileService.JANELA_HORAS * 3600_000);

    const pagos: Array<{ saleId: string; pagbankOrderId: string; valor: number }> =
      await (this.prisma as any).pagbankPayment.findMany({
        where: { status: 'paid', method: 'pix', paidAt: { gte: desde } },
        orderBy: { paidAt: 'desc' },
        take: PixPagbankReconcileService.BATCH,
        select: { saleId: true, pagbankOrderId: true, valor: true },
      });
    if (!pagos.length) return;

    for (const p of pagos) {
      // Cada venda é independente: uma falha não interrompe as outras.
      // `confirmPixPagoSeVendaAberta` já é idempotente e nunca lança —
      // venda já fechada, id de crediário ou pagamento repetido saem em
      // silêncio, sem log de erro (senão o log encheria a cada 30s).
      const r = await this.pdv.confirmPixPagoSeVendaAberta({
        saleId: p.saleId,
        pagbankOrderId: p.pagbankOrderId,
        valor: Number(p.valor || 0),
      });
      if (r.handled) {
        this.logger.log(
          `[pix-reconcile] venda ${p.saleId} fechada por PIX PagBank pago (${p.pagbankOrderId})`,
        );
      }
    }
  }
}
