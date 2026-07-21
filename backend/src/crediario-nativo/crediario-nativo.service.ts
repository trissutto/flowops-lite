import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * CREDIÁRIO NATIVO — FASE 1: importação COMPLETA do `movimento` do Giga
 * (parcelas abertas E pagas — todo o histórico) pra `crediario_parcelas`.
 *
 * É a base do Tier 3 do "sair da Giga": com o ledger inteiro no Postgres,
 * a ficha da cliente mostra o crediário completo (como a tela do Giga
 * mostrava) e a fase 2 pluga as ESCRITAS (venda cria parcela no Flow,
 * baixa/estorno idem — Giga vira réplica via outbox).
 *
 * Full-replace preservando flowIsSource (fase 2). SELECT * paginado com
 * mapeamento dinâmico de colunas (nomes variam por instalação Wincred).
 * Sync: manual (botão no /retaguarda/wincred-mirror) + cron diário 04:10
 * gated WINCRED_MIRROR_CRON_ENABLED=1.
 */
@Injectable()
export class CrediarioNativoService {
  private readonly logger = new Logger(CrediarioNativoService.name);
  private running = false;
  private lastResult: { at: Date; total: number; erro?: string } | null = null;

  private static readonly PAGE = 10_000;
  private static readonly CHUNK = 1_000;
  private static readonly MAX_ROWS = 2_000_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  @Cron('10 4 * * *', { name: 'crediario-nativo-sync' })
  async cronDiario(): Promise<void> {
    if (process.env.WINCRED_MIRROR_CRON_ENABLED !== '1') return;
    try {
      const r = await this.syncAll();
      this.logger.log(`[crediario-nativo] sync diário: ${JSON.stringify(r)}`);
    } catch (e) {
      this.logger.error(`[crediario-nativo] sync diário falhou: ${(e as Error).message}`);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pick(row: Record<string, any>, ...res: RegExp[]): any {
    for (const re of res) {
      for (const key of Object.keys(row)) {
        if (re.test(key)) return row[key];
      }
    }
    return undefined;
  }

  private str(v: any, max = 250): string | null {
    if (v == null) return null;
    const s = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    const t = s.trim();
    return t ? t.slice(0, max) : null;
  }

  private intOf(v: any): number | null {
    if (v == null || v === '') return null;
    const n = parseInt(String(v), 10);
    return isFinite(n) ? n : null;
  }

  private numOf(v: any): number | null {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  private dateOf(v: any): Date | null {
    if (!v || String(v).startsWith('0000')) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    if (isNaN(d.getTime()) || d.getFullYear() < 1950) return null;
    return d;
  }

  /** Regra de PAGO — mesma do espelho de abertas: 'S'/'SIM' ou dataPagamento. */
  private pagoOf(row: Record<string, any>): { pago: boolean; dataPagamento: Date | null } {
    const flag = this.str(this.pick(row, /^pago$/i, /^pg$/i, /^baixado$/i, /^quitado$/i), 5);
    const dataPag = this.dateOf(this.pick(row, /^pagamento$/i, /^data_?pagamento$/i, /^datapagto$/i, /^data_?baixa$/i, /^datapag$/i));
    const pagoFlag = flag != null && ['S', 'SIM'].includes(flag.toUpperCase());
    return { pago: pagoFlag || (flag == null && !!dataPag), dataPagamento: dataPag };
  }

  private mapRow(row: Record<string, any>): Record<string, any> | null {
    const registro = this.str(this.pick(row, /^registro$/i, /^id$/i), 20);
    if (!registro) return null;
    const loja = (this.str(this.pick(row, /^loja$/i, /^cod_?loja$/i, /^filial$/i), 4) || '00').padStart(2, '0');
    const { pago, dataPagamento } = this.pagoOf(row);
    return {
      registro,
      controle: this.str(this.pick(row, /^controle$/i), 20),
      numeroCompra: this.str(this.pick(row, /^numero_?compra$/i, /^numerocompra$/i, /^numero$/i, /^compra$/i), 20),
      loja,
      codCliente: this.str(this.pick(row, /^cod_?cliente$/i, /^codcliente$/i, /^cliente$/i, /^codcli$/i), 20),
      nomeCliente: this.str(this.pick(row, /^nome$/i, /^nome_?cliente$/i), 120),
      parcela: this.intOf(this.pick(row, /^parcela$/i, /^num_?parcela$/i)),
      totalParcelas: this.intOf(this.pick(row, /^total_?parcelas$/i, /^totalparcelas$/i, /^n_?parc(elas)?$/i, /^qtd_?parcelas$/i)),
      dataCompra: this.dateOf(this.pick(row, /^data_?compra$/i, /^datacompra$/i, /^data$/i, /^emissao$/i)),
      valorCompra: this.numOf(this.pick(row, /^valor_?compra$/i, /^valorcompra$/i, /^vlr_?compra$/i)),
      vencimento: this.dateOf(this.pick(row, /^vencimento$/i, /^data_?venc/i, /^dt_?venc/i)),
      valorParcela: this.numOf(this.pick(row, /^valor_?parcela$/i, /^valorparcela$/i, /^valor$/i, /^vlr_?parcela$/i)),
      pago,
      dataPagamento,
      valorPago: this.numOf(this.pick(row, /^valor_?pago$/i, /^valorpago$/i, /^vlrpago$/i)),
      juros: this.numOf(this.pick(row, /^juros$/i, /^vlr_?juros$/i)),
      multa: this.numOf(this.pick(row, /^multa$/i, /^vlr_?multa$/i)),
      obs: this.str(this.pick(row, /^obs$/i, /^observacao$/i), 300),
    };
  }

  // ── sync ─────────────────────────────────────────────────────────────────

  startBackground(): { started: boolean; alreadyRunning: boolean } {
    if (this.running) return { started: false, alreadyRunning: true };
    void this.syncAll();
    return { started: true, alreadyRunning: false };
  }

  async syncAll(): Promise<{ ok: boolean; total: number; paginas: number; erro?: string }> {
    if (this.running) return { ok: false, total: 0, paginas: 0, erro: 'sync já em andamento' };
    this.running = true;
    const t0 = Date.now();
    try {
      const pool: any = (this.erp as any).pool;
      if (!pool) throw new Error('pool Giga não inicializado');

      // Preserva as parcelas do FLOW (fase 2); refaz só o que veio do Giga.
      await (this.prisma as any).crediarioParcela.deleteMany({ where: { flowIsSource: false } });

      let total = 0;
      let paginas = 0;
      for (let offset = 0; offset < CrediarioNativoService.MAX_ROWS; offset += CrediarioNativoService.PAGE) {
        const [rows] = await pool.query({
          sql: `SELECT * FROM \`movimento\` ORDER BY \`REGISTRO\` LIMIT ${CrediarioNativoService.PAGE} OFFSET ${offset}`,
          timeout: 120_000,
        });
        const batch = rows as any[];
        if (!batch.length) break;
        paginas++;

        const data = batch
          .map((row) => this.mapRow(row))
          .filter((r): r is NonNullable<ReturnType<CrediarioNativoService['mapRow']>> => !!r);

        for (let i = 0; i < data.length; i += CrediarioNativoService.CHUNK) {
          await (this.prisma as any).crediarioParcela.createMany({
            data: data.slice(i, i + CrediarioNativoService.CHUNK),
            skipDuplicates: true,
          });
        }
        total += data.length;
        if (paginas % 5 === 0) this.logger.log(`[crediario-nativo] página ${paginas}: total ${total}`);
        if (batch.length < CrediarioNativoService.PAGE) break;
      }

      this.lastResult = { at: new Date(), total };
      this.logger.log(`[crediario-nativo] sync completo: ${total} parcelas em ${Math.round((Date.now() - t0) / 1000)}s`);
      return { ok: true, total, paginas };
    } catch (e: any) {
      const erro = String(e?.message || e);
      this.lastResult = { at: new Date(), total: 0, erro };
      this.logger.error(`[crediario-nativo] sync falhou: ${erro}`);
      return { ok: false, total: 0, paginas: 0, erro };
    } finally {
      this.running = false;
    }
  }

  async status() {
    const [total, abertas, pagas, vencidas, ultimo] = await Promise.all([
      (this.prisma as any).crediarioParcela.count(),
      (this.prisma as any).crediarioParcela.count({ where: { pago: false } }),
      (this.prisma as any).crediarioParcela.count({ where: { pago: true } }),
      (this.prisma as any).crediarioParcela.count({ where: { pago: false, vencimento: { lt: new Date() } } }),
      (this.prisma as any).crediarioParcela.findFirst({ orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } }),
    ]);
    return { total, abertas, pagas, vencidas, ultimoSync: ultimo?.syncedAt || null, rodando: this.running, ultimoResultado: this.lastResult };
  }
}
