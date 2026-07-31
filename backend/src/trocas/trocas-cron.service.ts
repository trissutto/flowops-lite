import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingService } from '../tracking/tracking.service';
import { EmailService } from '../email/email.service';
import { formatTrocaNumero } from './trocas.service';

/**
 * Alertas automáticos do Portal de Trocas (Fase 3).
 *
 * Cron HORÁRIO (minuto 15) com kill-switch: TROCAS_CRON=0 desliga.
 *
 * 1. Lembrete de reversa vencendo: código de postagem a ≤3 dias do prazo e
 *    ainda "aguardando_postagem" → 1 e-mail de lembrete (reversaLembreteAt).
 * 2. Auto-rastreio da DEVOLUÇÃO: trocas postadas/em transporte com rastreio
 *    (da cliente ou o próprio código reverso) → avança status pelo rastreio
 *    (postada → em_transporte → recebida) com evento na timeline.
 *    "recebida" ainda exige conferência humana — o cron NUNCA aprova nada.
 */
@Injectable()
export class TrocasCronService {
  private readonly logger = new Logger(TrocasCronService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracking: TrackingService,
    private readonly email: EmailService,
  ) {}

  private get enabled(): boolean {
    return process.env.TROCAS_CRON !== '0';
  }

  @Cron('0 15 * * * *', { name: 'trocas-alertas' })
  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      await this.lembretesReversa();
      await this.autoRastreio();
    } catch (e: any) {
      this.logger.warn(`trocas-cron falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  // ── 1. Reversa perto de vencer ──────────────────────────────────────

  private async lembretesReversa() {
    const em3dias = new Date(Date.now() + 3 * 86_400_000);
    const trocas = await (this.prisma as any).trocaSolicitacao.findMany({
      where: {
        status: 'aguardando_postagem',
        reversaCodigo: { not: null },
        reversaPrazo: { not: null, lte: em3dias, gte: new Date() },
        reversaLembreteAt: null,
        customerEmail: { not: null },
      },
      take: 30,
    });

    for (const t of trocas) {
      const numeroFmt = formatTrocaNumero(t.numero);
      const venc = new Date(t.reversaPrazo).toLocaleDateString('pt-BR');
      const ok = await this.email.send(
        t.customerEmail,
        `Lurds Plus Size — seu código de postagem vence em breve! ⏰`,
        `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2A2620">
          <h2 style="color:#8C7325">Olá! 💛</h2>
          <p>Passando pra lembrar que o código de postagem gratuita da sua troca <b>${numeroFmt}</b> vence em <b>${venc}</b>:</p>
          <p style="font-size:24px;font-weight:bold;background:#FBF6E6;border:2px dashed #B8912B;border-radius:12px;padding:16px;text-align:center;letter-spacing:2px">${t.reversaCodigo}</p>
          <p>É só levar a peça embalada a qualquer agência dos Correios com esse código. Depois do vencimento ele deixa de funcionar.</p>
          <p>Qualquer dúvida, estamos à disposição! 💛<br/>Equipe Lurds Plus Size</p>
        </div>`,
      );
      await (this.prisma as any).trocaSolicitacao.update({
        where: { id: t.id },
        data: {
          reversaLembreteAt: new Date(),
          eventos: {
            create: {
              tipo: 'email',
              descricao: ok
                ? `Lembrete automático enviado: código reverso vence em ${venc}.`
                : `Tentativa de lembrete do código reverso (vence ${venc}) — e-mail FALHOU.`,
            },
          },
        },
      });
      this.logger.log(`[trocas-cron] lembrete reversa ${numeroFmt} (vence ${venc}) email=${ok}`);
    }
  }

  // ── 2. Auto-rastreio da devolução ───────────────────────────────────

  private async autoRastreio() {
    const trocas = await (this.prisma as any).trocaSolicitacao.findMany({
      where: {
        status: { in: ['aguardando_postagem', 'postada', 'em_transporte'] },
        OR: [{ clienteTrackingCode: { not: null } }, { reversaCodigo: { not: null } }],
      },
      orderBy: { updatedAt: 'asc' },
      take: 20, // máx 20 consultas de rastreio por ciclo (free tier LinkeTrack)
    });

    for (const t of trocas) {
      const code = t.clienteTrackingCode || t.reversaCodigo;
      // Só consulta o que parece objeto rastreável (AA123456789BR)
      if (!code || !/^[A-Z]{2}\d{9}[A-Z]{2}$/i.test(code)) continue;

      const r = await this.tracking.fetchTracking(code);
      if (r.error || !r.events.length) continue;

      let novoStatus: string | null = null;
      if (r.delivered) novoStatus = 'recebida';
      else if (t.status !== 'em_transporte') novoStatus = 'em_transporte';
      if (!novoStatus || novoStatus === t.status) continue;

      await (this.prisma as any).trocaSolicitacao.update({
        where: { id: t.id },
        data: {
          status: novoStatus,
          eventos: {
            create: {
              tipo: 'status',
              descricao:
                novoStatus === 'recebida'
                  ? `Rastreio ${code}: devolução ENTREGUE — peça chegou. Registrar recebimento e conferir.`
                  : `Rastreio ${code}: devolução em transporte (${r.lastStatus || 'movimentação detectada'}).`,
              statusDe: t.status,
              statusPara: novoStatus,
              userName: 'cron-rastreio',
            },
          },
        },
      });
      this.logger.log(
        `[trocas-cron] ${formatTrocaNumero(t.numero)} ${t.status} → ${novoStatus} (rastreio ${code})`,
      );
    }
  }
}
