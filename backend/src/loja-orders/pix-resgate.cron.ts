import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoEmailService } from './pedido-email.service';

/**
 * RESGATE DO PIX NÃO PAGO (dono, 14/08/2026).
 *
 * A medição que motivou: 4 pedidos do site novo em 7 dias morreram em
 * `awaiting_payment` — cliente que preencheu identificação, endereço e frete,
 * gerou o PIX e sumiu. Nenhuma mensagem ia atrás: o fluxo "Pedido Pago" do
 * n8n ignora pedido não pago DE PROPÓSITO, o Reportana (que fazia esse
 * resgate no site antigo) está desligado desde 18/06, e não existia gatilho.
 *
 * Este cron é o gatilho — e SÓ o gatilho: acha o pedido PIX com 30min de
 * silêncio, avisa o n8n (`evento: 'pix_nao_pago'`, com o copia-e-cola no
 * payload) e carimba. Quem escreve e envia a mensagem é o n8n, que é o dono
 * da conversa (decisão do dono, 12/08).
 *
 * Regras que não se negociam:
 *  - UM toque por pedido, pra sempre (`pixResgateAvisadoEm`). Lembrete
 *    ajuda; o segundo lembrete é cobrança.
 *  - Só DENTRO da validade do PIX (o copia-e-cola de pedido vencido é
 *    convite pra pagar no vazio). A janela padrão 30min–2h segue a validade
 *    do QR da Pagar.me.
 *  - Carimba SÓ depois do n8n aceitar o POST — rede falhou, tenta no ciclo
 *    seguinte; a janela limita a insistência sozinha.
 *  - Pedido que pagou entre a busca e o toque não recebe (recheca `paidAt`).
 *
 * Kill-switch: `PIX_RESGATE=0`. Ajuste fino: `PIX_RESGATE_MIN` (default 30).
 */
@Injectable()
export class PixResgateCron {
  private readonly logger = new Logger(PixResgateCron.name);

  private rodando = false;

  /** Validade do PIX da Pagar.me — depois disso o código morreu. */
  private static readonly VALIDADE_MIN = 120;
  private static readonly MAX_POR_CICLO = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly pedidoEmail: PedidoEmailService,
  ) {}

  private get ligado(): boolean {
    return String(this.config.get<string>('PIX_RESGATE') ?? '1') !== '0';
  }

  private get esperaMin(): number {
    const n = Number(this.config.get<string>('PIX_RESGATE_MIN'));
    return Number.isFinite(n) && n >= 5 ? n : 30;
  }

  @Cron('30 */5 * * * *')
  async ciclo(): Promise<void> {
    if (!this.ligado || this.rodando) return;
    this.rodando = true;
    try {
      await this.varrer();
    } catch (e: any) {
      this.logger.warn(`[pix-resgate] ciclo falhou: ${e?.message ?? e}`);
    } finally {
      this.rodando = false;
    }
  }

  private async varrer(): Promise<void> {
    const agora = Date.now();
    const fimJanela = new Date(agora - this.esperaMin * 60_000);
    const inicioJanela = new Date(agora - PixResgateCron.VALIDADE_MIN * 60_000);

    const pendentes = await (this.prisma as any).order.findMany({
      where: {
        source: 'ecommerce',
        status: 'awaiting_payment',
        paidAt: null,
        pixResgateAvisadoEm: null,
        createdAt: { gte: inicioJanela, lte: fimJanela },
        // Só PIX: cartão recusado é outro fluxo (a cliente já viu o erro na
        // tela na hora — lembrete de cartão não resgata, constrange).
        paymentInfo: { contains: '"pix"' },
      },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
      take: PixResgateCron.MAX_POR_CICLO,
    });
    if (!pendentes.length) return;

    for (const pedido of pendentes) {
      // O reconcile de 1min pode ter confirmado o pagamento entre a busca e
      // este toque — mandar "seu PIX está esperando" pra quem JÁ PAGOU é o
      // jeito mais rápido de a cliente desconfiar da loja inteira.
      const fresco = await (this.prisma as any).order.findUnique({
        where: { id: pedido.id },
        select: { paidAt: true, status: true },
      });
      if (fresco?.paidAt || fresco?.status !== 'awaiting_payment') continue;

      const entregue = await this.pedidoEmail.aoPixNaoPago(pedido);
      if (!entregue) continue; // rede/n8n fora — o próximo ciclo tenta de novo

      await (this.prisma as any).order.update({
        where: { id: pedido.id },
        data: { pixResgateAvisadoEm: new Date() },
      });
      this.logger.log(
        `[pix-resgate] toque enviado — pedido ${pedido.wcOrderNumber ?? pedido.id} (R$ ${pedido.totalAmount ?? '?'})`,
      );
    }
  }
}
