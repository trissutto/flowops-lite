import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

/**
 * PontoCronService — automacao de alertas e fechamentos do ponto.
 *
 * Rotinas:
 *  1. checkEsquecimentos (a cada 30 min): para cada vendedora com horario
 *     previsto NO MOMENTO, ve se ja bateu entrada. Se nao bateu e ja passou
 *     +60min do horario → manda push pros admins.
 *
 *  2. fechamentoMensal (1o dia do mes, 02h): registra "fechamento" do mes
 *     anterior (no log, ainda nao gera holerite — proximo passo).
 *
 * Liga/desliga via env: PONTO_CRON_ENABLED=1 (default OFF).
 */
@Injectable()
export class PontoCronService {
  private readonly logger = new Logger(PontoCronService.name);
  private isCheckingEsquecimento = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  private get enabled(): boolean {
    return String(process.env.PONTO_CRON_ENABLED || '').trim() === '1';
  }

  /** A cada 30 min checa funcionárias que deveriam ter batido e não bateram. */
  @Cron('*/30 * * * *', { name: 'ponto-check-esquecimento' })
  async checkEsquecimentos() {
    if (!this.enabled) return;
    if (this.isCheckingEsquecimento) return;
    this.isCheckingEsquecimento = true;

    try {
      const now = new Date();
      const DIAS_KEY = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];
      const hojeKey = DIAS_KEY[now.getDay()];

      const sellers = await (this.prisma as any).seller.findMany({
        where: {
          active: true,
          horarioTrabalho: { not: null },
        },
        select: { id: true, name: true, horarioTrabalho: true },
      });

      const alertas: Array<{ name: string; expected: string }> = [];
      const inicioDia = new Date(now);
      inicioDia.setHours(0, 0, 0, 0);

      for (const s of sellers) {
        let horario: any[] = [];
        try {
          horario = JSON.parse(s.horarioTrabalho) || [];
        } catch {
          continue;
        }
        const hoje = horario.find((h: any) => h.dia === hojeKey);
        if (!hoje || hoje.folga || !hoje.inicio) continue;

        // Horário previsto de entrada
        const [hh, mm] = hoje.inicio.split(':').map(Number);
        const previsto = new Date(now);
        previsto.setHours(hh, mm, 0, 0);

        // Já passou +60min do previsto?
        const diffMin = (now.getTime() - previsto.getTime()) / 60000;
        if (diffMin < 60 || diffMin > 240) continue; // só alerta entre 60-240min de atraso

        // Já bateu entrada hoje?
        const batida = await (this.prisma as any).pontoRegistro.findFirst({
          where: {
            sellerId: s.id,
            tipo: 'entrada',
            timestamp: { gte: inicioDia },
          },
        });
        if (batida) continue;

        alertas.push({ name: s.name, expected: hoje.inicio });
      }

      if (alertas.length > 0) {
        const top = alertas
          .slice(0, 5)
          .map((a) => `${a.name} (prev ${a.expected})`)
          .join(', ');
        const extra = alertas.length > 5 ? ` +${alertas.length - 5}` : '';
        try {
          await this.push.sendToAdmins({
            title: `Ponto — ${alertas.length} funcionária(s) sem bater entrada`,
            body: `${top}${extra}`,
            tag: 'ponto-esquecimento',
            url: '/retaguarda/rh/espelho-ponto',
          } as any);
        } catch (e: any) {
          this.logger.warn(`push falhou: ${e?.message}`);
        }
        this.logger.log(
          `[ponto-cron] esquecimentos detectados: ${alertas.length}`,
        );
      }
    } catch (e: any) {
      this.logger.error(`[ponto-cron] esquecimento falhou: ${e?.message}`);
    } finally {
      this.isCheckingEsquecimento = false;
    }
  }

  /** Dia 1 do mês às 02h — fechamento do mês anterior (log + push pro admin). */
  @Cron('0 2 1 * *', { name: 'ponto-fechamento-mensal' })
  async fechamentoMensal() {
    if (!this.enabled) return;

    const now = new Date();
    const ultimoMes = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const ano = ultimoMes.getFullYear();
    const mes = ultimoMes.getMonth() + 1;

    const inicio = new Date(ano, mes - 1, 1);
    const fim = new Date(ano, mes, 0, 23, 59, 59);

    const totalRegistros = await (this.prisma as any).pontoRegistro.count({
      where: { timestamp: { gte: inicio, lte: fim } },
    });

    this.logger.log(
      `[ponto-cron] FECHAMENTO ${String(mes).padStart(2, '0')}/${ano} — ${totalRegistros} batidas registradas`,
    );

    try {
      await this.push.sendToAdmins({
        title: `Ponto — Fechamento ${String(mes).padStart(2, '0')}/${ano}`,
        body: `${totalRegistros} batidas registradas no período. Revise o espelho.`,
        tag: 'ponto-fechamento',
        url: '/retaguarda/rh/espelho-ponto',
      } as any);
    } catch (e: any) {
      this.logger.warn(`push falhou: ${e?.message}`);
    }
  }
}
