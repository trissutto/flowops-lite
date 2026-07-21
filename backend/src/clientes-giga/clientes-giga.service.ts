import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * IMPORTAÇÃO COMPLETA da tabela `clientes` do Giga pro Flow (giga_clientes).
 *
 * Decisão do dono (21/07): trazer TODOS os campos e TODOS os dados — base da
 * tela de Consulta de Clientes nativa e do crediário nativo (sair da Giga).
 *
 * Estratégia "nenhum campo se perde":
 *   - SELECT * (não uma lista fixa de colunas) em lotes paginados;
 *   - colunas conhecidas → campos estruturados/indexados (nome, cpf, fones...);
 *   - a LINHA ORIGINAL INTEIRA → rawJson (inclui RG/exp, cônjuge, pai/mãe,
 *     autorizados, referências e qualquer coluna que o mapeamento não conheça).
 *
 * Full-replace (mesmo padrão do espelho de clientes slim): a tabela é zona de
 * pouso — ainda não é fonte de escrita, então o replace é seguro.
 *
 * Sync: manual (POST /admin/clientes-giga/sync — primeira carga) + cron diário
 * 04:40 gated por WINCRED_MIRROR_CRON_ENABLED=1.
 */
@Injectable()
export class ClientesGigaService {
  private readonly logger = new Logger(ClientesGigaService.name);
  private running = false;
  private lastResult: { at: Date; total: number; erro?: string } | null = null;

  private static readonly PAGE = 10_000;
  private static readonly CHUNK = 1_000;
  private static readonly MAX_ROWS = 500_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  @Cron('40 4 * * *', { name: 'clientes-giga-sync' })
  async cronDiario(): Promise<void> {
    if (process.env.WINCRED_MIRROR_CRON_ENABLED !== '1') return;
    try {
      const r = await this.syncAll();
      this.logger.log(`[clientes-giga] sync diário: ${JSON.stringify(r)}`);
    } catch (e) {
      this.logger.error(`[clientes-giga] sync diário falhou: ${(e as Error).message}`);
    }
  }

  // ── helpers de mapeamento ────────────────────────────────────────────────

  /** Primeiro valor da linha cuja CHAVE case-insensitive bate em algum regex. */
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

  private num(v: any): number | null {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
  }

  private dateOf(v: any): Date | null {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const d = new Date(String(v));
    if (isNaN(d.getTime()) || d.getFullYear() < 1900) return null;
    return d;
  }

