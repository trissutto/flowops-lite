import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CorreiosService } from '../correios/correios.service';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';

/**
 * "SEU PEDIDO CHEGOU" — o fim do ciclo, que acontecia em silêncio.
 *
 * O sistema já sabia da entrega (o rastreio é consultado na tela de status do
 * pedido) e nunca dizia nada. É o momento mais útil pra falar: a peça está na
 * mão da cliente, o prazo de troca começa a correr AGORA, e é a única hora em
 * que pedir opinião não soa fora de contexto.
 *
 * Só olha pedido despachado há pouco (`ENTREGA_AVISO_DIAS`, default 10). Um
 * pedido entregue há três semanas não pode receber "chegou!" hoje — a janela
 * curta é o que impede o backlog de virar constrangimento no primeiro deploy.
 *
 * Kill-switch `ENTREGA_AVISO=0`.
 */
@Injectable()
export class EntregaAvisoCron {
  private readonly logger = new Logger(EntregaAvisoCron.name);
  private running = false;

  /** Teto por ciclo — a API dos Correios é por objeto, um request cada. */
  private static readonly LOTE = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly correios: CorreiosService,
    private readonly pedidoEmail: PedidoEmailService,
  ) {}

  private get enabled(): boolean {
    return String(process.env.ENTREGA_AVISO ?? '1').trim() !== '0';
  }

  private get janelaDias(): number {
    const n = parseInt(String(process.env.ENTREGA_AVISO_DIAS ?? '10'), 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
  }

  /**
   * "Objeto entregue ao destinatário" — e só isso.
   *
   * `/entreg/i` casaria com "saiu para ENTREGA" (ainda no carro do carteiro) e
   * `/entregue/i` sozinho casaria com "Objeto NÃO entregue - carteiro não
   * atendido", que é tentativa falha. Dizer "chegou!" pra quem não recebeu é
   * pior que não dizer nada.
   */
  private foiEntregue(eventos: any[]): boolean {
    if (!Array.isArray(eventos)) return false;
    return eventos.some((ev) => {
      const t = String(ev?.descricao || ev?.status || '');
      return /entregue/i.test(t) && !/n[ãa]o\s+entregue/i.test(t);
    });
  }

  @Cron('20 */2 * * *', { name: 'entrega-aviso' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return; // ciclo anterior ainda rodando (API dos Correios é lenta)
    this.running = true;
    try {
      const desde = new Date(Date.now() - this.janelaDias * 24 * 60 * 60 * 1000);
      const pendentes: any[] = await (this.prisma as any).order.findMany({
        where: {
          source: { in: ['ecommerce', 'pdv_online'] },
          status: { in: ['shipped', 'delivered'] },
          trackingCode: { not: null },
          entregaAvisadaEm: null,
          // Despachado dentro da janela: fora dela a entrega é notícia velha.
          rastreioAvisadoEm: { gte: desde },
        },
        select: {
          id: true, wcOrderNumber: true, source: true, trackingCode: true, carrier: true,
          customerName: true, customerEmail: true, customerPhone: true, totalAmount: true,
          items: { select: { productName: true, quantity: true, unitPrice: true, sku: true } },
        },
        take: EntregaAvisoCron.LOTE,
      });
      if (!pendentes.length) return;

      let avisados = 0;
      for (const o of pendentes) {
        try {
          const t: any = await this.correios.rastrear(o.trackingCode);
          if (!t?.ok || !this.foiEntregue(t.eventos)) continue;

          // Reivindicação atômica ANTES de mandar: dois processos (o cron
          // reentrando após restart) não podem avisar o mesmo pedido.
          const venceu = await (this.prisma as any).order.updateMany({
            where: { id: o.id, entregaAvisadaEm: null },
            data: { entregaAvisadaEm: new Date() },
          });
          if (venceu.count !== 1) continue;

          const ok = await this.pedidoEmail.aoEntregar(o);
          if (ok) avisados++;
          else {
            // Nenhum canal saiu: devolve o carimbo pro próximo ciclo tentar.
            // Carimbo sem mensagem é pior que retry — some do radar pra sempre.
            await (this.prisma as any).order.updateMany({
              where: { id: o.id },
              data: { entregaAvisadaEm: null },
            });
          }
        } catch (e: any) {
          this.logger.warn(`[entrega-aviso] ${o.wcOrderNumber} (${o.trackingCode}): ${e?.message || e}`);
        }
      }
      if (avisados) {
        this.logger.log(`[entrega-aviso] ${avisados}/${pendentes.length} pedido(s) entregues avisados`);
      }
    } finally {
      this.running = false;
    }
  }
}
