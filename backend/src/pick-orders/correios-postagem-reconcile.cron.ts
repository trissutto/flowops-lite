import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CorreiosService } from '../correios/correios.service';
import { PickOrdersService } from './pick-orders.service';

/**
 * Model B — marca ENVIADO automaticamente quando os Correios registram a
 * POSTAGEM. Acompanha o rastreio das pré-postagens pendentes (geradas mas ainda
 * não postadas); quando o objeto mostra o 1º movimento (postado/encaminhado),
 * dispara o shipped pelo caminho testado (baixa Giga + WhatsApp de rastreio).
 *
 * Gated por CORREIOS_AUTO_SHIP=1 (kill-switch — sem ela o cron não roda e a loja
 * marca enviado manualmente pelo "Enviar c/ rastreio").
 */
@Injectable()
export class CorreiosPostagemReconcileCron {
  private readonly logger = new Logger(CorreiosPostagemReconcileCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly correios: CorreiosService,
    private readonly pickOrders: PickOrdersService,
  ) {}

  private get enabled(): boolean {
    return String(process.env.CORREIOS_AUTO_SHIP || '').trim() === '1';
  }

  /** Postado = o rastreio já tem um evento de entrada/movimento nos Correios. */
  private foiPostado(eventos: any[]): boolean {
    if (!Array.isArray(eventos) || !eventos.length) return false;
    return eventos.some((ev) =>
      /postad|encaminhad|tr[aâ]nsito|unidade de|saiu para entrega|entregue|recebido/i.test(
        String(ev?.descricao || ev?.status || ''),
      ),
    );
  }

  @Cron('*/15 * * * *', { name: 'correios-postagem-reconcile' })
  async run(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return;
    this.running = true;
    try {
      const pend: any[] = await (this.prisma as any).pickOrder.findMany({
        where: { correiosGeneratedAt: { not: null }, status: { not: 'shipped' }, trackingCode: { not: null } },
        select: { id: true, trackingCode: true },
        take: 100,
      });
      let enviados = 0;
      for (const p of pend) {
        try {
          const t: any = await this.correios.rastrear(p.trackingCode);
          if (t?.ok && this.foiPostado(t.eventos)) {
            await this.pickOrders.marcarEnviadoPorPostagem(p.id);
            enviados++;
          }
        } catch (e: any) {
          this.logger.warn(`[correios-cron] ${p.trackingCode}: ${e?.message || e}`);
        }
      }
      if (pend.length) this.logger.log(`[correios-cron] ${enviados}/${pend.length} postados → enviados`);
    } finally {
      this.running = false;
    }
  }
}
