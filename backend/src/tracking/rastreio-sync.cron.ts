import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingService } from './tracking.service';

/**
 * ACOMPANHA O OBJETO ATÉ CHEGAR (18/08).
 *
 * O ciclo do pedido terminava em "Enviado" e ficava lá pra sempre: nenhum
 * pedido virou `delivered` em 90 dias, a loja que vendeu não sabia dizer se a
 * peça chegou e o prazo de troca não tinha marco zero. Este cron mantém
 * `rastreio_objetos` fresco e, quando a transportadora confirma a entrega,
 * fecha o pedido.
 *
 * ESCADA DE FREQUÊNCIA — objeto postado hoje muda de estado o tempo todo;
 * objeto de três semanas quase nunca. Consultar todos na mesma cadência
 * gastaria a API à toa, então:
 *   até 3 dias no radar → de hora em hora
 *   4 a 10 dias         → de 4 em 4 horas
 *   11 a 30 dias        → 1x por dia
 *   entregue            → nunca mais (o dado já está fechado)
 *
 * Kill-switch `RASTREIO_SYNC=0`. Teto por ciclo em `RASTREIO_SYNC_LOTE`.
 */
@Injectable()
export class RastreioSyncCron {
  private readonly logger = new Logger(RastreioSyncCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracking: TrackingService,
  ) {}

  private get enabled(): boolean {
    return String(process.env.RASTREIO_SYNC ?? '1').trim() !== '0';
  }

  private get lote(): number {
    const n = parseInt(String(process.env.RASTREIO_SYNC_LOTE ?? '60'), 10);
    return Number.isFinite(n) && n > 0 ? n : 60;
  }

  /** Quanto tempo esperar antes de reconsultar, pela idade no radar. */
  private intervaloHoras(desde: Date | null): number {
    if (!desde) return 0;
    const dias = (Date.now() - desde.getTime()) / 86_400_000;
    if (dias <= 3) return 1;
    if (dias <= 10) return 4;
    return 24;
  }

