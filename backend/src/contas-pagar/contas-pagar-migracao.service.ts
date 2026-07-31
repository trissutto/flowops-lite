import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * MIGRAÇÃO do Contas a Pagar GIGA → FLOW (Fases 1+3 do plano).
 * Dossiê-contrato: docs/GIGA-CONTAS-DESCOBERTA.md. Decisão do dono (11/07):
 * 100% Flow — migra o histórico UMA vez (idempotente) e o GIGA congela.
 *
 * ⚠️ EM BACKGROUND (11/07, lição do caso real): a 1ª rodada travou no meio
 * porque o botão esperava a migração NA MESMA requisição HTTP e o proxy corta
 * em ~5min — MESMA armadilha do "Sync Completo" do Wincred (02/07). Agora:
 * start* responde na hora, o progresso fica em memória (GET progresso) e o
 * clique duplo é travado. A migração processa em LOTES (createMany) e PULA os
 * registros já migrados — re-rodar continua de onde parou, nunca duplica.
 */
@Injectable()
export class ContasPagarMigracaoService {
  private readonly logger = new Logger(ContasPagarMigracaoService.name);
  private readonly BATCH = 3000;
  private readonly INSERT_BATCH = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  // ── DE-PARA de espécie (dossiê §4.1) — original SEMPRE preservado ─────────
  private static readonly ESPECIE_DEPARA: Record<string, string> = {
    AGUA: 'AGUA', ALUGUEIS: 'ALUGUEIS', BOLETO: 'BOLETO', DEPOSITO: 'DEPOSITO',
    DUPLICATA: 'DUPLICATA', ENERGIA: 'ENERGIA', IMPOSTO: 'IMPOSTO',
    INTERNET: 'INTERNET', OUTROS: 'OUTROS', RH: 'RH', VALE: 'VALE',
    DUPLI: 'DUPLICATA', OUTRO: 'OUTROS', DEPOS: 'DEPOSITO',
    CHEQU: 'CHEQUE', PROMI: 'PROMISSORIA', CARNE: 'CARNE',
  };

  /** Espécies restritas — contas dessas espécies só aparecem pra autorizadas. */
  private static readonly ESPECIES_RESTRITAS = new Set(['RH', 'VALE', 'SALARIO', 'COMISSAO']);

  private static readonly ESPECIES_SEED = [
    'AGUA', 'ALUGUEIS', 'BOLETO', 'CARNE', 'CHEQUE', 'DEPOSITO', 'DUPLICATA',
    'ENERGIA', 'IMPOSTO', 'INTERNET', 'OUTROS', 'PROMISSORIA', 'RH',
    'SALARIO', 'COMISSAO', 'VALE', 'SEM ESPECIE',
  ];

  // ═══ ESTADO DO JOB EM BACKGROUND ═══════════════════════════════════════════
  private bg: {
    running: boolean;
    step: 'espelho' | 'migracao' | null;
    startedAt: string | null;
    finishedAt: string | null;
    processed: number;
    total: number;
    error: string | null;
    resumo: any;
  } = { running: false, step: null, startedAt: null, finishedAt: null, processed: 0, total: 0, error: null, resumo: null };

  getProgresso() {
    return this.bg;
  }

  startEspelhoBackground(): { started: boolean; alreadyRunning: boolean } {
    if (this.bg.running) return { started: false, alreadyRunning: true };
    this.bg = { running: true, step: 'espelho', startedAt: new Date().toISOString(), finishedAt: null, processed: 0, total: 0, error: null, resumo: null };
    void (async () => {
      const r = await this.syncEspelho();
      this.bg.running = false;
      this.bg.finishedAt = new Date().toISOString();
      this.bg.error = r.ok ? null : r.error || 'falhou';
      this.bg.resumo = r;
    })();
    return { started: true, alreadyRunning: false };
  }

