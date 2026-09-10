import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PagarmeService } from './pagarme.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';
import { corteFailedRechecavel } from '../common/cobranca-link-viva';

/**
 * RECONCILE DO LINK PAGAR.ME (31/07) — o webhook não pode ser a única
 * confirmação.
 *
 * Caso real: pedido #E2B6B4 (Sorocaba, R$ 159,80) foi PAGO no cartão às
 * 10:00 e o PDV seguia mostrando "Aguardando" às 11:21. A tela lê
 * `pagarme_payment.status` do banco local — se o webhook não chega (rede,
 * retry esgotado, deploy no meio, assinatura recusada), o pedido fica
 * pendente pra sempre e a vendedora não finaliza a venda.
 *
 * Mesmo padrão que já resolveu a LIVE: o servidor pergunta de tempos em
 * tempos, em vez de esperar sentado. O navegador continua sem polling.
 *
 * Cuidados: janela do tamanho da validade do link, teto por ciclo, guard de
 * overlap e throttle
 * por pedido — nunca martelar a API do Pagar.me.
 */
@Injectable()
export class PagarmeReconcileService {
  private readonly logger = new Logger(PagarmeReconcileService.name);
  private rodando = false;
  /** Última consulta ao vivo por pedido — evita repetir a cada ciclo. */
  private ultimaChecagem = new Map<string, number>();

  /**
   * A JANELA TEM QUE COBRIR A VALIDADE DO LINK (10/09).
   *
   * 48h fixas eram menos que os 72h que o link vive (`PAGARME_LINK_HORAS`, até
   * 7 dias) — link gerado na segunda de manhã e pago na quarta à tarde caía
   * fora da janela e ninguém perguntava mais, com o checkout ainda de pé. O
   * corte agora acompanha a validade, com a mesma folga de 6h do resto.
   */
  private static janelaH(): number {
    const validade = Number(process.env.PAGARME_LINK_HORAS) || 72;
    return Math.max(48, Math.min(168, validade) + 6);
  }
  private static readonly MAX_POR_CICLO = 25;
  private static readonly THROTTLE_MS = 90_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pagarme: PagarmeService,
    @Inject(forwardRef(() => CrediarioBaixaService))
    private readonly crediarioBaixa: CrediarioBaixaService,
  ) {}

  @Cron('*/45 * * * * *')
  async reconciliar() {
    if (process.env.PAGARME_RECONCILE === '0') return;
    if (this.rodando) return;
    this.rodando = true;
    try {
      const agora = Date.now();
      const desde = new Date(agora - PagarmeReconcileService.janelaH() * 3600_000);
      /**
       * TENTATIVA RECUSADA NÃO SAI DA FILA (10/09).
       *
       * Só `status='pending'` era um alçapão: a primeira recusa carimbava
       * `failed` e a linha nunca mais era perguntada — mas o checkout da
       * Pagar.me continua aceitando pagamento até vencer. "Fizemos o link de
       * manhã e a cliente só pagou à noite. Está pago e o sistema não tem
       * essa informação" (dono, 10/09): dinheiro na conta, venda aberta,
       * ninguém avisado.
       *
       * Agora o `failed` de link ainda no prazo volta pra fila. `canceled`
       * não: ali o pedido foi cancelado de propósito e o checkout morre
       * junto. Volume segue no chão — só link vivo, e o throttle é o mesmo.
       */
      const pendentes: any[] = await (this.prisma as any).pagarmePayment.findMany({
        where: {
          createdAt: { gte: desde },
          OR: [
            { status: 'pending' },
            {
              status: 'failed',
              method: 'checkout',
              expiresAt: { gte: corteFailedRechecavel(agora) },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { pagarmeOrderId: true, saleId: true, storeCode: true, method: true },
      });
      if (!pendentes.length) return;

      let checados = 0;
      let confirmados = 0;

      for (const p of pendentes) {
        if (checados >= PagarmeReconcileService.MAX_POR_CICLO) break;
        if (!p.pagarmeOrderId) continue;
        const ultima = this.ultimaChecagem.get(p.pagarmeOrderId) || 0;
        if (agora - ultima < PagarmeReconcileService.THROTTLE_MS) continue;
        this.ultimaChecagem.set(p.pagarmeOrderId, agora);
        checados++;

        try {
          // checkOrderStatus já persiste o status novo (e o endereço do
          // checkout quando vem no cartão).
          const r: any = await this.pagarme.checkOrderStatus(p.pagarmeOrderId);
          const status = String(r?.status || '').toLowerCase();
          if (status !== 'paid') continue;

          confirmados++;
          this.logger.log(
            `[pagarme-reconcile] PAGO fora do webhook: pedido=${p.pagarmeOrderId} venda=${p.saleId} loja=${p.storeCode}`,
          );

          // Mesmo efeito colateral do webhook: baixa de crediário paga por
          // link não pode ficar pendente no Wincred.
          try {
            await this.crediarioBaixa.confirmBaixaPixIfExists(p.saleId);
          } catch (e) {
            this.logger.warn(
              `[pagarme-reconcile] baixa crediário falhou (venda ${p.saleId}): ${(e as Error).message}`,
            );
          }
        } catch (e) {
          // Pedido some do gateway / rede caiu: não derruba o ciclo.
          this.logger.warn(
            `[pagarme-reconcile] consulta falhou (${p.pagarmeOrderId}): ${(e as Error).message}`,
          );
        }
      }

      if (confirmados > 0) {
        this.logger.log(
          `[pagarme-reconcile] ciclo: ${checados} consultados · ${confirmados} confirmados`,
        );
      }
      // Poda o mapa de throttle pra não crescer sem fim
      if (this.ultimaChecagem.size > 2000) this.ultimaChecagem.clear();
    } finally {
      this.rodando = false;
    }
  }
}
