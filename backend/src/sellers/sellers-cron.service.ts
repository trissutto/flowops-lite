import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

/**
 * SellersCronService — alertas RH automáticos.
 *
 * Rotina diária (8h da manhã):
 *  - Vê funcionárias com dataAdmissão preenchida
 *  - Calcula o aniversário do ciclo (12 meses após admissão, ano corrente)
 *  - Se aniversário está em <= 60 dias E não tem dataInicioFerias marcada
 *    pro ciclo corrente → manda push pros admins
 *
 * Por que 60 dias?  Período legal CLT: férias podem ser concedidas até 11 meses
 * após início do período aquisitivo. Avisar 2 meses antes dá folga pra montar
 * escala sem cair em férias coletivas / multa.
 *
 * Liga/desliga via env:  RH_CRON_ENABLED=1 (default OFF em dev).
 */
@Injectable()
export class SellersCronService {
  private readonly logger = new Logger(SellersCronService.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  private get enabled(): boolean {
    return String(process.env.RH_CRON_ENABLED || '').trim() === '1';
  }

  /** Roda todo dia às 08:00 (timezone do servidor — UTC no Railway = 05:00 BRT). */
  @Cron('0 8 * * *', { name: 'rh-ferias-alert' })
  async runFeriasAlert() {
    if (!this.enabled) return;
    if (this.isRunning) {
      this.logger.log('[rh-cron] skip — execução anterior ainda rodando');
      return;
    }
    this.isRunning = true;
    try {
      const r = await this.checkVacationAlerts();
      this.logger.log(
        `[rh-cron] OK — checadas=${r.checked}, próximas do venc.=${r.nearing}, push enviados=${r.notified}`,
      );
    } catch (e: any) {
      this.logger.error(`[rh-cron] falhou: ${e?.message || e}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Lógica isolada — também exposta via endpoint manual /sellers/ferias/check
   * pra rodar a qualquer momento (debug ou disparo sob demanda).
   */
  async checkVacationAlerts(): Promise<{
    checked: number;
    nearing: number;
    notified: number;
    items: Array<{
      sellerId: string;
      name: string;
      diasParaVencer: number;
      vencimentoCiclo: string;
    }>;
  }> {
    const now = new Date();
    const sellers = await (this.prisma as any).seller.findMany({
      where: {
        active: true,
        dataAdmissao: { not: null },
      },
      select: {
        id: true,
        name: true,
        dataAdmissao: true,
        dataInicioFerias: true,
        responsibleStoreId: true,
      },
    });

    let nearing = 0;
    let notified = 0;
    const items: Array<{
      sellerId: string;
      name: string;
      diasParaVencer: number;
      vencimentoCiclo: string;
    }> = [];

    for (const s of sellers) {
      if (!s.dataAdmissao) continue;
      const adm: Date = new Date(s.dataAdmissao);

      // Próximo aniversário do ciclo (12 meses pós-admissão, depois 24, 36...)
      const anosCompletos = this.diffInYears(adm, now);
      const proximoCiclo = new Date(adm);
      proximoCiclo.setFullYear(adm.getFullYear() + anosCompletos + 1);

      // Quantos dias até vencer
      const diasRestantes = Math.ceil(
        (proximoCiclo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (diasRestantes > 60 || diasRestantes < 0) continue;

      // Já tem férias marcadas no ciclo atual?
      if (s.dataInicioFerias) {
        const inicioFerias = new Date(s.dataInicioFerias);
        // Considera "já marcada" se a data está nos próximos 12 meses
        const diffMeses = this.diffInMonths(now, inicioFerias);
        if (diffMeses >= 0 && diffMeses <= 12) {
          continue; // já marcou — não alerta
        }
      }

      nearing++;
      items.push({
        sellerId: s.id,
        name: s.name,
        diasParaVencer: diasRestantes,
        vencimentoCiclo: proximoCiclo.toISOString().slice(0, 10),
      });
    }

    // Manda push consolidado pros admins (1 alerta agrupado por dia)
    if (items.length > 0) {
      try {
        const top = items
          .slice(0, 5)
          .map((i) => `${i.name} (${i.diasParaVencer}d)`)
          .join(', ');
        const extra = items.length > 5 ? ` +${items.length - 5}` : '';
        const r = await this.push.sendToAdmins({
          title: `RH — ${items.length} funcionária(s) c/ férias vencendo`,
          body: `${top}${extra}`,
          tag: 'rh-ferias-alert',
          url: '/retaguarda/vendedoras',
        } as any);
        notified = r?.sent || 0;
      } catch (e: any) {
        this.logger.warn(`[rh-cron] push falhou: ${e?.message}`);
      }
    }

    return {
      checked: sellers.length,
      nearing,
      notified,
      items,
    };
  }

  private diffInYears(from: Date, to: Date): number {
    let y = to.getFullYear() - from.getFullYear();
    if (
      to.getMonth() < from.getMonth() ||
      (to.getMonth() === from.getMonth() && to.getDate() < from.getDate())
    ) {
      y--;
    }
    return Math.max(0, y);
  }

  private diffInMonths(from: Date, to: Date): number {
    let m = (to.getFullYear() - from.getFullYear()) * 12;
    m += to.getMonth() - from.getMonth();
    if (to.getDate() < from.getDate()) m--;
    return m;
  }
}
