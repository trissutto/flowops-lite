import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';

/**
 * "SEU PEDIDO CHEGOU" — o fim do ciclo, que acontecia em silêncio.
 *
 * O sistema já sabia da entrega e nunca dizia nada. É o momento mais útil pra
 * falar: a peça está na mão da cliente, o prazo de troca começa a correr AGORA,
 * e é a única hora em que pedir opinião não soa fora de contexto.
 *
 * ⚠️ ESTE CRON NUNCA FUNCIONOU (achado 18/08): ele consultava os Correios
 * direto e a chamada respondia HTTP 400 em 100% das vezes por falta do header
 * `Accept-Language` — como a falha é tratada como "sem novidade", o silêncio
 * parecia normal. Foram 3 avisos em 22.678 pedidos.
 *
 * Agora a fonte é o cache `rastreio_objetos`, alimentado pelo `RastreioSyncCron`:
 *   - uma fonte só de verdade sobre "chegou" (a tela e o aviso não divergem);
 *   - zero request de API aqui dentro;
 *   - e a REGRA DA ESTREIA vem junto: objeto que entrou no radar já entregue
 *     não dispara aviso. É o que impediu o primeiro deploy de mandar "chegou!"
 *     pra 46 clientes que receberam dias atrás.
 *
 * Janela curta continua valendo (`ENTREGA_AVISO_DIAS`, default 10).
 * Kill-switch `ENTREGA_AVISO=0`.
 */
@Injectable()
export class EntregaAvisoCron {
  private readonly logger = new Logger(EntregaAvisoCron.name);
  private running = false;

  /** Teto por ciclo — cada aviso é uma mensagem pra cliente, não um request. */
  private static readonly LOTE = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pedidoEmail: PedidoEmailService,
  ) {}

  private get enabled(): boolean {
    return String(process.env.ENTREGA_AVISO ?? '1').trim() !== '0';
  }

  private get janelaDias(): number {
    const n = parseInt(String(process.env.ENTREGA_AVISO_DIAS ?? '10'), 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
  }

  @Cron('20 */2 * * *', { name: 'entrega-aviso' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return; // ciclo anterior ainda rodando
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

      const codigos = [
        ...new Set(pendentes.map((o) => String(o.trackingCode || '').trim().toUpperCase())),
      ];
      const rastreios: any[] = await (this.prisma as any).rastreioObjeto.findMany({
        where: { codigo: { in: codigos }, entregue: true },
        select: { codigo: true, entregaNaEstreia: true },
      });
      const entregues = new Map(rastreios.map((r) => [r.codigo, r]));

      let avisados = 0;
      for (const o of pendentes) {
        try {
          const r = entregues.get(String(o.trackingCode || '').trim().toUpperCase());
          if (!r) continue;
          if (r.entregaNaEstreia) {
            // Notícia velha: carimba como avisado (sem mandar nada) pra não
            // ficar rodando esse pedido em todo ciclo.
            await (this.prisma as any).order.updateMany({
              where: { id: o.id, entregaAvisadaEm: null },
              data: { entregaAvisadaEm: new Date() },
            });
            continue;
          }

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
