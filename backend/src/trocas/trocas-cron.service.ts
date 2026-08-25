import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TrackingService } from '../tracking/tracking.service';
import { EmailService } from '../email/email.service';
import { formatTrocaNumero, TrocasService } from './trocas.service';

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
    private readonly trocas: TrocasService,
  ) {}

  private get enabled(): boolean {
    return process.env.TROCAS_CRON !== '0';
  }

  @Cron('0 15 * * * *', { name: 'trocas-alertas' })
  async tick() {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      await this.reversasPendentes();
      await this.avisosReversaPendentes();
      await this.lembretesReversa();
      await this.autoRastreio();
    } catch (e: any) {
      this.logger.warn(`trocas-cron falhou: ${e?.message || e}`);
    } finally {
      this.running = false;
    }
  }

  // ── 0. Reversa que ninguém gerou ────────────────────────────────────

  /**
   * REDE DE SEGURANÇA DO CÓDIGO DE POSTAGEM (14/08).
   *
   * A geração passou a ser automática no `solicitar`, mas Correios fora do ar
   * na hora exata da solicitação deixaria a cliente esperando de novo — que é
   * exatamente o estado que este cron nasceu pra matar: na medição de 14/08
   * havia **12 trocas abertas e ZERO códigos gerados**, a mais antiga parada
   * há 17 dias, porque a etapa dependia de alguém lembrar de clicar.
   *
   * Pega qualquer troca com direito à reversa e sem código — inclusive as
   * antigas. Máx 10 por ciclo: cada uma é uma pré-postagem de verdade nos
   * Correios, e erro em lote é pior que demora.
   */
  private async reversasPendentes() {
    if (String(process.env.TROCA_REVERSA_AUTO ?? '1').trim() === '0') return;
    const pendentes = await (this.prisma as any).trocaSolicitacao.findMany({
      where: {
        reversaGratis: true,
        reversaCodigo: null,
        status: { in: ['solicitada', 'aguardando_postagem', 'aguardando_envio_cliente'] },
      },
      select: { id: true, numero: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    for (const t of pendentes) {
      try {
        const r: any = await this.trocas.gerarReversaCorreios({ id: t.id, userName: 'automático (cron)' });
        this.logger.log(`[trocas-cron] reversa gerada pra ${formatTrocaNumero(t.numero)}: ${r?.codigo}`);
      } catch (e: any) {
        // Sem CEP, sem pedido, Correios fora — fica pro próximo ciclo. O
        // motivo vai pro log; a troca continua visível na retaguarda.
        this.logger.warn(`[trocas-cron] reversa de ${formatTrocaNumero(t.numero)} falhou: ${e?.message || e}`);
      }
    }
  }

  /**
   * CÓDIGO GERADO MAS NUNCA ENTREGUE — reenvia até chegar.
   *
   * O buraco de 14/08: cinco etiquetas geradas nos Correios, cinco avisos
   * de WhatsApp falhando, e NADA tentava de novo. `reversasPendentes` só
   * olha troca SEM código; troca COM código e sem aviso ficava esquecida
   * até a cliente reclamar (Débora, troca 12, reclamou duas vezes). Este
   * passo fecha o buraco: enquanto `reversaEnviadaAt` for nulo e o código
   * ainda valer, tenta mandar a cada ciclo. Sessão do WhatsApp caída é a
   * causa mais provável — quando ela voltar, isto drena a fila sozinho.
   */
  private async avisosReversaPendentes() {
    const pendentes = await (this.prisma as any).trocaSolicitacao.findMany({
      where: {
        reversaCodigo: { not: null },
        reversaEnviadaAt: null,
        status: { in: ['aguardando_postagem', 'solicitada', 'aguardando_envio_cliente'] },
        OR: [{ reversaPrazo: null }, { reversaPrazo: { gte: new Date() } }],
      },
      select: { id: true, numero: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    if (!pendentes.length) return;
    let ok = 0;
    let motivo = '';
    for (const t of pendentes) {
      const r = await this.trocas.reenviarCodigoReversa(t.id);
      if (r.ok) ok++;
      else motivo = r.motivo || motivo;
      // Baileys trava se falar em paralelo — respira entre uma e outra.
      await new Promise((res) => setTimeout(res, 1500));
    }
    if (ok < pendentes.length) {
      // WARN de propósito: isto tem que aparecer. É código de postagem que a
      // cliente está esperando — e reclamando no WhatsApp da loja.
      this.logger.warn(
        `[trocas-cron] ${pendentes.length - ok} código(s) de postagem AINDA não entregue(s) — nem WhatsApp nem e-mail (${motivo || 'motivo desconhecido'}). Trocas: ` +
          pendentes.map((t: any) => formatTrocaNumero(t.numero)).join(', '),
      );
    } else {
      this.logger.log(`[trocas-cron] ${ok} código(s) de postagem reenviado(s) pra cliente`);
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

      /**
       * "Etiqueta emitida"/"Etiqueta cancelada pelo sistema de captação" NÃO
       * são movimento do objeto — a pré-postagem NASCE com um desses eventos,
       * antes de a cliente sequer saber o código. Tratar isso como transporte
       * (bug até 21/08) empurrava a troca pra 'em_transporte' no primeiro
       * ciclo, e o reenvio do código (`avisosReversaPendentes`, que só olha
       * aguardando_postagem/solicitada) parava de tentar: TODAS as trocas com
       * código ficaram sem WhatsApp.
       */
      const ehDaReversa = !t.clienteTrackingCode && code === t.reversaCodigo;
      const movimentos = r.events.filter((e) => !/^\s*etiqueta\b/i.test(e.description || ''));
      const etiquetaCancelada = r.events.some((e) => /etiqueta cancelada/i.test(e.description || ''));

      /**
       * Etiqueta CANCELADA pelos Correios sem o objeto nunca ter andado =
       * código morto na mão da cliente (dá "inválido" no balcão — as trocas
       * 15–20, itens com "—"/"·" na declaração de conteúdo). Descarta o código
       * e gera outro na hora; se os Correios falharem agora, o
       * `reversasPendentes` do próximo ciclo termina o serviço.
       */
      if (ehDaReversa && etiquetaCancelada && !movimentos.length) {
        await (this.prisma as any).trocaSolicitacao.update({
          where: { id: t.id },
          data: {
            reversaCodigo: null,
            reversaPrazo: null,
            reversaEnviadaAt: null,
            reversaLembreteAt: null,
            status: 'aguardando_postagem',
            eventos: {
              create: {
                tipo: 'reversa',
                descricao: `Código ${code} estava CANCELADO nos Correios (etiqueta recusada pelo sistema de captação) — descartado. Gerando um novo código pra cliente.`,
                userName: 'cron-rastreio',
              },
            },
          },
        });
        try {
          const novo: any = await this.trocas.gerarReversaCorreios({ id: t.id, userName: 'automático (cron)' });
          this.logger.warn(
            `[trocas-cron] ${formatTrocaNumero(t.numero)}: código ${code} CANCELADO nos Correios → novo ${novo?.codigo}`,
          );
        } catch (e: any) {
          this.logger.warn(
            `[trocas-cron] ${formatTrocaNumero(t.numero)}: código ${code} cancelado e a regeração falhou (${e?.message || e}) — reversasPendentes tenta no próximo ciclo`,
          );
        }
        continue;
      }

      if (!movimentos.length) {
        // Só "Etiqueta emitida": a cliente ainda não postou. Se um ciclo do
        // bug antigo já tinha empurrado pra em_transporte, volta — senão o
        // reenvio do código nunca mais olha esta troca.
        if (ehDaReversa && t.status === 'em_transporte') {
          await (this.prisma as any).trocaSolicitacao.update({
            where: { id: t.id },
            data: {
              status: 'aguardando_postagem',
              eventos: {
                create: {
                  tipo: 'status',
                  descricao: `Rastreio ${code}: etiqueta emitida mas SEM postagem — a peça ainda não foi levada aos Correios. Status corrigido.`,
                  statusDe: t.status,
                  statusPara: 'aguardando_postagem',
                  userName: 'cron-rastreio',
                },
              },
            },
          });
          this.logger.log(`[trocas-cron] ${formatTrocaNumero(t.numero)} em_transporte → aguardando_postagem (só etiqueta emitida)`);
        }
        continue;
      }

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
