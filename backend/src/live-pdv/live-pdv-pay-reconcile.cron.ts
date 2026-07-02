import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LivePdvService } from './live-pdv.service';

/**
 * LivePdvPayReconcileCron — confirmação de pagamento da LIVE no SERVIDOR,
 * sem nenhum polling no frontend.
 *
 * Contexto (live de 01/07): o poll de fundo do frontend foi removido porque
 * empilhava e derrubava a live. Só que ninguém ficou no lugar — o webhook do
 * PagBank/Pagar.me grava o pagamento no banco e PARA: o socket
 * 'live-pdv:cart-paid' (que vira o card pra PAGO e dispara a separação) só
 * saía quando a apresentadora clicava em "confirmar" manualmente.
 *
 * Este cron fecha o circuito no backend, a cada 15s:
 *   1. Busca carrinhos 'awaiting_payment' (bounded — dezenas numa live).
 *   2. Pra cada um roda o MESMO checkPayment() do botão manual:
 *      - 1º olha o registro de pagamento no Postgres (que o webhook já
 *        atualizou) → confirmação em até ~15s após o webhook, sem custo;
 *      - se o webhook não chegou, consulta o gateway AO VIVO com o throttle
 *        de 8s/carrinho que o service já tem (lastLiveCheck) → rede de
 *        segurança pra webhook perdido.
 *   3. checkPayment → onCartPaid → socket + ordens de separação por loja.
 *
 * Carga: 1 query Postgres por ciclo + checagens de gateway throttled.
 * Nada roda no navegador da apresentadora — a tela só recebe o push.
 */
@Injectable()
export class LivePdvPayReconcileCron {
  private readonly logger = new Logger(LivePdvPayReconcileCron.name);
  private running = false;

  /** Máx de carrinhos por ciclo — acima disso, o resto fica pro próximo (15s). */
  private static readonly BATCH = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LivePdvService,
  ) {}

  @Cron('*/15 * * * * *', { name: 'live-pdv-pay-reconcile' })
  async tick(): Promise<void> {
    if (this.running) return; // nunca empilha ciclos — a lição da live de 01/07
    this.running = true;
    try {
      await this.reconcile();
    } catch (e: any) {
      this.logger.error(`[pay-reconcile] tick falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<void> {
    // Cobranças em aberto ainda dentro da validade (com 1h de folga — o
    // gateway pode confirmar um PIX pago no último segundo). Link de 24h
    // entra também: paymentExpiresAt cobre os dois casos.
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const pendentes: any[] = await (this.prisma as any).livePdvCart.findMany({
      where: {
        status: 'awaiting_payment',
        OR: [{ paymentExpiresAt: null }, { paymentExpiresAt: { gte: cutoff } }],
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: LivePdvPayReconcileCron.BATCH,
    });
    if (!pendentes.length) return;

    let pagos = 0;
    for (const c of pendentes) {
      try {
        const r = await this.live.checkPayment(c.id);
        if (r.paid) pagos++;
      } catch (e: any) {
        this.logger.warn(`[pay-reconcile] carrinho ${c.id}: ${e?.message || e}`);
      }
    }
    if (pagos > 0) {
      this.logger.log(`[pay-reconcile] ${pagos}/${pendentes.length} carrinho(s) confirmados como PAGOS`);
    }
  }
}
