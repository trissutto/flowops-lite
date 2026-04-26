import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RealtimeGateway } from '../websocket/realtime.gateway';

/**
 * RealignmentAutoService — sugestão automática diária de realinhamento.
 *
 * Idéia: todo dia o cron olha REFs cadastradas no Giga há N dias atrás
 * (default 31) com filtro de descrição (default "PLUS SIZE") e cria uma
 * sugestão pendente que aparece na tela /retaguarda/realinhamento pra
 * Thiago revisar e disparar (ou descartar).
 *
 * Por que NÃO dispara automático:
 *   - Erro em escala destrói operação. Melhor revisar 1x ao dia.
 *   - Se quiser full-automático no futuro, é trivial trocar.
 *
 * Configuração via SystemSetting:
 *   - realignment_auto_enabled: 'true' | 'false' (default false)
 *   - realignment_auto_dias_atras: número (default 31)
 *   - realignment_auto_descricao_filter: string (default 'PLUS SIZE')
 *   - realignment_auto_pending: JSON com últimas sugestões pendentes
 */
@Injectable()
export class RealignmentAutoService {
  private readonly logger = new Logger(RealignmentAutoService.name);

  private readonly KEY_ENABLED = 'realignment_auto_enabled';
  private readonly KEY_DIAS = 'realignment_auto_dias_atras';
  private readonly KEY_DESC = 'realignment_auto_descricao_filter';
  private readonly KEY_PENDING = 'realignment_auto_pending';

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly gateway: RealtimeGateway,
  ) {}

  // ── Config ─────────────────────────────────────────────────────────

  private async getSetting(key: string): Promise<string | null> {
    const r = await (this.prisma as any).systemSetting.findUnique({ where: { key } });
    return r?.value ?? null;
  }

  private async setSetting(key: string, value: string): Promise<void> {
    await (this.prisma as any).systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  async getConfig(): Promise<{
    enabled: boolean;
    diasAtras: number;
    descricaoFilter: string;
  }> {
    const [enabled, dias, desc] = await Promise.all([
      this.getSetting(this.KEY_ENABLED),
      this.getSetting(this.KEY_DIAS),
      this.getSetting(this.KEY_DESC),
    ]);
    return {
      enabled: enabled === 'true',
      diasAtras: dias ? Math.max(1, parseInt(dias, 10)) : 31,
      descricaoFilter: desc ?? 'PLUS SIZE',
    };
  }

  async updateConfig(input: {
    enabled?: boolean;
    diasAtras?: number;
    descricaoFilter?: string;
  }): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (input.enabled !== undefined) {
      tasks.push(this.setSetting(this.KEY_ENABLED, String(input.enabled)));
    }
    if (input.diasAtras !== undefined) {
      const n = Math.max(1, Math.min(365, Math.floor(Number(input.diasAtras))));
      tasks.push(this.setSetting(this.KEY_DIAS, String(n)));
    }
    if (input.descricaoFilter !== undefined) {
      tasks.push(this.setSetting(this.KEY_DESC, String(input.descricaoFilter || '').trim()));
    }
    await Promise.all(tasks);
  }

  // ── Sugestões pendentes ───────────────────────────────────────────

  async getPending(): Promise<{
    generatedAt: string | null;
    diasAtras: number | null;
    dataAlvo: string | null;
    refs: Array<{ ref: string; descricao: string; variantCount: number; dataCadastro: string | null }>;
  }> {
    const raw = await this.getSetting(this.KEY_PENDING);
    if (!raw) return { generatedAt: null, diasAtras: null, dataAlvo: null, refs: [] };
    try {
      return JSON.parse(raw);
    } catch {
      return { generatedAt: null, diasAtras: null, dataAlvo: null, refs: [] };
    }
  }

  async dismissPending(): Promise<void> {
    await this.setSetting(this.KEY_PENDING, JSON.stringify({
      generatedAt: null,
      diasAtras: null,
      dataAlvo: null,
      refs: [],
    }));
  }

  // ── Execução (cron + manual) ──────────────────────────────────────

  /**
   * Cron diário às 06:00 (horário do servidor — América/São_Paulo via TZ).
   * Roda independente de qualquer usuário logado. Se enabled=false, sai.
   */
  @Cron('0 6 * * *')
  async runDailyJob(): Promise<void> {
    try {
      await this.runOnce();
    } catch (e) {
      this.logger.error(`[realignment-auto] cron falhou: ${(e as Error).message}`);
    }
  }

  /**
   * Execução manual (botão "Rodar agora" pra testar configuração).
   */
  async runManual(): Promise<{
    ok: boolean;
    enabled: boolean;
    refsFound: number;
    dataAlvo: string;
  }> {
    return this.runOnce({ manual: true });
  }

  private async runOnce(opts: { manual?: boolean } = {}): Promise<{
    ok: boolean;
    enabled: boolean;
    refsFound: number;
    dataAlvo: string;
  }> {
    const cfg = await this.getConfig();
    if (!cfg.enabled && !opts.manual) {
      this.logger.log('[realignment-auto] desabilitado, skip');
      return { ok: true, enabled: false, refsFound: 0, dataAlvo: '' };
    }

    // Calcula data alvo (N dias atrás, dia inteiro)
    const dataAlvo = new Date();
    dataAlvo.setUTCDate(dataAlvo.getUTCDate() - cfg.diasAtras);
    dataAlvo.setUTCHours(0, 0, 0, 0);
    const fim = new Date(dataAlvo);
    fim.setUTCDate(fim.getUTCDate() + 1);

    const refs = await this.erp.searchRefsByDateRange({
      inicio: dataAlvo,
      fim,
      descricaoContains: cfg.descricaoFilter || undefined,
    });

    const dataAlvoStr = dataAlvo.toISOString().slice(0, 10);
    this.logger.log(
      `[realignment-auto] ${refs.length} REF(s) encontradas pra data ${dataAlvoStr} (filtro="${cfg.descricaoFilter}")`,
    );

    // Salva como pendente (mesmo se zero — UI mostra "nada novo hoje")
    await this.setSetting(
      this.KEY_PENDING,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        diasAtras: cfg.diasAtras,
        dataAlvo: dataAlvoStr,
        refs,
      }),
    );

    // Alerta socket pra retaguarda se tem coisa nova
    if (refs.length > 0) {
      try {
        this.gateway.emitToAdmins('realignment-auto:new', {
          count: refs.length,
          dataAlvo: dataAlvoStr,
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        // não bloqueia
      }
    }

    return {
      ok: true,
      enabled: cfg.enabled,
      refsFound: refs.length,
      dataAlvo: dataAlvoStr,
    };
  }
}
