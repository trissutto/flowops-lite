import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { findAllCustomersByCpf, aggregatePerson } from '../customers/customer-aggregation.helper';

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

  /** Dispara o sync em BACKGROUND (mesmo padrão do wincred-mirror: o POST
   *  responde na hora e a tela faz poll do status — importação de 100k+ linhas
   *  estouraria o timeout do proxy se fosse síncrona). */
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
      const det = await this.detectTable();
      if (!det) throw new Error('tabela de clientes não detectada no Giga');
      const pool: any = (this.erp as any).pool;
      if (!pool) throw new Error('pool Giga não inicializado');

      // Full-replace SÓ do que veio do Giga. Ficha editada/criada NO FLOW
      // (flowIsSource=true) fica intacta — o Flow é a fonte da verdade dela
      // (skipDuplicates abaixo garante que o Giga não re-insere por cima).
      await (this.prisma as any).gigaCliente.deleteMany({ where: { flowIsSource: false } });

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

      // INTEGRAÇÃO: liga os registros ao Customer mestre do CRM (por CPF).
      const vinc = await this.vincular().catch((e) => {
        this.logger.warn(`[clientes-giga] vinculação falhou (segue sem): ${(e as Error).message}`);
        return { vinculados: 0, semMatch: 0 };
      });

      this.lastResult = { at: new Date(), total };
      this.logger.log(
        `[clientes-giga] sync completo: ${total} clientes em ${Math.round((Date.now() - t0) / 1000)}s · ` +
        `${vinc.vinculados} vinculados ao CRM`,
      );
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
      // Nomes REAIS confirmados no Lurd's (tela 21/07): ENDERECORES, NUMERORES,
      // COMPRES, BAIRRORES, CIDADERES, UFRES, CEPRES, NOMEREC (falar com),
      // SPCSITUACAO, DATACREDITO, TRABALHO* (RAZAOSOC/SALARIO/ADM).
      falarCom: this.str(this.pick(row, /^falar_?com$/i, /^nomerec$/i), 60),
      endereco: this.str(this.pick(row, /^endereco(_?res)?$/i, /^logradouro$/i, /^rua$/i), 120),
      numero: this.str(this.pick(row, /^numerores$/i, /^num(ero)?$/i), 15),
      complemento: this.str(this.pick(row, /^compres$/i, /^comp(lemento)?$/i), 60),
      bairro: this.str(this.pick(row, /^bairrores$/i, /^bairro$/i), 60),
      cidade: this.str(this.pick(row, /^cidaderes$/i, /^cidade$/i, /^municipio$/i), 60),
      uf: this.str(this.pick(row, /^ufres$/i, /^uf$/i, /^estado$/i), 2),
      cep: this.str(this.pick(row, /^cepres$/i, /^cep$/i), 12),
      bloqueado: this.str(this.pick(row, /^bloqueado$/i), 5),
      avaliacao: this.str(this.pick(row, /^avaliacao$/i), 4),
      situacao: this.str(this.pick(row, /^spcsituacao$/i, /^situacao$/i), 30),
      pontos: this.num(this.pick(row, /^pontos$/i)),
      limiteCompras: this.num(this.pick(row, /^limite_?compras$/i, /^limite$/i)),
      aberturaCredito: this.dateOf(this.pick(row, /^datacredito$/i, /^abertura_?credito$/i, /^data_?abertura$/i)),
      localTrabalho: this.str(this.pick(row, /^trabalhorazaosoc$/i, /^local_?trabalho$/i, /^empresa$/i), 120),
      salario: this.num(this.pick(row, /^trabalhosalario$/i, /^salario$/i, /^renda$/i)),
      admissao: this.dateOf(this.pick(row, /^trabalhoadm$/i, /^admissao$/i, /^data_?admissao$/i)),
      observacao: this.str(this.pick(row, /^observacao$/i, /^obs$/i), 2000),
      personKey: this.personKeyOf(this.pick(row, /^cpf$/i, /^cpf_?cnpj$/i, /^cnpj_?cpf$/i, /^cpfcgc$/i, /^cgccpf$/i)),
      rawJson: this.sanitizeRow(row),
    };
  }

  /** MESMA convenção do CRM (customer-aggregation): personKey = "cpf:<dígitos>".
   *  É o que unifica a PESSOA entre lojas, site e live. */
  private personKeyOf(cpfRaw: any): string | null {
    const digits = String(cpfRaw ?? '').replace(/\D/g, '');
    return digits.length === 11 ? `cpf:${digits}` : null;
  }

  /**
   * VINCULAÇÃO com o CRM — liga cada registro do Giga ao Customer MESTRE
   * (integração site+lojas+live, pedido do dono). Match por CPF (forte e
   * inequívoco). Fone fica pra fase da tela (ambíguo demais pra automático).
   * Não CRIA Customer aqui — só liga onde a pessoa já existe no CRM; a tela
   * unifica o resto pelo personKey.
   */
  async vincular(): Promise<{ vinculados: number; semMatch: number }> {
    const gigaComCpf: any[] = await (this.prisma as any).gigaCliente.findMany({
      where: { personKey: { not: null }, customerId: null },
      select: { loja: true, codigo: true, personKey: true },
    });
    if (!gigaComCpf.length) return { vinculados: 0, semMatch: 0 };

    // Customers por personKey OU por CPF (dígitos) — cobre cadastros antigos sem personKey.
    const keys = Array.from(new Set(gigaComCpf.map((g) => g.personKey)));
    const cpfs = keys.map((k) => String(k).slice(4));
    const customers: any[] = await (this.prisma as any).customer.findMany({
      where: { OR: [{ personKey: { in: keys } }, { cpf: { in: cpfs } }] },
      select: { id: true, personKey: true, cpf: true },
    });
    const byKey = new Map<string, string>();
    for (const c of customers) {
      const k = c.personKey || (c.cpf ? `cpf:${String(c.cpf).replace(/\D/g, '')}` : null);
      if (k && !byKey.has(k)) byKey.set(k, c.id);
    }

    let vinculados = 0;
    for (const g of gigaComCpf) {
      const customerId = byKey.get(g.personKey);
      if (!customerId) continue;
      await (this.prisma as any).gigaCliente.update({
        where: { loja_codigo: { loja: g.loja, codigo: g.codigo } },
        data: { customerId },
      });
      vinculados++;
    }
    const semMatch = gigaComCpf.length - vinculados;
    this.logger.log(`[clientes-giga] vinculação CRM: ${vinculados} ligados ao Customer mestre, ${semMatch} sem match (unificam via personKey)`);
    return { vinculados, semMatch };
  }

  // ── consultas (status + amostra pra desenhar a tela) ────────────────────

  async status() {
    const [total, comCpf, vinculados, pessoas, porLojaRaw, ultimo] = await Promise.all([
      (this.prisma as any).gigaCliente.count(),
      (this.prisma as any).gigaCliente.count({ where: { cpf: { not: null } } }),
      (this.prisma as any).gigaCliente.count({ where: { customerId: { not: null } } }),
      (this.prisma as any).gigaCliente.groupBy({ by: ['personKey'], where: { personKey: { not: null } } }).then((g: any[]) => g.length),
      // Quebra POR LOJA — confere na tela que TODAS as lojas vieram (dono 21/07).
      (this.prisma as any).gigaCliente.groupBy({ by: ['loja'], _count: { _all: true }, orderBy: { loja: 'asc' } }),
      (this.prisma as any).gigaCliente.findFirst({ orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } }),
    ]);
    return {
      total,                    // registros (fichas por loja)
      comCpf,
      pessoasUnicas: pessoas,   // pessoas distintas por CPF (integração)
      vinculadosAoCrm: vinculados,
      porLoja: (porLojaRaw as any[]).map((l) => ({ loja: l.loja, fichas: l._count._all })),
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

  // ── CONSULTA DE CLIENTES (tela nativa — substitui a do Giga) ─────────────

  /** Busca UNIFICADA por nome / CPF / fone / código. Agrupa por PESSOA
   *  (personKey); ficha sem CPF vira "pessoa" própria (loja+codigo). */
  async search(qRaw: string) {
    const q = String(qRaw || '').trim();
    if (q.length < 2) return { pessoas: [] };
    const digits = q.replace(/\D/g, '');
    const or: any[] = [{ nome: { contains: q, mode: 'insensitive' } }];
    if (digits.length >= 3) {
      or.push({ cpf: { contains: digits } });
      or.push({ foneCel: { contains: digits } });
      or.push({ foneRes: { contains: digits } });
      or.push({ codigo: digits });
    }
    const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
      where: { OR: or },
      select: {
        loja: true, codigo: true, nome: true, cpf: true, foneCel: true,
        cidade: true, bloqueado: true, avaliacao: true, personKey: true, customerId: true,
      },
      orderBy: { nome: 'asc' },
      take: 120,
    });
    // Agrupa por pessoa (personKey; sem CPF → cada ficha é uma entrada)
    const porPessoa = new Map<string, any>();
    for (const f of fichas) {
      const key = f.personKey || `ficha:${f.loja}:${f.codigo}`;
      let p = porPessoa.get(key);
      if (!p) {
        porPessoa.set(key, (p = {
          personKey: f.personKey, nome: f.nome, cpf: f.cpf, foneCel: f.foneCel,
          cidade: f.cidade, noCrm: !!f.customerId, fichas: [],
        }));
      }
      p.noCrm = p.noCrm || !!f.customerId;
      p.fichas.push({ loja: f.loja, codigo: f.codigo, bloqueado: f.bloqueado, avaliacao: f.avaliacao });
    }
    return { pessoas: Array.from(porPessoa.values()).slice(0, 60) };
  }

  /** FICHA COMPLETA da pessoa: todas as fichas dela (todas as lojas), o vínculo
   *  CRM e as parcelas de crediário EM ABERTO (espelho wincred_movimento_aberto,
   *  referenciadas por loja+codCliente). rawJson vai junto — a tela mostra TODOS
   *  os campos originais do Giga. */
  async pessoa(loja: string, codigo: string) {
    const base: any = await (this.prisma as any).gigaCliente.findUnique({
      where: { loja_codigo: { loja, codigo } },
    });
    if (!base) return { found: false };

    const fichas: any[] = base.personKey
      ? await (this.prisma as any).gigaCliente.findMany({
          where: { personKey: base.personKey },
          orderBy: { loja: 'asc' },
        })
      : [base];

    // CRM (integração site+lojas+live)
    const customerId = fichas.find((f) => f.customerId)?.customerId || null;
    const customer = customerId
      ? await (this.prisma as any).customer.findUnique({
          where: { id: customerId },
          select: { id: true, name: true, phone: true, whatsapp: true, email: true, igUsername: true, originStoreId: true },
        }).catch(() => null)
      : null;

    // CREDIÁRIO — NATIVO primeiro (ledger completo: abertas E pagas; fase 1 do
    // crediário nativo). Fallback: espelho de abertas se o nativo está vazio.
    const orFichas = fichas.map((f) => ({ loja: f.loja, codCliente: f.codigo }));
    let parcelas: any[] = [];
    let parcelasPagas: any[] = [];
    const nativoTem = await (this.prisma as any).crediarioParcela.findFirst({ select: { registro: true } })
      .catch(() => null);
    if (nativoTem) {
      [parcelas, parcelasPagas] = await Promise.all([
        (this.prisma as any).crediarioParcela.findMany({
          where: { OR: orFichas, pago: false },
          orderBy: { vencimento: 'asc' },
          take: 200,
        }).catch(() => []),
        (this.prisma as any).crediarioParcela.findMany({
          where: { OR: orFichas, pago: true },
          orderBy: { dataPagamento: 'desc' },
          take: 120,
        }).catch(() => []),
      ]);
    } else {
      parcelas = await (this.prisma as any).wincredMovimentoAberto.findMany({
        where: { OR: orFichas },
        orderBy: { vencimento: 'asc' },
        take: 200,
      }).catch(() => []);
    }
    const totalAberto = parcelas.reduce((s, p) => s + (Number(p.valorParcela) || 0), 0);
    const totalPago = parcelasPagas.reduce((s, p) => s + (Number(p.valorPago ?? p.valorParcela) || 0), 0);

    return {
      found: true,
      pessoa: { nome: base.nome, cpf: base.cpf, personKey: base.personKey },
      fichas,
      customer,
      parcelasAbertas: parcelas,
      parcelasPagas,
      totalAbertoReais: Math.round(totalAberto * 100) / 100,
      totalPagoReais: Math.round(totalPago * 100) / 100,
    };
  }

  // ── EDIÇÃO + CADASTRO (Flow = fonte da verdade; Giga vira réplica) ───────

  /** Campos editáveis (nomes REAIS do Giga). LOJA/CODIGO ficam de fora — são a
   *  chave. Whitelist evita coluna arbitrária via POST. */
  private static readonly CAMPOS_EDITAVEIS = new Set([
    'NOME', 'CPF', 'RG', 'RGEXP', 'RGEMISSAO', 'NASCIMENTO', 'NATURALIDADE', 'ESTADOCIVIL',
    'CONJUGE', 'CONJUGERG', 'CONJUGECPF', 'PAI', 'MAE', 'EMAIL', 'OBS',
    'FONECEL', 'FONERES', 'FONEREC', 'NOMEREC',
    'ENDERECORES', 'NUMERORES', 'COMPRES', 'BAIRRORES', 'CIDADERES', 'UFRES', 'CEPRES',
    'TRABALHORAZAOSOC', 'TRABALHOENDERECO', 'TRABALHOBAIRRO', 'TRABALHOCIDADE', 'TRABALHOUF',
    'TRABALHOCEP', 'TRABALHOFONE', 'TRABALHOCARGO', 'TRABALHOSALARIO', 'TRABALHOADM',
    'AVALIACAO', 'LIMITECOMPRAS', 'BLOQUEADO', 'DATACREDITO', 'COD_CARD', 'EMITIDO', 'FIDELIDADE',
    'AUTORIZADO1', 'AUTORIZADO1RG', 'AUTORIZADO1CPF', 'AUTORIZADO2', 'AUTORIZADO2RG', 'AUTORIZADO2CPF',
    'REFCOM1', 'FONEREFCOM1', 'REFCOM2', 'FONEREFCOM2',
    'REFPESSOAL1', 'FONEREFPESSOAL1', 'REFPESSOAL2', 'FONEREFPESSOAL2',
  ]);

  private filtrarCampos(campos: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(campos || {})) {
      const key = String(k).toUpperCase().trim();
      if (!ClientesGigaService.CAMPOS_EDITAVEIS.has(key)) continue;
      out[key] = v == null || String(v).trim() === '' ? null : String(v).trim();
    }
    return out;
  }

  private async enqueueGigaReplica(loja: string, codigo: string, set: Record<string, any>) {
    try {
      await (this.prisma as any).erpOutbox.create({
        data: {
          kind: 'cliente_upsert',
          saleId: `cli-${loja}-${codigo}-${Date.now()}`,
          payload: { loja, codigo, set },
          status: 'pending',
        },
      });
    } catch (e) {
      this.logger.error(`[clientes-giga] falha ao enfileirar réplica Giga: ${(e as Error).message}`);
    }
  }

  /** EDITA uma ficha: Flow-first (flowIsSource=true — o sync nunca mais
   *  sobrescreve) + réplica pro Giga via outbox (PDV legado continua vendo). */
  async editarFicha(loja: string, codigo: string, camposRaw: Record<string, any>, userName?: string | null) {
    const ficha: any = await (this.prisma as any).gigaCliente.findUnique({
      where: { loja_codigo: { loja, codigo } },
    });
    if (!ficha) return { ok: false, erro: 'Ficha não encontrada' };
    const campos = this.filtrarCampos(camposRaw);
    if (!Object.keys(campos).length) return { ok: false, erro: 'Nenhum campo válido' };

    // Merge no rawJson (fonte) e re-mapeia os campos estruturados do merge.
    const mergedRaw = { ...(ficha.rawJson || {}), ...campos, LOJA: loja, CODIGO: codigo };
    const data = this.mapRow(mergedRaw, { codCol: 'CODIGO', lojaCol: 'LOJA' });
    if (!data) return { ok: false, erro: 'Falha ao mapear campos' };
    delete (data as any).loja;
    delete (data as any).codigo;

    const upd = await (this.prisma as any).gigaCliente.update({
      where: { loja_codigo: { loja, codigo } },
      data: { ...data, flowIsSource: true, editedAt: new Date(), editedBy: userName || null },
    });
    await this.enqueueGigaReplica(loja, codigo, campos);
    this.logger.log(`[clientes-giga] ficha ${loja}/${codigo} editada por ${userName || '?'} (${Object.keys(campos).join(', ')})`);
    return { ok: true, ficha: upd };
  }

  /** Código pra cliente NOVO — sequência do FLOW por loja (faixa 500001+,
   *  nunca colide com a numeração do Giga; mesma ideia do EAN prefixo-8). */
  private async alocarCodigo(loja: string): Promise<string> {
    await (this.prisma as any).gigaClienteSeq.upsert({
      where: { loja }, create: { loja }, update: {},
    });
    const r = await (this.prisma as any).gigaClienteSeq.update({
      where: { loja },
      data: { proximo: { increment: 1 } },
      select: { proximo: true },
    });
    return String(r.proximo - 1);
  }

  /** CADASTRA cliente novo NO FLOW (fonte da verdade) + réplica pro Giga. */
  async cadastrar(lojaRaw: string, camposRaw: Record<string, any>, userName?: string | null) {
    const loja = String(lojaRaw || '').replace(/^LJ/i, '').padStart(2, '0');
    const campos = this.filtrarCampos(camposRaw);
    if (!campos.NOME) return { ok: false, erro: 'Nome é obrigatório' };
    const codigo = await this.alocarCodigo(loja);
    const raw = { ...campos, LOJA: loja, CODIGO: codigo };
    const data = this.mapRow(raw, { codCol: 'CODIGO', lojaCol: 'LOJA' });
    if (!data) return { ok: false, erro: 'Falha ao mapear campos' };

    const nova = await (this.prisma as any).gigaCliente.create({
      data: { ...data, flowIsSource: true, editedAt: new Date(), editedBy: userName || null },
    });
    // Vincula ao CRM na hora se o CPF casar
    if (nova.personKey) await this.vincular().catch(() => null);
    await this.enqueueGigaReplica(loja, codigo, campos);
    this.logger.log(`[clientes-giga] cliente NOVO ${loja}/${codigo} (${campos.NOME}) por ${userName || '?'}`);
    return { ok: true, loja, codigo, ficha: nova };
  }

  /**
   * COPIA a ficha de OUTRA loja pra loja destino (caso Jéssica 23/07:
   * cliente mudou de cidade e o crediário exige ficha NA loja da venda).
   * A ficha nasce no FLOW (código próprio da loja destino via alocarCodigo)
   * e é replicada pro Wincred pelo outbox (~30s). Idempotente por CPF.
   * LIMITE/AVALIAÇÃO/BLOQUEADO NÃO são copiados — crédito é decisão POR
   * LOJA (gerente ajusta com senha na tela de Clientes).
   */
  async copiarParaLoja(input: {
    lojaOrigem: string;
    codigoOrigem: string;
    lojaDestino: string;
    /** Fallbacks caso a ficha de origem ainda não esteja no espelho */
    nome?: string | null;
    cpf?: string | null;
    userName?: string | null;
  }) {
    const lojaO = String(input.lojaOrigem || '').replace(/^LJ/i, '').replace(/\D/g, '').padStart(2, '0');
    const lojaD = String(input.lojaDestino || '').replace(/^LJ/i, '').replace(/\D/g, '').padStart(2, '0');
    if (!lojaD || lojaD === '00') return { ok: false, erro: 'Loja destino inválida' };
    if (lojaO === lojaD) return { ok: false, erro: 'Origem e destino são a mesma loja' };

    // Ficha de origem no espelho (tolera padding de zeros no código)
    const codRaw = String(input.codigoOrigem || '').trim();
    const variantes = Array.from(new Set([codRaw, codRaw.replace(/^0+/, ''), codRaw.padStart(6, '0')])).filter(Boolean);
    const origem: any = await (this.prisma as any).gigaCliente.findFirst({
      where: { loja: lojaO, codigo: { in: variantes } },
    });

    // Idempotência: já existe ficha da MESMA pessoa (CPF) na loja destino?
    const cpfDigits = String(input.cpf || origem?.cpf || '').replace(/\D/g, '');
    if (cpfDigits.length === 11) {
      const jaTem: any = await (this.prisma as any).gigaCliente.findFirst({
        where: { loja: lojaD, personKey: `cpf:${cpfDigits}` },
        select: { codigo: true },
      });
      if (jaTem) return { ok: true, jaExistia: true, loja: lojaD, codigo: jaTem.codigo };
    }

    // Campos da cópia: rawJson da origem SEM os campos de crédito (por loja)
    // e sem chaves; fallback mínimo nome+CPF quando o espelho não tem a ficha.
    const rawOrigem: Record<string, any> = origem?.rawJson ? { ...(origem.rawJson as any) } : {};
    for (const k of ['CODIGO', 'LOJA', 'LIMITECOMPRAS', 'AVALIACAO', 'BLOQUEADO', 'SPCSITUACAO', 'SPCCONSULTA', 'SPCDATA', 'SPCOBS', 'DATACREDITO']) {
      delete rawOrigem[k];
    }
    // SANITIZAÇÃO (23/07 — a cópia da Pamela falhava aqui): o rawJson guarda
    // datas como ISO com hora ('1985-03-10T00:00:00.000Z') e sentinela
    // 1899-11-30 do Wincred — o MySQL estrito REJEITA e a réplica ficava
    // presa em retry. Vira DATE puro; vazio/sentinela/null caem fora.
    const raw: Record<string, any> = {};
    for (const [k, v] of Object.entries(rawOrigem)) {
      if (v == null) continue;
      let val: any = v;
      if (typeof val === 'string') {
        const s = val.trim();
        if (!s) continue;
        const m = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/.exec(s);
        val = m ? m[1] : s;
        if (String(val).startsWith('1899-11-30')) continue;
      }
      raw[k] = val;
    }
    if (!raw.NOME && input.nome) raw.NOME = String(input.nome).toUpperCase();
    if (!raw.CPF && cpfDigits) raw.CPF = cpfDigits;
    if (!raw.NOME) return { ok: false, erro: 'Ficha de origem não encontrada no espelho e nome não informado' };

    const quem = `${input.userName || 'pdv'} (cópia LJ ${lojaO})`;
    const r: any = await this.cadastrar(lojaD, raw, quem);
    if (!r.ok) return r;

    // RÉPLICA IMEDIATA no Wincred (além do outbox, que segue como garantia):
    // o caixa está COM A CLIENTE NA FRENTE — 3s em vez de 35s. E se der erro
    // de SQL, ele aparece na tela em vez de morrer no retry silencioso.
    let replicado = false;
    let replicaErro: string | null = null;
    try {
      const campos = this.filtrarCampos(raw);
      const rep = await this.erp.upsertClienteGiga({ loja: lojaD, codigo: r.codigo, set: campos });
      replicado = !!rep.success;
      replicaErro = rep.error || null;
    } catch (e: any) {
      replicaErro = e?.message || String(e);
    }
    if (replicaErro) {
      this.logger.warn(`[clientes-giga] cópia ${lojaD}/${r.codigo}: réplica imediata falhou (${replicaErro}) — outbox segue tentando`);
    }
    return { ...r, jaExistia: false, replicado, replicaErro };
  }

  /**
   * RESUMO DA CLIENTE (painel no topo da ficha — pedido do dono 21/07):
   * crediário em aberto, MARCADOS pra fechar (AO VIVO no Giga — é a verdade
   * sobre "já está fechado": fechou → sai da lista), limite disponível,
   * cashback (CRM, da PESSOA) e se pode marcar pra experimentar.
   */
  /**
   * HISTÓRICO DE MARCADOS da PESSOA (todas as fichas/lojas) — tudo que já
   * esteve em marca: ativo, fechado (virou venda), devolvido, baixado (com
   * motivo + quem autorizou) e fechado_giga. Lê a tabela nativa `marcados`.
   */
  async marcadosHistorico(loja: string, codigo: string) {
    const base: any = await (this.prisma as any).gigaCliente.findUnique({
      where: { loja_codigo: { loja, codigo } },
    });
    if (!base) return { found: false, itens: [] };
    const fichas: any[] = base.personKey
      ? await (this.prisma as any).gigaCliente.findMany({ where: { personKey: base.personKey } })
      : [base];
    const digits = String(base.cpf || '').replace(/\D/g, '');
    const itens: any[] = await (this.prisma as any).marcado.findMany({
      where: {
        isTraining: false,
        OR: [
          ...(digits.length === 11 ? [{ cpf: digits }] : []),
          ...fichas.map((f) => ({ codCliente: String(f.codigo), storeCode: String(f.loja) })),
        ],
      },
      orderBy: [{ dataMarcacao: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return {
      found: true,
      itens: itens.map((n) => ({
        registro: n.registroGiga != null ? Number(n.registroGiga) : null,
        data: n.dataMarcacao,
        sku: n.sku,
        descricao: n.descricao || '',
        qty: n.qty,
        valorTotal: Number(n.valorTotal) || 0,
        loja: n.storeCode,
        status: n.status,
        fechadoAt: n.fechadoAt,
        devolvidoAt: n.devolvidoAt,
        baixadoAt: n.baixadoAt,
        baixaMotivo: n.baixaMotivo,
        baixaPor: n.baixaPor,
        saleId: n.saleId,
      })),
    };
  }

  async resumo(loja: string, codigo: string) {
    const base: any = await (this.prisma as any).gigaCliente.findUnique({
      where: { loja_codigo: { loja, codigo } },
    });
    if (!base) return { found: false };
    const fichas: any[] = base.personKey
      ? await (this.prisma as any).gigaCliente.findMany({ where: { personKey: base.personKey } })
      : [base];

    // Crediário em aberto — NATIVO primeiro (crediário nativo fase 1),
    // fallback espelho de abertas se o nativo ainda está vazio.
    const orFichasResumo = fichas.map((f) => ({ loja: f.loja, codCliente: f.codigo }));
    const temNativo = await (this.prisma as any).crediarioParcela.findFirst({ select: { registro: true } }).catch(() => null);
    const parcelas: any[] = temNativo
      ? await (this.prisma as any).crediarioParcela.findMany({
          where: { OR: orFichasResumo, pago: false },
          select: { valorParcela: true, vencimento: true },
        }).catch(() => [])
      : await (this.prisma as any).wincredMovimentoAberto.findMany({
          where: { OR: orFichasResumo },
          select: { valorParcela: true, vencimento: true },
        }).catch(() => []);
    const crediarioAbertoReais = Math.round(parcelas.reduce((s, p) => s + (Number(p.valorParcela) || 0), 0) * 100) / 100;
    const crediarioVencidas = parcelas.filter((p) => p.vencimento && new Date(p.vencimento).getTime() < Date.now() - 86400000).length;

    // MARCADOS pra fechar — NATIVO (tabela marcados, 21/07 "chega de Giga");
    // se o espelho nunca foi importado, cai pro Giga ao vivo. Erro → null
    // (a tela avisa).
    let marcados: { itens: any[]; totalReais: number } | null = null;
    try {
      const temNativo = (await (this.prisma as any).marcado.count()) > 0
        && String(process.env.MARCADOS_NATIVE_READS ?? '').trim() !== '0';
      const itens: any[] = [];
      if (temNativo) {
        const orMarc = fichas.map((f: any) => ({
          codCliente: String(f.codigo),
          storeCode: String(f.loja).replace(/\D/g, '').padStart(2, '0'),
        }));
        const nativos: any[] = await (this.prisma as any).marcado.findMany({
          where: { status: 'ativo', isTraining: false, OR: orMarc },
          orderBy: [{ dataMarcacao: 'desc' }],
          take: 200,
        });
        itens.push(...nativos.map((n) => ({
          REGISTRO: n.registroGiga != null ? Number(n.registroGiga) : null,
          DATA: n.dataMarcacao,
          DESCRICAO: n.descricao || '',
          QUANTIDADE: n.qty,
          VALORTOTAL: Number(n.valorTotal) || 0,
          LOJA: n.storeCode,
        })));
      } else {
        for (const f of fichas) {
          const cod = Number(String(f.codigo).replace(/\D/g, '')) || 0;
          const lj = String(f.loja).replace(/\D/g, '').padStart(2, '0');
          if (!cod) continue;
          const r = await this.erp.runReadOnly(
            `SELECT REGISTRO, DATA, DESCRICAO, QUANTIDADE, VALORTOTAL, LOJA
               FROM caixa
              WHERE UPPER(MARCADO) = 'SIM' AND CLIENTE = ${cod} AND LOJA = '${lj}'
              ORDER BY DATA DESC LIMIT 100`,
            { maxRows: 100, timeoutMs: 8000 },
          );
          itens.push(...r.rows);
        }
      }
      const totalReais = Math.round(itens.reduce((s, r) => s + (Number(r.VALORTOTAL) || 0), 0) * 100) / 100;
      marcados = { itens, totalReais };
    } catch (e) {
      this.logger.warn(`[clientes-giga] resumo: marcados indisponível (${(e as Error).message})`);
    }

    // Limite / avaliação / bloqueado — da ficha ABERTA (são POR LOJA no Giga)
    const raw = base.rawJson || {};
    const limiteTotal = Number(base.limiteCompras ?? raw.LIMITECOMPRAS) || 0;
    const avaliacao = String(base.avaliacao ?? raw.AVALIACAO ?? '').trim().toUpperCase() || null;
    const bloqueado = String(base.bloqueado ?? raw.BLOQUEADO ?? '').trim().toUpperCase() === 'SIM';
    const totalMarcado = marcados?.totalReais ?? 0;
    const limiteDisponivel = Math.round((limiteTotal - totalMarcado) * 100) / 100;

    let podeMarcar = true;
    let motivoMarcar: string | null = null;
    if (bloqueado) { podeMarcar = false; motivoMarcar = 'Cliente BLOQUEADO'; }
    else if (avaliacao !== 'A') { podeMarcar = false; motivoMarcar = `Avaliação "${avaliacao || '—'}" — só clientes A marcam`; }
    else if (limiteTotal <= 0) { podeMarcar = false; motivoMarcar = 'Sem limite de compras configurado'; }
    else if (marcados && limiteDisponivel <= 0) { podeMarcar = false; motivoMarcar = 'Limite todo tomado por marcados em aberto'; }

    // Cashback — da PESSOA (CRM), disponível em qualquer loja
    let cashbackCents: number | null = null;
    const digits = String(base.cpf || '').replace(/\D/g, '');
    if (digits.length === 11) {
      try {
        const customers = await findAllCustomersByCpf(this.prisma as any, digits);
        cashbackCents = aggregatePerson(customers).cashbackBalanceCents || 0;
      } catch { /* CRM indisponível — segue null */ }
    }

    return {
      found: true,
      crediarioAbertoReais,
      crediarioVencidas,
      marcados,               // null = Giga fora (sem conferência ao vivo agora)
      limiteTotal,
      limiteDisponivel,
      avaliacao,
      bloqueado,
      podeMarcar,
      motivoMarcar,
      cashbackCents,
      lojaFicha: base.loja,
      codigoFicha: base.codigo,
    };
  }

  /**
   * HISTÓRICO COMPLETO da pessoa — integração site + lojas + live (regra do
   * dono): compras das LOJAS (espelho giga_caixa_mov, zero Giga vivo), vendas
   * do PDV Flow, pedidos do SITE, carrinhos pagos da LIVE e DEVOLUÇÕES.
   * Uma linha do tempo só, mais recente primeiro.
   */
  async historico(loja: string, codigo: string) {
    const base: any = await (this.prisma as any).gigaCliente.findUnique({
      where: { loja_codigo: { loja, codigo } },
      select: { loja: true, codigo: true, cpf: true, personKey: true },
    });
    if (!base) return { found: false, eventos: [] };
    const fichas: any[] = base.personKey
      ? await (this.prisma as any).gigaCliente.findMany({
          where: { personKey: base.personKey },
          select: { loja: true, codigo: true },
        })
      : [{ loja: base.loja, codigo: base.codigo }];

    const digits = String(base.cpf || '').replace(/\D/g, '');
    const cpfVariants = digits.length === 11
      ? [digits, `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`]
      : [];

    const num = (v: any) => (v == null ? 0 : Number(v) || 0);
    type Ev = { origem: string; data: Date | null; loja: string | null; titulo: string; detalhe: string | null; valor: number; itens?: number };
    const eventos: Ev[] = [];

    // ── 1. LOJAS (Giga espelhado): linhas da caixa por (loja, codCliente) ou CPF,
    //    agrupadas por COMPRA (loja+numero+data). MARCADO vira etiqueta.
    const caixaOr: any[] = fichas.map((f) => ({ loja: f.loja, codCliente: f.codigo }));
    if (cpfVariants.length) caixaOr.push({ cpf: { in: cpfVariants } });
    const caixaRows: any[] = await (this.prisma as any).gigaCaixaMov.findMany({
      where: { OR: caixaOr },
      orderBy: { data: 'desc' },
      take: 1500,
    }).catch(() => []);
    const compras = new Map<string, { data: Date | null; loja: string | null; itens: any[]; total: number; marcado: boolean; fpag: string | null; vendedora: string | null }>();
    for (const r of caixaRows) {
      const k = `${r.loja}|${r.numero || r.registro}|${r.data ? new Date(r.data).toISOString().slice(0, 10) : ''}`;
      let c = compras.get(k);
      if (!c) compras.set(k, (c = { data: r.data, loja: r.loja, itens: [], total: 0, marcado: false, fpag: r.fpag || null, vendedora: r.vendedora || r.vendedor || null }));
      c.itens.push(r);
      c.total += num(r.valorTotal);
      if (String(r.marcado || '').toUpperCase() === 'SIM') c.marcado = true;
    }
    for (const c of compras.values()) {
      const primeiro = c.itens[0];
      eventos.push({
        origem: c.marcado ? 'MARCADO' : 'LOJA',
        data: c.data,
        loja: c.loja,
        titulo: String(primeiro?.descricao || 'Compra na loja').slice(0, 60) + (c.itens.length > 1 ? ` +${c.itens.length - 1} itens` : ''),
        detalhe: [c.fpag, c.vendedora && `vend. ${c.vendedora}`].filter(Boolean).join(' · ') || null,
        valor: Math.round(c.total * 100) / 100,
        itens: c.itens.length,
      });
    }

    if (cpfVariants.length) {
      // ── 2. PDV Flow ──
      const vendas: any[] = await (this.prisma as any).pdvSale.findMany({
        where: { customerCpf: { in: cpfVariants }, status: 'finalized', isTraining: false },
        select: { storeCode: true, finalizedAt: true, total: true, paymentMethod: true, _count: { select: { items: true } } },
        orderBy: { finalizedAt: 'desc' },
        take: 300,
      }).catch(() => []);
      for (const v of vendas) {
        eventos.push({
          origem: 'PDV', data: v.finalizedAt, loja: v.storeCode,
          titulo: `Venda PDV (${v._count?.items ?? '?'} item${(v._count?.items || 0) > 1 ? 's' : ''})`,
          detalhe: v.paymentMethod || null, valor: num(v.total), itens: v._count?.items,
        });
      }
      // ── 3. SITE ──
      const pedidos: any[] = await (this.prisma as any).order.findMany({
        where: { customerCpf: { in: cpfVariants } },
        select: { wcOrderNumber: true, wcDateCreated: true, createdAt: true, totalAmount: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }).catch(() => []);
      for (const p of pedidos) {
        eventos.push({
          origem: 'SITE', data: p.wcDateCreated || p.createdAt, loja: null,
          titulo: `Pedido site ${p.wcOrderNumber ? `#${p.wcOrderNumber}` : ''}`.trim(),
          detalhe: p.status || null, valor: num(p.totalAmount),
        });
      }
      // ── 4. LIVE ──
      const carts: any[] = await (this.prisma as any).livePdvCart.findMany({
        where: { customerCpf: { in: cpfVariants }, status: { in: ['paid', 'separating', 'shipped', 'delivered'] } },
        select: { cartNumber: true, paidAt: true, createdAt: true, totalCents: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }).catch(() => []);
      for (const c of carts) {
        eventos.push({
          origem: 'LIVE', data: c.paidAt || c.createdAt, loja: null,
          titulo: `Live${c.cartNumber ? ` · carrinho ${c.cartNumber}` : ''}`,
          detalhe: c.status, valor: num(c.totalCents) / 100,
        });
      }
      // ── 5. DEVOLUÇÕES ──
      const devs: any[] = await (this.prisma as any).pdvReturn.findMany({
        where: { customerCpf: { in: cpfVariants }, isTraining: false },
        select: { storeCode: true, createdAt: true, valorTotal: true, modo: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }).catch(() => []);
      for (const d of devs) {
        eventos.push({
          origem: 'DEVOLUCAO', data: d.createdAt, loja: d.storeCode,
          titulo: 'Devolução/troca', detalhe: d.modo || null, valor: -num(d.valorTotal),
        });
      }
    }

    eventos.sort((a, b) => (b.data ? new Date(b.data).getTime() : 0) - (a.data ? new Date(a.data).getTime() : 0));
    const porOrigem: Record<string, { qtd: number; total: number }> = {};
    for (const e of eventos) {
      const o = (porOrigem[e.origem] = porOrigem[e.origem] || { qtd: 0, total: 0 });
      o.qtd++; o.total += e.valor;
    }
    return { found: true, eventos: eventos.slice(0, 400), porOrigem };
  }
}
