import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CrediariosService } from './crediarios.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { WhatsappCobrancaService } from '../whatsapp/whatsapp-cobranca.service';
import {
  CobrancaContext, ParcelaCobranca, renderCobranca,
} from './cobranca-templates';

/**
 * CobrancaAutoService — disparador automático de cobrança server-side.
 *
 * Roda a cada 5 minutos via @Cron. Para cada CobrancaCampanha ativa:
 *   1. Verifica se está dentro da janela de horário (hora_inicio ≤ now ≤ hora_fim)
 *   2. Verifica se proximoEnvio já chegou (NULL = manda hoje)
 *   3. Lista clientes em atraso da loja, aplicando minDiasAtraso/maxDiasAtraso
 *   4. Pra cada cliente:
 *       - se já tem CobrancaTentativa OK na janela de frequência → skip
 *       - se está em opt-out (WaOptOut) → skip
 *       - senão → envia + grava CobrancaTentativa
 *   5. Atualiza ultimoEnvio, proximoEnvio (próximo slot conforme frequencia)
 *
 * Frequências (string):
 *   '1x_dia'      → 24h entre tentativas / mesmo cliente
 *   '2x_dia'      → 12h
 *   'cada_2_dias' → 48h
 *   'cada_3_dias' → 72h
 *   'semanal'     → 168h
 *
 * Anti-ban: usa wa.sendBulk com delayMs configurável da campanha (default 2min).
 *
 * Idempotência: cada campanha tem flag `running` em memória pra não sobrepor
 * execuções (cron de 5min, mas batch de 100 mensagens × 2min = 3h+).
 */