  @Cron('*/30 * * * *', { name: 'rastreio-sync' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return; // ciclo anterior ainda rodando (API é lenta)
    this.running = true;
    try {
      const candidatos = await this.candidatos();
      if (!candidatos.length) return;

      const cache = await this.tracking.resumoDoCache(candidatos);
      const cru: any[] = await (this.prisma as any).rastreioObjeto.findMany({
        where: { codigo: { in: candidatos } },
        select: { codigo: true, createdAt: true, consultadoEm: true, entregue: true },
      });
      const porCodigo = new Map(cru.map((r) => [r.codigo, r]));

      const fila = candidatos
        .filter((c) => {
          const r = porCodigo.get(c);
          if (!r) return true;                 // nunca olhamos pra ele
          if (r.entregue) return false;        // acabou o ciclo
          if (!r.consultadoEm) return true;
          const esperar = this.intervaloHoras(r.createdAt) * 3_600_000;
          return Date.now() - new Date(r.consultadoEm).getTime() >= esperar;
        })
        // Mais desatualizado primeiro: com teto por ciclo, é o que garante que
        // todo objeto é visitado em vez de sempre os mesmos.
        .sort((a, b) => {
          const ta = porCodigo.get(a)?.consultadoEm ? new Date(porCodigo.get(a)!.consultadoEm).getTime() : 0;
          const tb = porCodigo.get(b)?.consultadoEm ? new Date(porCodigo.get(b)!.consultadoEm).getTime() : 0;
          return ta - tb;
        })
        .slice(0, this.lote);

      if (!fila.length) return;

      const { consultados, entreguesAgora } = await this.tracking.sincronizarLote(fila);
      if (entreguesAgora.length) await this.promoverEntregues(entreguesAgora);

      this.logger.log(
        `[rastreio-sync] ${consultados}/${fila.length} objeto(s) atualizados` +
          `${entreguesAgora.length ? ` · ${entreguesAgora.length} entregue(s) agora` : ''}` +
          ` (fila total: ${candidatos.length})`,
      );
      // `cache` só entra aqui pra manter a leitura numa consulta só; o dado
      // usado é o `cru` acima.
      void cache;
    } catch (e: any) {
      this.logger.error(`[rastreio-sync] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Objetos que ainda importam: despachados nos últimos 30 dias, do pedido ou
   * da separação. Passou disso, os Correios já não têm o que dizer e o custo
   * de perguntar é do nosso lado.
   */
  private async candidatos(): Promise<string[]> {
    const desde = new Date(Date.now() - 30 * 86_400_000);
    const [pedidos, cards] = await Promise.all([
      (this.prisma as any).order.findMany({
        where: { status: 'shipped', trackingCode: { not: null }, updatedAt: { gte: desde } },
        select: { trackingCode: true },
        take: 2000,
      }),
      (this.prisma as any).pickOrder.findMany({
        where: { status: 'shipped', trackingCode: { not: null }, updatedAt: { gte: desde } },
        select: { trackingCode: true },
        take: 2000,
      }),
    ]);
    return [
      ...new Set(
        [...pedidos, ...cards]
          .map((r: any) => String(r.trackingCode || '').trim().toUpperCase())
          .filter((c: string) => TrackingService.ehCodigoValido(c)),
      ),
    ];
  }

  /**
   * Pedido entregue → `delivered` + `deliveredAt`.
   *
   * ⚠️ PEDIDO DIVIDIDO só fecha quando TODAS as caixas chegam: o pacote da
   * outra loja ainda pode estar em trânsito, e dizer "entregue" ali faria a
   * loja responder pra cliente que já chegou tudo. A data é a da ÚLTIMA
   * entrega — é dela que o prazo de troca corre.
   */
  private async promoverEntregues(codigos: string[]): Promise<void> {
    for (const codigo of codigos) {
      const pedidos: any[] = await (this.prisma as any).order.findMany({
        where: {
          status: 'shipped',
          OR: [{ trackingCode: codigo }, { pickOrders: { some: { trackingCode: codigo } } }],
        },
        select: {
          id: true,
          wcOrderNumber: true,
          trackingCode: true,
          pickOrders: { select: { trackingCode: true } },
        },
        take: 20,
      });

      for (const p of pedidos) {
        const doPedido = [p.trackingCode, ...p.pickOrders.map((x: any) => x.trackingCode)]
          .map((c: any) => String(c || '').trim().toUpperCase())
          .filter((c: string) => TrackingService.ehCodigoValido(c));
        const resumo = await this.tracking.resumoDoCache(doPedido);
        const faltando = doPedido.filter((c) => !resumo.get(c)?.entregue);
        if (faltando.length) {
          this.logger.log(
            `[rastreio-sync] ${p.wcOrderNumber}: ${faltando.length} volume(s) ainda em trânsito — não fecha`,
          );
          continue;
        }
        const entregueEm = doPedido
          .map((c) => resumo.get(c)?.entregueEm)
          .filter(Boolean)
          .sort((a: any, b: any) => new Date(b).getTime() - new Date(a).getTime())[0] ?? new Date();

        // Guard atômico: dois ciclos (ou um restart no meio) não podem
        // escrever histórico duplicado do mesmo fechamento.
        const venceu = await (this.prisma as any).order.updateMany({
          where: { id: p.id, status: 'shipped' },
          data: { status: 'delivered', deliveredAt: new Date(entregueEm as any) },
        });
        if (venceu.count !== 1) continue;

        await (this.prisma as any).orderHistory
          .create({
            data: {
              orderId: p.id,
              fromStatus: 'shipped',
              toStatus: 'delivered',
              note:
                `Entrega confirmada pelo rastreio (${doPedido.join(', ')})` +
                `${doPedido.length > 1 ? ` — ${doPedido.length} volumes` : ''}.`,
            },
          })
          .catch(() => null);
        this.logger.log(`[rastreio-sync] ${p.wcOrderNumber} ENTREGUE em ${new Date(entregueEm as any).toISOString()}`);
      }
    }
  }
}
