import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * MIGRAÇÃO do Contas a Pagar GIGA → FLOW (Fases 1+3 do plano).
 * Dossiê-contrato: docs/GIGA-CONTAS-DESCOBERTA.md. Decisão do dono (11/07):
 * 100% Flow — migra o histórico UMA vez (idempotente) e o GIGA congela.
 *
 * 3 operações, todas admin-only e re-executáveis sem duplicar nada:
 *  1. syncEspelho()  — copia a tabela `pagar` crua pro Postgres (giga_pagar).
 *  2. migrar()       — upsert ContaPagar por gigaRegistro com DE-PARA de
 *                      espécie, normalização do EM MÃOS e flags de qualidade.
 *  3. validar()      — contagens/somas GIGA(espelho) × FLOW por status —
 *                      aceite = tudo batendo (relatório de discrepâncias).
 */
@Injectable()
export class ContasPagarMigracaoService {
  private readonly logger = new Logger(ContasPagarMigracaoService.name);
  private readonly BATCH = 3000;

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

  // ═══ 1. ESPELHO RAW (giga_pagar) ═══════════════════════════════════════════
  async syncEspelho(): Promise<{ ok: boolean; linhas: number; durationMs: number; error?: string }> {
    const t0 = Date.now();
    const pool: any = (this.erp as any).pool;
    if (!pool) return { ok: false, linhas: 0, durationMs: 0, error: 'MySQL pool não inicializado' };
    try {
      const [cnt] = await pool.query({ sql: 'SELECT COUNT(*) AS c FROM pagar', timeout: 60_000 });
      const total = Number((cnt as any[])[0]?.c ?? 0);
      this.logger.log(`[espelho] iniciando — ${total} linhas no GIGA`);

      // SELECT primeiro, TRUNCATE depois do 1º batch chegar (janela mínima sem dados)
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
  async migrar(): Promise<{
    ok: boolean; processadas: number; criadas: number; atualizadas: number;
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

      // Fornecedores do GIGA (nome por código) — 2.091 linhas, cabe em memória
      const pool: any = (this.erp as any).pool;
      const fornByCod = new Map<number, string>();
      if (pool) {
        const [fRows] = await pool.query({ sql: 'SELECT CODIGO, RAZAOSOCIAL FROM fornecedores', timeout: 60_000 });
        for (const f of fRows as any[]) fornByCod.set(Number(f.CODIGO), String(f.RAZAOSOCIAL || '').trim());
      }

      let processadas = 0, criadas = 0, atualizadas = 0, orfaos = 0, datasSuspeitas = 0;
      let cursor = -1;
      for (;;) {
        const lote: any[] = await (this.prisma as any).gigaPagar.findMany({
          where: { registro: { gt: cursor } },
          orderBy: { registro: 'asc' },
          take: this.BATCH,
        });
        if (!lote.length) break;
        cursor = lote[lote.length - 1].registro;

        for (const g of lote) {
          const espOriginal = (g.pesp || '').trim().toUpperCase();
          const espNome = ContasPagarMigracaoService.ESPECIE_DEPARA[espOriginal] || (espOriginal ? espOriginal : 'SEM ESPECIE');
          const especieId = especieIdByNome.get(espNome) || especieIdByNome.get('SEM ESPECIE') || null;

          const fornNome = g.pfav != null ? fornByCod.get(g.pfav) || null : null;
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

          const valorCents = Math.round(Number(g.pval || 0) * 100);
          const data = {
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
            valorCents,
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
          };
          const existing = await (this.prisma as any).contaPagar.findUnique({
            where: { gigaRegistro: g.registro },
            select: { id: true },
          });
          if (existing) {
            await (this.prisma as any).contaPagar.update({ where: { gigaRegistro: g.registro }, data });
            atualizadas++;
          } else {
            await (this.prisma as any).contaPagar.create({ data: { ...data, gigaRegistro: g.registro } });
            criadas++;
          }
          processadas++;
        }
        if (processadas % 15000 === 0) this.logger.log(`[migracao] ${processadas} processadas…`);
      }
      this.logger.log(
        `[migracao] OK — ${processadas} (novas ${criadas}, atualizadas ${atualizadas}, órfãos ${orfaos}, datas suspeitas ${datasSuspeitas}) em ${Date.now() - t0}ms`,
      );
      return { ok: true, processadas, criadas, atualizadas, orfaos, datasSuspeitas, durationMs: Date.now() - t0 };
    } catch (e: any) {
      this.logger.error(`[migracao] FALHOU: ${e?.message}`);
      return { ok: false, processadas: 0, criadas: 0, atualizadas: 0, orfaos: 0, datasSuspeitas: 0, durationMs: Date.now() - t0, error: e?.message };
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