@Injectable()
export class CobrancaAutoService {
  private readonly logger = new Logger(CobrancaAutoService.name);
  private runningCampanhas = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: CrediariosService,
    private readonly wa: WhatsappService,
    private readonly waCobranca: WhatsappCobrancaService,
  ) {}

  /**
   * Cron principal: roda a cada 5min.
   * Em produção isso garante que os disparos comecem rapidamente (tolerância
   * de até 5min entre o "horário programado" e o disparo real).
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick() {
    try {
      await this.runInner();
    } catch (e: any) {
      this.logger.error(`Cron cobrança auto falhou: ${e?.message ?? e}`);
    }
  }

  /** Disparo manual via endpoint (pra QA / "rodar agora").
   *  IMPORTANTE: dispara em BACKGROUND e retorna imediatamente — porque o
   *  delay anti-ban entre mensagens (3min default) faz o processo demorar
   *  HORAS pra muitos clientes. Frontend não pode ficar esperando.
   *  Acompanhar progresso pelo histórico. */
  async runManual(campanhaId?: string) {
    // Verifica se já está rodando essa campanha (pra dar feedback claro)
    if (campanhaId && this.runningCampanhas.has(campanhaId)) {
      return {
        started: false,
        already_running: true,
        message: 'Campanha já está executando. Aguarde o ciclo atual terminar ou use Pausar.',
      };
    }
    // Dispara em background — NÃO await
    this.runInner(campanhaId).catch((e) => {
      this.logger.error(`[runManual BG] cobrança auto falhou: ${e?.message ?? e}`);
    });
    return {
      started: true,
      message: 'Campanha iniciada em background. Acompanhe pelo Histórico — pode demorar minutos/horas dependendo da quantidade de clientes (delay anti-ban entre mensagens).',
    };
  }

  private async runInner(onlyCampanhaId?: string) {
    const now = new Date();
    const where: any = { ativa: true };
    if (onlyCampanhaId) where.id = onlyCampanhaId;

    const campanhas = await (this.prisma as any).cobrancaCampanha.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    if (!campanhas.length) return { ran: 0, skipped: 0 };

    let ran = 0;
    let skipped = 0;

    for (const camp of campanhas) {
      // Se não foi forçado manualmente, valida janela de horário e proximoEnvio
      if (!onlyCampanhaId) {
        if (!isWithinWindow(now, camp.horaInicio, camp.horaFim)) {
          skipped++;
          continue;
        }
        if (camp.proximoEnvio && now < new Date(camp.proximoEnvio)) {
          skipped++;
          continue;
        }
      }

      if (this.runningCampanhas.has(camp.id)) {
        this.logger.warn(`Campanha ${camp.nome} já está executando — pulando ciclo`);
        skipped++;
        continue;
      }

      this.runningCampanhas.add(camp.id);
      try {
        await this.runOne(camp);
        ran++;
      } catch (e: any) {
        this.logger.error(`Campanha ${camp.id} (${camp.nome}) falhou: ${e?.message ?? e}`);
      } finally {
        this.runningCampanhas.delete(camp.id);
      }
    }

    return { ran, skipped };
  }

  /**
   * Executa UMA campanha:
   *   1. Monta queue (lista clientes elegíveis)
   *   2. Filtra os que JÁ receberam dentro da janela de frequência
   *   3. Filtra opt-outs (WaOptOut)
   *   4. Verifica WhatsApp conectado
   *   5. Envia cada um, grava CobrancaTentativa
   *   6. Atualiza ultimoEnvio + proximoEnvio
   */
  private async runOne(camp: any) {
    const t0 = Date.now();
    this.logger.log(`▶ Iniciando campanha "${camp.nome}" (loja ${camp.lojaCode})`);

    // Janela de "já recebeu"
    const cooldownMs = cooldownForFrequencia(camp.frequencia);
    const cutoff = new Date(Date.now() - cooldownMs);

    // Monta lista de clientes em atraso
    const data = await this.svc.listOverdueByCustomer({
      storeCode: camp.lojaCode,
      daysBack: 3650, // tudo em aberto
    });

    const minDias = camp.minDiasAtraso ?? 3;
    const maxDias = camp.maxDiasAtraso ?? null;

    this.logger.log(
      `[debug] Campanha "${camp.nome}": listOverdueByCustomer trouxe ${data.customers.length} cliente(s) ` +
      `na loja ${camp.lojaCode}. Filtros: minDias=${minDias}, maxDias=${maxDias ?? 'sem limite'}`,
    );

    // Verifica WhatsApp DEDICADO de cobrança (não o do site).
    // O envio acontece via this.waCobranca.sendText, então a checagem
    // tem que ser no MESMO serviço que vai disparar.
    let cobrancaConnected = true;
    try {
      const cobrancaStatus = (this.waCobranca as any).getStatus?.();
      if (cobrancaStatus && cobrancaStatus.connected === false) {
        cobrancaConnected = false;
      }
    } catch { /* ignora — alguns adapters não expõem getStatus */ }

    if (!cobrancaConnected) {
      this.logger.warn(
        `Campanha "${camp.nome}" — WhatsApp DE COBRANÇA desconectado. Reagendando 30min.`,
      );
      await (this.prisma as any).cobrancaCampanha.update({
        where: { id: camp.id },
        data: { proximoEnvio: new Date(Date.now() + 30 * 60_000) },
      });
      return;
    }

    const testPhone = (process.env.COBRANCA_TEST_PHONE || '').replace(/\D/g, '') || null;
    const testMode = !!testPhone;

    // Filtros: cooldown + opt-out + atraso
    const optOuts = await (this.prisma as any).waOptOut.findMany({ select: { phone: true } });
    const optOutSet = new Set<string>(optOuts.map((o: any) => String(o.phone).replace(/\D/g, '')));

    const cfg = await this.svc.getEditableTemplates();

    let seq = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const c of data.customers) {
      // Filtro de atraso
      if (c.diasAtraso < minDias) { skipped++; continue; }
      if (maxDias && c.diasAtraso > maxDias) { skipped++; continue; }

      const tel = c.telefone ? String(c.telefone).replace(/\D/g, '') : '';
      if (!tel && !testMode) { skipped++; continue; }
      if (tel && optOutSet.has(tel)) { skipped++; continue; }

      // Cooldown: já mandou nas últimas N horas?
      const ultimaTentativa = await (this.prisma as any).cobrancaTentativa.findFirst({
        where: {
          campanhaId: camp.id,
          codCliente: c.codCliente,
          status: 'ok',
          enviadaEm: { gt: cutoff },
        },
        orderBy: { enviadaEm: 'desc' },
      });
      if (ultimaTentativa) { skipped++; continue; }

      // Renderiza
      const parcelas: ParcelaCobranca[] = c.parcelas.map((p: any) => ({
        vencimento: String(p.vencimento || '').slice(0, 10),
        valor: Math.max(0, Number(p.valorParcela ?? 0) - Number(p.valorPago ?? 0)),
        parcela: p.parcela ? Number(p.parcela) : undefined,
        totalParcelas: p.totalParcelas ? Number(p.totalParcelas) : undefined,
      }));
      const dayOffset = Math.floor((Date.now() - new Date(camp.createdAt).getTime()) / 86_400_000);
      const ctx: CobrancaContext = {
        nome: c.nome,
        parcelas,
        lojaNome: cfg.lojaNome,
      };
      const { text, templateIndex } = renderCobranca(ctx, seq, dayOffset, cfg.templates);

      const usedNumber = testMode ? testPhone! : tel;

      // Re-check janela de horário ANTES de cada envio (rodadas longas).
      // Em modo teste pula esse gate pra agilizar QA.
      if (!testMode) {
        const sched = await this.waCobranca.isWithinSchedule();
        if (!sched.ok) {
          this.logger.warn(`[cobranca-auto] aborto: fora da janela (${sched.reason})`);
          break;
        }
      }

      try {
        // USA WhatsApp DEDICADO de cobrança (não o do site)
        const r = await this.waCobranca.sendText(usedNumber, text);
        const ok = !!r.ok;
        await (this.prisma as any).cobrancaTentativa.create({
          data: {
            campanhaId: camp.id,
            codCliente: c.codCliente,
            nome: c.nome,
            telefone: usedNumber,
            telefoneOriginal: c.telefone || null,
            templateIndex,
            mensagem: text,
            status: ok ? 'ok' : 'falha',
            erro: ok ? null : (r.error || 'falha desconhecida'),
          },
        });
        if (ok) sent++; else failed++;
      } catch (e: any) {
        failed++;
        await (this.prisma as any).cobrancaTentativa.create({
          data: {
            campanhaId: camp.id,
            codCliente: c.codCliente,
            nome: c.nome,
            telefone: usedNumber,
            telefoneOriginal: c.telefone || null,
            templateIndex,
            mensagem: text,
            status: 'falha',
            erro: e?.message || String(e),
          },
        });
      }

      seq++;

      // Anti-ban: espera entre mensagens (delayMs da campanha)
      const delayMs = Math.max(60_000, Math.min(600_000, camp.delayMs ?? 120_000));
      if (seq < data.customers.length) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // Próximo envio = agora + cooldown
    const nextRun = new Date(Date.now() + cooldownForFrequencia(camp.frequencia));

    await (this.prisma as any).cobrancaCampanha.update({
      where: { id: camp.id },
      data: {
        ultimoEnvio: new Date(),
        proximoEnvio: nextRun,
        totalEnviadas: { increment: sent },
      },
    });

    this.logger.log(
      `✔ Campanha "${camp.nome}": ${sent} enviadas, ${failed} falhas, ${skipped} skip — ` +
      `${((Date.now() - t0) / 60_000).toFixed(1)}min — próximo: ${nextRun.toISOString()}`,
    );
  }
}

// ============== helpers ==============

/**
 * Verifica se o horário atual está dentro da janela "HH:MM" → "HH:MM".
 * Suporta janela que cruza meia-noite (ex: 22:00 → 06:00).
 */
function isWithinWindow(now: Date, horaInicio: string, horaFim: string): boolean {
  const [hi, mi] = horaInicio.split(':').map(Number);
  const [hf, mf] = horaFim.split(':').map(Number);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const startMin = (hi || 0) * 60 + (mi || 0);
  const endMin = (hf || 0) * 60 + (mf || 0);

  if (startMin === endMin) return true; // 24h
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin <= endMin;
  }
  // janela cruza meia-noite
  return nowMin >= startMin || nowMin <= endMin;
}

/** Quantas horas (em ms) entre 2 disparos consecutivos pro MESMO cliente. */
function cooldownForFrequencia(freq: string): number {
  const H = 3_600_000;
  switch (freq) {
    case '2x_dia':       return 12 * H;
    case '1x_dia':       return 24 * H;
    case 'cada_2_dias':  return 48 * H;
    case 'cada_3_dias':  return 72 * H;
    case 'semanal':      return 7 * 24 * H;
    default:             return 24 * H;
  }
}
