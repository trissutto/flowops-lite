import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { calcularFerias } from '../common/ferias-clt';

/**
 * SellersCronService — alertas RH automáticos.
 *
 * Rotina diária (8h da manhã): funcionárias cujo prazo de CONCEDER férias está
 * a 90 dias ou menos, sem `dataInicioFerias` marcada → push pros admins.
 *
 * ── O QUE ESTAVA ERRADO AQUI ATÉ 01/08/2026 ──
 *
 * O alerta olhava o aniversário do período AQUISITIVO — a data em que a
 * funcionária GANHA o direito. Nessa data não há nada a fazer: o prazo pra
 * conceder só começa aí e vai até 12 meses depois (art. 134). Ou seja, ele
 * avisava com mais de um ano de antecedência do que importa, e o comentário
 * antigo desta seção dizia "11 meses após o INÍCIO do aquisitivo" — é após o
 * FIM dele.
 *
 * Pior: com `diasRestantes < 0` ele parava de avisar assim que a data passava.
 * O aviso sumia exatamente quando o problema começava a custar dinheiro.
 *
 * Agora o marco é o `limiteInicio` de `common/ferias-clt.ts` — o último dia
 * pra INICIAR 30 dias sem estourar o concessivo — e o alerta não some depois
 * de vencido.
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

      // ── CORRIGIDO 01/08: este alerta olhava o marco ERRADO ──
      //
      // Ele avisava quando o PERÍODO AQUISITIVO ia fechar — ou seja, quando a
      // funcionária estava PRESTES A GANHAR o direito. Isso é mais de um ano
      // antes do prazo real, e não há nada a fazer nessa data.
      //
      // O prazo que importa é o do período CONCESSIVO: o último dia pra
      // INICIAR as férias sem estourar. Passado ele, art. 137 — dobra.
      const f = calcularFerias(adm, { hoje: now });

      // Ainda no primeiro ano de casa: não há prazo a cobrar.
      if (f.situacao === 'aquisitivo') continue;

      const diasRestantes = f.diasAteLimite;
      const proximoCiclo = f.limiteInicio;

      // Alerta a partir de 90 dias do limite — e NUNCA para de alertar depois
      // de vencido. Antes, `diasRestantes < 0` fazia o aviso sumir justamente
      // no dia em que passou a custar dinheiro.
      if (diasRestantes > 90) continue;

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