  startMigracaoBackground(): { started: boolean; alreadyRunning: boolean } {
    if (this.bg.running) return { started: false, alreadyRunning: true };
    this.bg = { running: true, step: 'migracao', startedAt: new Date().toISOString(), finishedAt: null, processed: 0, total: 0, error: null, resumo: null };
    void (async () => {
      const r = await this.migrar();
      this.bg.running = false;
      this.bg.finishedAt = new Date().toISOString();
      this.bg.error = r.ok ? null : r.error || 'falhou';
      this.bg.resumo = r;
    })();
    return { started: true, alreadyRunning: false };
  }

  // ═══ 1. ESPELHO RAW (giga_pagar) ═══════════════════════════════════════════
  async syncEspelho(): Promise<{ ok: boolean; linhas: number; durationMs: number; error?: string }> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) return { ok: false, linhas: 0, durationMs: 0, error: 'MySQL pool não inicializado' };
    try {
      const [cnt] = await pool.query({ sql: 'SELECT COUNT(*) AS c FROM pagar', timeout: 60_000 });
      const total = Number((cnt as any[])[0]?.c ?? 0);
      this.bg.total = total;
      this.logger.log(`[espelho] iniciando — ${total} linhas no GIGA`);

      let offset = 0;
      let processed = 0;
      let truncated = false;
      while (offset < total + this.BATCH) {
        const [rows] = await pool.query(
          { sql: 'SELECT * FROM pagar ORDER BY REGISTRO LIMIT ? OFFSET ?', timeout: 120_000 },
          [this.BATCH, offset],
        );
        if (!(rows as any[]).length) break;
        if (!truncated) {
          await this.prisma.$executeRawUnsafe('TRUNCATE TABLE "giga_pagar"');
          truncated = true;
        }
        const data = (rows as any[]).map((r) => ({
          registro: Number(r.REGISTRO),
          pnum: r.PNUM != null ? String(r.PNUM) : null,
          pesp: r.PESP != null ? String(r.PESP) : null,
          pser: r.PSER != null ? String(r.PSER).slice(0, 5) : null,
          pfav: r.PFAV != null ? Number(r.PFAV) : null,
          pemi: this.safeDate(r.PEMI),
          pban: r.PBAN != null ? String(r.PBAN) : null,
          pval: r.PVAL != null ? Number(r.PVAL) : null,
          pven: this.safeDate(r.PVEN),
          paga: this.safeDate(r.PAGA),
          pjur: r.PJUR != null ? Number(r.PJUR) : null,
          pdes: r.PDES != null ? Number(r.PDES) : null,
          pobs: r.POBS != null ? String(r.POBS) : null,
          nnota: r.NNOTA != null ? String(r.NNOTA) : null,
          ncheque: r.NCHEQUE != null ? String(r.NCHEQUE).slice(0, 12) : null,
          pend: r.PEND != null ? String(r.PEND).slice(0, 3) : null,
          loja: r.LOJA != null ? String(r.LOJA).slice(0, 2) : null,
        }));
        await (this.prisma as any).gigaPagar.createMany({ data, skipDuplicates: true });
        processed += data.length;
        this.bg.processed = processed;
        offset += this.BATCH;
        if (processed % 15000 === 0) this.logger.log(`[espelho] ${processed}/${total}`);
      }
      this.logger.log(`[espelho] OK — ${processed} linhas em ${Date.now() - t0}ms`);
      return { ok: true, linhas: processed, durationMs: Date.now() - t0 };
    } catch (e: any) {
      this.logger.error(`[espelho] FALHOU: ${e?.message}`);
      return { ok: false, linhas: 0, durationMs: Date.now() - t0, error: e?.message };
    }
  }

  /** Datas absurdas do GIGA (ano 0203 etc.) quebram o driver — sanitiza sem perder o sinal. */
  private safeDate(v: any): Date | null {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    if (y < 1800) return new Date(Date.UTC(1800, 0, 1)); // marcador de "data absurda antiga"
    if (y > 2100) return new Date(Date.UTC(2100, 0, 1)); // marcador de "data absurda futura"
    return d;
  }

  // ═══ 2. MIGRAÇÃO IDEMPOTENTE (giga_pagar → conta_pagar) ═══════════════════
  // OTIMIZADA (11/07): a 1ª versão fazia findUnique+create+log POR LINHA
  // (216k round-trips — morria no meio). Agora: Set dos gigaRegistro já
  // migrados (1 query) + createMany em lotes de 1000, PULANDO os existentes
  // (GIGA congelado — registro migrado não muda). Auditoria da migração fica
  // no createdBy='migracao-giga'; log por campo é só das edições NA TELA.
  async migrar(): Promise<{
    ok: boolean; processadas: number; criadas: number; puladas: number;
    orfaos: number; datasSuspeitas: number; durationMs: number; error?: string;
  }> {
    const t0 = Date.now();
    try {
      // Semente de espécies (idempotente)
      for (const nome of ContasPagarMigracaoService.ESPECIES_SEED) {
        await (this.prisma as any).especieConta.upsert({
          where: { nome },
          create: { nome, restrita: ContasPagarMigracaoService.ESPECIES_RESTRITAS.has(nome) },
          update: {},
        });
      }
      const especies: any[] = await (this.prisma as any).especieConta.findMany();
      const especieIdByNome = new Map<string, string>(especies.map((e) => [e.nome, e.id]));

      // Fornecedores: espelho wincred_fornecedores primeiro (Postgres, sem
      // depender do Giga vivo); fallback Giga só se o espelho estiver vazio.
      const fornByCod = new Map<number, string>();
      const fornMirror: any[] = await (this.prisma as any).wincredFornecedor
        .findMany({ select: { codigo: true, razaoSocial: true } })
        .catch(() => []);
      for (const f of fornMirror) fornByCod.set(Number(f.codigo), String(f.razaoSocial || '').trim());
      if (!fornByCod.size) {
        const pool: any = (this.erp as any).pool;
        if (pool) {
          const [fRows] = await pool.query({ sql: 'SELECT CODIGO, RAZAOSOCIAL FROM fornecedores', timeout: 60_000 });
          for (const f of fRows as any[]) fornByCod.set(Number(f.CODIGO), String(f.RAZAOSOCIAL || '').trim());
        }
      }

      // Já migrados: pula (GIGA congelado). Re-rodar = continua de onde parou.
      const existentes: any[] = await (this.prisma as any).contaPagar.findMany({
        where: { gigaRegistro: { not: null } },
        select: { gigaRegistro: true },
      });
      const jaMigrados = new Set<number>(existentes.map((e) => Number(e.gigaRegistro)));

      this.bg.total = await (this.prisma as any).gigaPagar.count();

      let processadas = 0, criadas = 0, puladas = 0, orfaos = 0, datasSuspeitas = 0;
      let cursor = -1;
      let pendentes: any[] = [];

      const flush = async () => {
        if (!pendentes.length) return;
        await (this.prisma as any).contaPagar.createMany({ data: pendentes, skipDuplicates: true });
        criadas += pendentes.length;
        pendentes = [];
      };

      for (;;) {
        const lote: any[] = await (this.prisma as any).gigaPagar.findMany({
          where: { registro: { gt: cursor } },
          orderBy: { registro: 'asc' },
          take: this.BATCH,
        });
        if (!lote.length) break;
        cursor = lote[lote.length - 1].registro;

        for (const g of lote) {
          processadas++;
          if (jaMigrados.has(Number(g.registro))) { puladas++; continue; }

          const espOriginal = (g.pesp || '').trim().toUpperCase();
          const espNome = ContasPagarMigracaoService.ESPECIE_DEPARA[espOriginal] || (espOriginal ? espOriginal : 'SEM ESPECIE');
          const especieId = especieIdByNome.get(espNome) || especieIdByNome.get('SEM ESPECIE') || null;

          const fornNome = g.pfav != null ? fornByCod.get(Number(g.pfav)) || null : null;
          const favorecidoOrfao = g.pfav != null && !fornNome;
          if (favorecidoOrfao) orfaos++;

          const pendUp = (g.pend || '').trim().toUpperCase();
          const emMaos = pendUp === 'SIM' || pendUp === 'S';

          const anoEmi = g.pemi ? new Date(g.pemi).getUTCFullYear() : null;
          const anoVen = g.pven ? new Date(g.pven).getUTCFullYear() : null;
          const dataSuspeita =
            (anoEmi != null && (anoEmi < 1990 || anoEmi > 2035)) ||
            (anoVen != null && (anoVen < 1990 || anoVen > 2035));
          if (dataSuspeita) datasSuspeitas++;

          pendentes.push({
            gigaRegistro: g.registro,
            lojaCode: (g.loja || '').trim() || '??',
            beneficiarioTipo: 'fornecedor',
            fornecedorGigaCodigo: g.pfav,
            fornecedorNome: fornNome || (g.pfav != null ? `FAVORECIDO #${g.pfav} (órfão no GIGA)` : null),
            especieId,
            especieOriginal: g.pesp,
            notaFiscal: g.nnota,
            banco: g.pban,
            cheque: g.ncheque,
            emissao: g.pemi,
            vencimento: g.pven || g.pemi || new Date(Date.UTC(1800, 0, 1)),
            valorCents: Math.round(Number(g.pval || 0) * 100),
            pagamento: g.paga,
            jurosCents: Math.round(Number(g.pjur || 0) * 100),
            descontoCents: Math.round(Number(g.pdes || 0) * 100),
            emMaos,
            emMaosOriginal: g.pend,
            observacao: g.pobs,
            status: g.paga ? 'paga' : 'aberta',
            favorecidoOrfao,
            dataSuspeita,
            createdBy: 'migracao-giga',
          });
          if (pendentes.length >= this.INSERT_BATCH) await flush();
        }
        this.bg.processed = processadas;
        if (processadas % 15000 === 0) this.logger.log(`[migracao] ${processadas} processadas…`);
      }
      await flush();
      this.logger.log(
        `[migracao] OK — ${processadas} (novas ${criadas}, puladas ${puladas}, órfãos ${orfaos}, datas suspeitas ${datasSuspeitas}) em ${Date.now() - t0}ms`,
      );
      return { ok: true, processadas, criadas, puladas, orfaos, datasSuspeitas, durationMs: Date.now() - t0 };
    } catch (e: any) {
      this.logger.error(`[migracao] FALHOU: ${e?.message}`);
      return { ok: false, processadas: 0, criadas: 0, puladas: 0, orfaos: 0, datasSuspeitas: 0, durationMs: Date.now() - t0, error: e?.message };
    }
  }

  // ═══ 3. VALIDAÇÃO DE ACEITE (espelho × Flow) ═══════════════════════════════
  async validar() {
    const [espelho]: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN paga IS NULL THEN 1 ELSE 0 END)::int AS abertas,
              COALESCE(SUM(pval), 0)::float AS soma
         FROM giga_pagar`,
    );
    const [flow]: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN status = 'aberta' THEN 1 ELSE 0 END)::int AS abertas,
              COALESCE(SUM(valor_cents), 0)::float / 100 AS soma
         FROM conta_pagar
        WHERE giga_registro IS NOT NULL AND deleted_at IS NULL`,
    );
    const porLoja: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COALESCE(g.loja, '??') AS loja,
              COUNT(g.registro)::int AS giga_total,
              COALESCE(f.total, 0)::int AS flow_total
         FROM giga_pagar g
         LEFT JOIN (
           SELECT loja_code, COUNT(*)::int AS total FROM conta_pagar
            WHERE giga_registro IS NOT NULL AND deleted_at IS NULL GROUP BY loja_code
         ) f ON f.loja_code = COALESCE(g.loja, '??')
        GROUP BY COALESCE(g.loja, '??'), f.total
        ORDER BY giga_total DESC`,
    );
    const divergentes = porLoja.filter((l) => Number(l.giga_total) !== Number(l.flow_total));
    const ok =
      Number(espelho.total) === Number(flow.total) &&
      Number(espelho.abertas) === Number(flow.abertas) &&
      Math.abs(Number(espelho.soma) - Number(flow.soma)) < 0.01 &&
      divergentes.length === 0;
    return { ok, espelho, flow, lojasDivergentes: divergentes, geradoEm: new Date().toISOString() };
  }
}