  /** Linha inteira em JSON serializável (Date→ISO, Buffer→string). */
  private sanitizeRow(row: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v == null) out[k] = null;
      else if (v instanceof Date) out[k] = isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
      else if (Buffer.isBuffer(v)) out[k] = v.toString('utf8');
      else out[k] = v;
    }
    return out;
  }

  /** Detecta a tabela de clientes e a coluna de código (pra ordenar os lotes). */
  private async detectTable(): Promise<{ table: string; codCol: string; lojaCol: string | null } | null> {
    const candidates = ['clientes', 'cliente', 'cadcli', 'cadcliente', 'cadclientes'];
    for (const tbl of candidates) {
      try {
        const schema = await this.erp.getTableSchema(tbl, 1);
        if (!schema) continue;
        const cols = schema.columns.map((c: any) => String(c.field));
        const find = (...res: RegExp[]) => cols.find((c) => res.some((re) => re.test(c))) || null;
        const codCol = find(/^codigo$/i, /^cod_?cliente$/i, /^codcli$/i, /^id$/i);
        if (!codCol) continue;
        const lojaCol = find(/^loja$/i, /^cod_?loja$/i, /^filial$/i);
        return { table: tbl, codCol, lojaCol };
      } catch { /* tenta a próxima */ }
    }
    return null;
  }

  // ── sync ─────────────────────────────────────────────────────────────────

  async syncAll(): Promise<{ ok: boolean; total: number; paginas: number; erro?: string }> {
    if (this.running) return { ok: false, total: 0, paginas: 0, erro: 'sync já em andamento' };
    this.running = true;
    const t0 = Date.now();
    try {
      const det = await this.detectTable();
      if (!det) throw new Error('tabela de clientes não detectada no Giga');
      const pool: any = (this.erp as any).pool;
      if (!pool) throw new Error('pool Giga não inicializado');

      // Full-replace: limpa e recarrega (zona de pouso, sem escrita nativa ainda).
      await (this.prisma as any).gigaCliente.deleteMany({});

      let total = 0;
      let paginas = 0;
      for (let offset = 0; offset < ClientesGigaService.MAX_ROWS; offset += ClientesGigaService.PAGE) {
        const [rows] = await pool.query(
          `SELECT * FROM \`${det.table}\` ORDER BY \`${det.codCol}\` LIMIT ${ClientesGigaService.PAGE} OFFSET ${offset}`,
        );
        const batch = rows as any[];
        if (!batch.length) break;
        paginas++;

        const data = batch
          .map((row) => this.mapRow(row, det))
          .filter((r): r is NonNullable<ReturnType<ClientesGigaService['mapRow']>> => !!r);

        for (let i = 0; i < data.length; i += ClientesGigaService.CHUNK) {
          await (this.prisma as any).gigaCliente.createMany({
            data: data.slice(i, i + ClientesGigaService.CHUNK),
            skipDuplicates: true,
          });
        }
        total += data.length;
        this.logger.log(`[clientes-giga] página ${paginas}: +${data.length} (total ${total})`);
        if (batch.length < ClientesGigaService.PAGE) break;
      }

      this.lastResult = { at: new Date(), total };
      this.logger.log(`[clientes-giga] sync completo: ${total} clientes em ${Math.round((Date.now() - t0) / 1000)}s`);
      return { ok: true, total, paginas };
    } catch (e: any) {
      const erro = String(e?.message || e);
      this.lastResult = { at: new Date(), total: 0, erro };
      this.logger.error(`[clientes-giga] sync falhou: ${erro}`);
      return { ok: false, total: 0, paginas: 0, erro };
    } finally {
      this.running = false;
    }
  }

  /** Uma linha do Giga → registro giga_clientes (estruturado + rawJson). */
  private mapRow(
    row: Record<string, any>,
    det: { codCol: string; lojaCol: string | null },
  ): Record<string, any> | null {
    const codigo = this.str(row[det.codCol], 20);
    if (!codigo) return null;
    const loja = (det.lojaCol && this.str(row[det.lojaCol], 4)) || '00';
    return {
      loja: loja.padStart(2, '0'),
      codigo,
      nome: this.str(this.pick(row, /^nome$/i, /^nome_?cliente$/i, /^razao_?social$/i), 120),
      cpf: this.str(this.pick(row, /^cpf$/i, /^cpf_?cnpj$/i, /^cnpj_?cpf$/i, /^cpfcgc$/i, /^cgccpf$/i), 20),
      rg: this.str(this.pick(row, /^rg$/i, /^identidade$/i), 30),
      nascimento: this.dateOf(this.pick(row, /^nascimento$/i, /^data_?nasc(imento)?$/i, /^dt_?nasc/i)),
      email: this.str(this.pick(row, /^e-?mail$/i), 120),
      foneRes: this.str(this.pick(row, /^foneres$/i, /^fone_?res$/i, /^telefone$/i, /^fone$/i), 30),
      foneCel: this.str(this.pick(row, /^fonecel$/i, /^fone_?cel$/i, /^celular$/i), 30),
      foneRec: this.str(this.pick(row, /^fonerec(ado)?$/i, /^fone_?rec(ado)?$/i), 30),
      falarCom: this.str(this.pick(row, /^falar_?com$/i), 60),
      endereco: this.str(this.pick(row, /^endereco(_?res)?$/i, /^logradouro$/i, /^rua$/i), 120),
      numero: this.str(this.pick(row, /^num(ero)?$/i), 15),
      complemento: this.str(this.pick(row, /^comp(lemento)?$/i), 60),
      bairro: this.str(this.pick(row, /^bairro$/i), 60),
      cidade: this.str(this.pick(row, /^cidade$/i, /^municipio$/i), 60),
      uf: this.str(this.pick(row, /^uf$/i, /^estado$/i), 2),
      cep: this.str(this.pick(row, /^cep$/i), 12),
      bloqueado: this.str(this.pick(row, /^bloqueado$/i), 5),
      avaliacao: this.str(this.pick(row, /^avaliacao$/i), 4),
      situacao: this.str(this.pick(row, /^situacao$/i), 30),
      pontos: this.num(this.pick(row, /^pontos$/i)),
      limiteCompras: this.num(this.pick(row, /^limite_?compras$/i, /^limite$/i)),
      aberturaCredito: this.dateOf(this.pick(row, /^abertura_?credito$/i, /^data_?abertura$/i)),
      localTrabalho: this.str(this.pick(row, /^local_?trabalho$/i, /^empresa$/i), 120),
      salario: this.num(this.pick(row, /^salario$/i, /^renda$/i)),
      admissao: this.dateOf(this.pick(row, /^admissao$/i, /^data_?admissao$/i)),
      observacao: this.str(this.pick(row, /^observacao$/i, /^obs$/i), 2000),
      rawJson: this.sanitizeRow(row),
    };
  }

  // ── consultas (status + amostra pra desenhar a tela) ────────────────────

  async status() {
    const [total, comCpf, ultimo] = await Promise.all([
      (this.prisma as any).gigaCliente.count(),
      (this.prisma as any).gigaCliente.count({ where: { cpf: { not: null } } }),
      (this.prisma as any).gigaCliente.findFirst({ orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } }),
    ]);
    return {
      total,
      comCpf,
      ultimoSync: ultimo?.syncedAt || null,
      rodando: this.running,
      ultimoResultado: this.lastResult,
    };
  }

  /** Amostra: TODAS as colunas originais do Giga (chaves do rawJson) + N linhas.
   *  Usada pra desenhar a tela de consulta com os nomes reais dos campos. */
  async sample(limit = 3) {
    const rows: any[] = await (this.prisma as any).gigaCliente.findMany({
      take: Math.min(10, Math.max(1, limit)),
      orderBy: { nome: 'asc' },
    });
    const colunas = rows.length ? Object.keys(rows[0].rawJson || {}) : [];
    return { colunasGiga: colunas, amostra: rows };
  }
}
