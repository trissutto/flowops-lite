/**
 * CustomersGigaEtlService — sincroniza clientes do Giga (Wincred MySQL) pro
 * Postgres do FlowOps (modelo Customer).
 *
 * IMPORTANTE: Esta service é READ-ONLY no Giga. Nunca escreve lá. Só LÊ
 * via SELECT e POPULA o Postgres do FlowOps.
 *
 * Arquitetura:
 *
 *   Giga MySQL (tabela `clientes`) ─READ─┐
 *                                          │
 *   WooCommerce API (ETL próprio) ────────┼──→ Customer (Postgres FlowOps)
 *                                          │     fonte única consolidada
 *   Cadastro manual /clientes-crm ────────┘
 *
 * MERGE INTELIGENTE — quando o mesmo CPF aparece em 2+ canais:
 *
 * | Campo                    | Estratégia                                  |
 * |--------------------------|---------------------------------------------|
 * | CPF (chave)              | Nunca muda                                  |
 * | Nome                     | Só preenche se Customer.name for null/vazio |
 * | Telefone (whatsapp)      | Só preenche se null                         |
 * | Email                    | Só preenche se null                         |
 * | Endereço residencial     | Cria CustomerAddress(type=res) se não tiver |
 * | Aniversário (birthDate)  | Só preenche se null                         |
 * | registroGiga             | Sempre atualiza (rastreio)                  |
 * | tamanho preferido        | NUNCA toca (só vem do PDV/CRM)              |
 * | body type, estilo        | NUNCA toca                                  |
 * | cashback                 | NUNCA toca                                  |
 * | opt-in LGPD              | NUNCA toca                                  |
 * | tier VIP                 | Recalculado depois (LTV consolidado)        |
 *
 * Janela de histórico: TUDO (todas as vendas da tabela `caixa` no Giga).
 * Performance: batches de 500, pause 50ms entre batches pra não asfixiar
 * o Giga durante o expediente.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * Estado do sync Giga → Customer.
 * EXPORTADO porque o controller usa esse tipo no retorno público dos
 * endpoints — sem export o tsc lança TS4053 ("tipo não pode ser nomeado").
 */
export interface GigaSyncState {
  running: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  totalGiga: number;
  processados: number;
  criados: number;
  atualizados: number;
  pulados: number;
  erros: number;
  lastError: string | null;
  fase: 'idle' | 'clientes' | 'historico' | 'tier' | 'done' | 'cancelled';
  faseProgresso: { current: number; total: number };
  /** Flag de cancelamento — loops do sync checam isto em cada iteração */
  abortRequested?: boolean;
}

@Injectable()
export class CustomersGigaEtlService {
  private readonly logger = new Logger(CustomersGigaEtlService.name);

  // Map Store.code → Store.id (e variações: '1'→'01', NOME→id) carregado uma
  // vez no início da Fase 1 e reusado durante upsert+merge. Resolve a LOJA
  // char(2) do Giga pro originStoreId do Customer.
  private _storeByCode: Map<string, string> = new Map();
  // Store catch-all 'NA' (Não Atribuída) pra clientes cuja LOJA não bate
  // com nenhuma store cadastrada. Permite revisão manual depois.
  private _fallbackStoreId: string | null = null;

  /**
   * Resolve LOJA do Giga (ex: '01', '13', 'ITANHAEM') pro Store.id do FlowOps.
   * Se LOJA vazia/null → retorna undefined (Customer fica sem loja).
   * Se LOJA tem valor MAS não bate com store → retorna fallback 'NA'.
   */
  private _resolveStoreId(loja: any): string | undefined {
    if (loja === null || loja === undefined) return undefined;
    const raw = String(loja).trim().toUpperCase();
    if (!raw) return undefined;
    // Tenta exato, depois com padStart pra 2 dígitos (LOJA é char(2) com zero à esquerda)
    const matched = this._storeByCode.get(raw) ?? this._storeByCode.get(raw.padStart(2, '0'));
    if (matched) return matched;
    // Sem match → fallback pra 'NA' (Não Atribuída)
    return this._fallbackStoreId || undefined;
  }

  // State machine in-memory — só 1 sync por vez por instância.
  // Em produção (Railway), 1 instância = 1 lock. Suficiente.
  private state: GigaSyncState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    totalGiga: 0,
    processados: 0,
    criados: 0,
    atualizados: 0,
    pulados: 0,
    erros: 0,
    lastError: null,
    fase: 'idle',
    faseProgresso: { current: 0, total: 0 },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  getState(): GigaSyncState {
    return { ...this.state, faseProgresso: { ...this.state.faseProgresso } };
  }

  /**
   * Pede cancelamento do sync em andamento. Os loops checam essa flag em cada
   * iteração e param graciosamente. Os dados já persistidos no Postgres ficam
   * (não há rollback). Retorna o estado pra confirmar.
   */
  requestAbort(): GigaSyncState {
    if (!this.state.running) {
      this.logger.log('[giga-etl] requestAbort: nada rodando');
      return this.getState();
    }
    this.logger.warn('[giga-etl] === CANCELAMENTO SOLICITADO ===');
    this.state.abortRequested = true;
    return this.getState();
  }

  /**
   * DEBUG — investiga 1 cliente Giga específico pra entender por que tá com
   * loja errada no Customer. Mostra:
   *   1. Dado bruto na tabela clientes do Giga (LOJA, NOME, CPF, etc)
   *   2. Customer correspondente no Postgres (id, originStoreId, originSource)
   *   3. Store atual (code, name)
   *   4. Store que DEVERIA ter (resolveStoreId aplicado na LOJA Giga)
   *   5. Mapa interno _storeByCode (pra ver se mapping está OK)
   */
  async debugClienteGiga(codCliente: number): Promise<any> {
    const pool = (this.erp as any).pool;
    if (!pool) throw new Error('Pool Giga não inicializado');

    // Carrega o mapa de stores PRIMEIRO (se ainda não foi carregado nesta instância)
    if (this._storeByCode.size === 0) {
      const stores = await (this.prisma as any).store.findMany({
        select: { id: true, code: true, name: true },
      });
      for (const s of stores as any[]) {
        this._storeByCode.set(String(s.code).trim().toUpperCase().padStart(2, '0'), s.id);
        this._storeByCode.set(String(s.code).trim().toUpperCase(), s.id);
        if (s.name) this._storeByCode.set(String(s.name).trim().toUpperCase(), s.id);
      }
    }

    const cols = await this._detectarColunasClientes();

    // 1. Dado bruto Giga
    const [gigaRows]: any = await pool.query(
      `SELECT * FROM clientes WHERE ${cols.codigo} = ? LIMIT 1`,
      [codCliente],
    );
    const giga = gigaRows[0] || null;
    const lojaGiga = giga && cols.loja ? giga[cols.loja] : null;

    // 2. Customer atual
    const customer = await (this.prisma as any).customer.findFirst({
      where: { registroGiga: codCliente },
      include: { originStore: { select: { code: true, name: true } } },
    });

    // 3. Store que deveria ser
    const storeIdResolved = this._resolveStoreId(lojaGiga);
    let storeResolved: any = null;
    if (storeIdResolved) {
      storeResolved = await (this.prisma as any).store.findUnique({
        where: { id: storeIdResolved },
        select: { code: true, name: true },
      });
    }

    return {
      codClienteBuscado: codCliente,
      colunaLojaDetectada: cols.loja,
      giga: {
        encontrado: !!giga,
        codigo: giga?.[cols.codigo] ?? null,
        nome: giga?.[cols.nome] ?? null,
        cpf: giga?.[cols.cpf] ?? null,
        loja_raw: lojaGiga,
        loja_raw_typeof: typeof lojaGiga,
        loja_raw_length: lojaGiga != null ? String(lojaGiga).length : null,
        loja_normalizado: lojaGiga != null ? String(lojaGiga).trim().toUpperCase() : null,
      },
      customer: customer ? {
        id: customer.id,
        name: customer.name,
        cpf: customer.cpf,
        registroGiga: customer.registroGiga,
        originSource: customer.originSource,
        originStoreId: customer.originStoreId,
        originStore: customer.originStore,
        active: customer.active,
      } : null,
      storeResolved: {
        storeIdRetornado: storeIdResolved,
        storeCode: storeResolved?.code,
        storeName: storeResolved?.name,
      },
      diagnostico: {
        deveriaAtualizar: storeIdResolved && storeIdResolved !== customer?.originStoreId,
        motivoPular: !customer
          ? 'Cliente não existe no Customer'
          : !storeIdResolved
            ? 'LOJA Giga não bate com nenhuma Store'
            : storeIdResolved === customer.originStoreId
              ? 'Já está com a loja correta'
              : 'Deveria atualizar mas algum filtro está excluindo',
      },
      _storeByCodeAmostra: Array.from(this._storeByCode.entries()).slice(0, 30),
    };
  }

  /**
   * Atualiza originStoreId dos clientes do Giga lendo o campo LOJA char(2)
   * da tabela `clientes` do Giga (fonte de verdade).
   *
   * MODO 'preencher' (default): só atribui loja a quem está com originStoreId
   *                              NULL. Cadastros manuais ficam intactos.
   * MODO 'sobrescrever':         força recálculo (corrige bagunça de syncs
   *                              anteriores). NUNCA toca em clientes WC
   *                              (originSource='woo' fica loja 13 SITE).
   */
  async atualizarLojaPrincipal(opts?: { sobrescrever?: boolean }): Promise<{
    atualizados: number;
    semLojaNoGiga: number;
    semStoreCorrespondente: number;
    pulados: number;
    duracaoMs: number;
  }> {
    const t0 = Date.now();
    const pool = (this.erp as any).pool;
    if (!pool) throw new Error('Pool Giga não inicializado');

    // Garante store catch-all 'NA' pra usar como fallback
    let storeNA = await (this.prisma as any).store.findUnique({ where: { code: 'NA' } });
    if (!storeNA) {
      try {
        storeNA = await (this.prisma as any).store.create({
          data: { code: 'NA', name: 'Não Atribuída', active: true, city: '—', uf: '—' },
        });
      } catch {}
    }
    this._fallbackStoreId = storeNA?.id || null;

    const stores = await (this.prisma as any).store.findMany({
      select: { id: true, code: true, name: true },
    });
    this._storeByCode = new Map<string, string>();
    for (const s of stores as any[]) {
      this._storeByCode.set(String(s.code).trim().toUpperCase().padStart(2, '0'), s.id);
      this._storeByCode.set(String(s.code).trim().toUpperCase(), s.id);
      if (s.name) this._storeByCode.set(String(s.name).trim().toUpperCase(), s.id);
    }

    // Detecta coluna LOJA do Giga
    const cols = await this._detectarColunasClientes();
    if (!cols.loja) {
      throw new Error('Coluna LOJA não encontrada na tabela clientes do Giga');
    }

    // Filtro: por padrão só os que estão sem loja. Com sobrescrever=true,
    // pega TODOS os clientes com registroGiga preenchido — INCLUSIVE os que
    // estão marcados originSource='woo' (clientes que compraram no site mas
    // TAMBÉM têm cadastro no Giga). Regra de negócio: se tem cadastro Giga
    // (registroGiga != null), a LOJA do Giga manda — não importa origem.
    // Resultado: clientes só-site continuam em 13 (sem registroGiga); quem
    // tem cadastro físico ganha a loja correta.
    const where: any = { registroGiga: { not: null } };
    if (!opts?.sobrescrever) where.originStoreId = null;

    const customers = await (this.prisma as any).customer.findMany({
      where,
      select: { id: true, registroGiga: true, originStoreId: true },
    });

    let atualizados = 0;
    let semLojaNoGiga = 0;
    let semStoreCorrespondente = 0;
    let pulados = 0;

    // Busca LOJA do Giga em batches via IN (...) — muito mais rápido que 1 query por cliente
    const BATCH = 200;
    for (let i = 0; i < customers.length; i += BATCH) {
      const slice = customers.slice(i, i + BATCH);
      const codigos = slice.map((c: any) => Number(c.registroGiga)).filter(Boolean);
      if (codigos.length === 0) continue;

      const placeholders = codigos.map(() => '?').join(',');
      const [rows]: any = await pool.query(
        `SELECT ${cols.codigo} AS codCliente, ${cols.loja} AS loja
          FROM clientes
          WHERE ${cols.codigo} IN (${placeholders})`,
        codigos,
      );
      const lojaByCod = new Map<number, string | null>();
      for (const r of rows as any[]) {
        lojaByCod.set(Number(r.codCliente), r.loja ? String(r.loja).trim() : null);
      }

      for (const c of slice as any[]) {
        const lojaRaw = lojaByCod.get(Number(c.registroGiga));
        if (!lojaRaw) { semLojaNoGiga++; continue; }
        const storeId = this._resolveStoreId(lojaRaw);
        if (!storeId) { semStoreCorrespondente++; continue; }
        if (storeId === c.originStoreId) { pulados++; continue; } // já tá certo

        try {
          await (this.prisma as any).customer.update({
            where: { id: c.id },
            data: { originStoreId: storeId },
          });
          atualizados++;
        } catch (e: any) {
          this.logger.warn(`[giga-etl] atualizar loja cliente ${c.id} falhou: ${e?.message}`);
        }
      }
    }

    this.logger.log(
      `[giga-etl] atualizarLojaPrincipal (sobrescrever=${!!opts?.sobrescrever}): ` +
      `${atualizados} atualizados, ${pulados} já estavam OK, ` +
      `${semLojaNoGiga} sem LOJA no Giga, ${semStoreCorrespondente} sem store match. ` +
      `${Date.now() - t0}ms`,
    );

    return {
      atualizados,
      semLojaNoGiga,
      semStoreCorrespondente,
      pulados,
      duracaoMs: Date.now() - t0,
    };
  }

  /**
   * Diagnóstico de lojas — cruza:
   *   1. Stores cadastradas no FlowOps (code + name + id)
   *   2. Distribuição da coluna LOJA da tabela `clientes` do Giga
   *      (quantos clientes em cada LOJA + se bate com alguma Store)
   *   3. Distribuição atual de originStoreId no Customer FlowOps
   *
   * Útil pra entender por que clientes não aparecem no filtro de loja:
   *   - LOJA Giga sem store match? (precisa cadastrar store no FlowOps)
   *   - LOJA Giga vazia? (sync não tem como inferir)
   *   - Customer originStoreId errado/null? (precisa rodar atualização)
   */
  async diagnosticarLojas(): Promise<{
    storesFlowOps: Array<{ id: string; code: string; name: string }>;
    lojasNoGiga: Array<{ loja: string | null; qtdClientes: number; matchedStore: string | null }>;
    clientesPorStoreNoCustomer: Array<{ storeCode: string | null; storeName: string | null; qtdClientes: number }>;
  }> {
    const pool = (this.erp as any).pool;
    if (!pool) throw new Error('Pool Giga não inicializado');

    // 1) Stores do FlowOps
    const stores = await (this.prisma as any).store.findMany({
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    });
    const storeByCodeUpper = new Map<string, { id: string; code: string; name: string }>();
    for (const s of stores as any[]) {
      storeByCodeUpper.set(String(s.code).trim().toUpperCase().padStart(2, '0'), s);
      storeByCodeUpper.set(String(s.code).trim().toUpperCase(), s);
    }

    // 2) Distribuição LOJA no Giga
    const cols = await this._detectarColunasClientes();
    let lojasNoGiga: Array<{ loja: string | null; qtdClientes: number; matchedStore: string | null }> = [];
    if (cols.loja) {
      const [rows]: any = await pool.query(
        `SELECT COALESCE(${cols.loja}, '') AS loja, COUNT(*) AS qtd
          FROM clientes
          GROUP BY ${cols.loja}
          ORDER BY qtd DESC`,
      );
      lojasNoGiga = (rows as any[]).map((r) => {
        const raw = String(r.loja || '').trim().toUpperCase();
        const matched = storeByCodeUpper.get(raw) || storeByCodeUpper.get(raw.padStart(2, '0'));
        return {
          loja: raw || null,
          qtdClientes: Number(r.qtd) || 0,
          matchedStore: matched ? `${matched.code} - ${matched.name}` : null,
        };
      });
    }

    // 3) Distribuição originStoreId no Customer FlowOps
    const grupos = await (this.prisma as any).customer.groupBy({
      by: ['originStoreId'],
      _count: { _all: true },
      orderBy: { _count: { originStoreId: 'desc' } },
    });
    const storeById = new Map<string, { code: string; name: string }>();
    for (const s of stores as any[]) storeById.set(s.id, s);

    const clientesPorStoreNoCustomer = (grupos as any[]).map((g) => {
      const s = g.originStoreId ? storeById.get(g.originStoreId) : null;
      return {
        storeCode: s?.code || null,
        storeName: s?.name || (g.originStoreId ? '(store id desconhecido)' : null),
        qtdClientes: Number(g._count?._all) || 0,
      };
    });

    return {
      storesFlowOps: stores as any[],
      lojasNoGiga,
      clientesPorStoreNoCustomer,
    };
  }

  /**
   * Diagnóstico — lista TODAS as colunas da tabela `clientes` do Giga
   * + 3 amostras de dados + sugestão de mapeamento pro modelo Customer.
   *
   * Usado pra você ver o que tem e me dizer quais campos novos importar.
   */
  async diagnosticarColunas(): Promise<{
    totalClientes: number;
    colunas: Array<{
      nome: string;
      tipo: string;
      nullable: boolean;
      mapeadoParaCustomer: string | null;
      amostra: Array<string | null>;
    }>;
  }> {
    const pool = (this.erp as any).pool;
    if (!pool) throw new Error('Pool Giga não inicializado');

    // 1. SHOW COLUMNS — pega TODAS as colunas com tipo e nullable
    const [colRows]: any = await pool.query(`SHOW COLUMNS FROM clientes`);

    // 2. Total clientes pra contexto
    const [[count]]: any = await pool.query(`SELECT COUNT(*) AS total FROM clientes`);

    // 3. Pega 3 amostras de cada coluna (limita 3 clientes aleatórios)
    const colNames = (colRows as any[]).map((r: any) => r.Field);
    const colsList = colNames.map((c) => `\`${c}\``).join(', ');
    const [amostras]: any = await pool.query(
      `SELECT ${colsList} FROM clientes ORDER BY CODIGO DESC LIMIT 3`,
    );

    // 4. Mapeamento conhecido — campos já importados pelo ETL atual
    const mapeamentoAtual: Record<string, string> = {
      CODIGO: 'registroGiga',
      NOME: 'name',
      CPF: 'cpf',
      FONECEL: 'whatsapp',
      CELULAR: 'whatsapp',
      WHATSAPP: 'whatsapp',
      FONE2: 'whatsapp',
      FONERES: 'phone',
      TELEFONE: 'phone',
      FONE: 'phone',
      FONE1: 'phone',
      EMAIL: 'email',
      E_MAIL: 'email',
      MAIL: 'email',
      NASCIMENTO: 'birthDate',
      DATA_NASCIMENTO: 'birthDate',
      DTNASC: 'birthDate',
      NASC: 'birthDate',
      ENDERECORES: 'address.street',
      ENDERECO: 'address.street',
      LOGRADOURO: 'address.street',
      RUA: 'address.street',
      NUMERORES: 'address.number',
      NUMERO: 'address.number',
      NUM: 'address.number',
      COMPRES: 'address.complement',
      COMPLEMENTO: 'address.complement',
      COMP: 'address.complement',
      BAIRRORES: 'address.district',
      BAIRRO: 'address.district',
      BAI: 'address.district',
      CIDADERES: 'address.city',
      CIDADE: 'address.city',
      MUNICIPIO: 'address.city',
      UFRES: 'address.state',
      UF: 'address.state',
      ESTADO: 'address.state',
      CEPRES: 'address.zipCode',
      CEP: 'address.zipCode',
    };

    const colunas = (colRows as any[]).map((r: any, idx: number) => {
      const nome = String(r.Field);
      const amostra = (amostras as any[]).map((row) => {
        const v = row[nome];
        if (v === null || v === undefined) return null;
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        const s = String(v).trim();
        return s.length > 60 ? s.slice(0, 60) + '...' : s;
      });
      return {
        nome,
        tipo: String(r.Type),
        nullable: String(r.Null).toUpperCase() === 'YES',
        mapeadoParaCustomer: mapeamentoAtual[nome.toUpperCase()] || null,
        amostra,
      };
    });

    return {
      totalClientes: Number(count?.total) || 0,
      colunas,
    };
  }

  /**
   * Inicia sync FULL Giga→Customer em background.
   * Retorna imediatamente — o sync pode demorar minutos/horas pra 10k+ clientes.
   *
   * Frontend faz polling em GET /customers-crm/etl/giga/status pra acompanhar.
   */
  startFullSync(): boolean {
    if (this.state.running) {
      this.logger.warn('[giga-etl] sync já em andamento — ignorando novo start');
      return false;
    }
    this.state = {
      running: true,
      startedAt: new Date(),
      finishedAt: null,
      totalGiga: 0,
      processados: 0,
      criados: 0,
      atualizados: 0,
      pulados: 0,
      erros: 0,
      lastError: null,
      fase: 'clientes',
      faseProgresso: { current: 0, total: 0 },
      abortRequested: false,
    };
    // Fire-and-forget — roda em background
    this._runSync().catch((e) => {
      this.logger.error(`[giga-etl] sync falhou: ${e?.message}`);
      this.state.lastError = e?.message || String(e);
      this.state.running = false;
      this.state.fase = 'idle';
      this.state.finishedAt = new Date();
    });
    return true;
  }

  /**
   * Executa as 3 fases:
   *  1. clientes — sync cadastro básico (NOME, CPF, telefones, endereço)
   *  2. historico — pra cada Customer, calcula LTV/orderCount/lastOrderAt
   *     somando compras da tabela caixa do Giga (sem dupla contagem com PDV)
   *  3. tier — recalcula vipTier baseado no LTV final consolidado
   */
  private async _runSync(): Promise<void> {
    this.logger.log('[giga-etl] === SYNC FULL iniciado ===');

    // ─── FASE 1: CLIENTES + originStoreId (LOJA do Giga) ─────────────────
    if (!this.state.abortRequested) {
      this.state.fase = 'clientes';
      await this._syncClientes();
    }

    // ─── FASE 2: HISTÓRICO (LTV / orderCount / lastOrderAt) ──────────────
    // DESABILITADO por decisão de negócio (Lurd's): o histórico antigo do Giga
    // não é confiável. LTV dos clientes Giga começa do zero e vai sendo
    // construído conforme as vendas no FlowOps PDV (finalize() do PdvSale
    // atualiza Customer). Clientes WC mantêm o LTV calculado pelo ETL Woo.
    // Pra retomar: descomentar as 2 linhas abaixo.
    // if (!this.state.abortRequested) {
    //   this.state.fase = 'historico';
    //   await this._syncHistorico();
    // }

    // ─── FASE 3: TIER (recalcula vipTier) ────────────────────────────────
    // Continua valendo — pega o LTV atual (0 pros Giga novos, real pros WC)
    // e atribui tier. Quem é Giga vira bronze; quem é WC com LTV alto sobe.
    if (!this.state.abortRequested) {
      this.state.fase = 'tier';
      await this._recalcularTiers();
    }

    // Estado final: cancelled se foi abortado, done se concluiu
    if (this.state.abortRequested) {
      this.state.fase = 'cancelled';
      this.logger.warn(
        `[giga-etl] === SYNC CANCELADO === ` +
        `criados=${this.state.criados} atualizados=${this.state.atualizados} ` +
        `pulados=${this.state.pulados} erros=${this.state.erros}`,
      );
    } else {
      this.state.fase = 'done';
      this.logger.log(
        `[giga-etl] === SYNC concluído === ` +
        `criados=${this.state.criados} atualizados=${this.state.atualizados} ` +
        `pulados=${this.state.pulados} erros=${this.state.erros}`,
      );
    }
    this.state.running = false;
    this.state.finishedAt = new Date();
    this.state.abortRequested = false;
  }

  /**
   * FASE 1 — Lê tabela clientes do Giga em batches, faz upsert no Customer.
   * Colunas conhecidas (Lurd's Wincred): CODIGO, NOME, CPF, FONECEL, FONERES,
   * EMAIL, NASCIMENTO, ENDERECORES, NUMERORES, COMPRES, BAIRRORES, CIDADERES,
   * UFRES, CEPRES.
   */
  private async _syncClientes(): Promise<void> {
    const pool = (this.erp as any).pool;
    if (!pool) throw new Error('Pool Giga não inicializado');

    // 1. Conta total pra mostrar progresso
    const [[count]]: any = await pool.query(`SELECT COUNT(*) AS total FROM clientes`);
    this.state.totalGiga = Number(count?.total) || 0;
    this.state.faseProgresso = { current: 0, total: this.state.totalGiga };
    this.logger.log(`[giga-etl] FASE 1: ${this.state.totalGiga} clientes no Giga`);

    // 2. Detecta colunas reais (Giga muda nome entre instalações)
    const cols = await this._detectarColunasClientes();

    // 2.5. Carrega mapeamento Store.code → Store.id pra resolver originStoreId
    // direto durante o upsert. LOJA char(2) do Giga (ex: '01') bate com Store.code.
    //
    // CATCH-ALL: garante store 'NA' (Não Atribuída) pra clientes cuja LOJA
    // do Giga não bate com nenhuma store cadastrada (ex: lojas antigas tipo
    // 'C', 'G', '09'). Esses ficam nessa store pra revisão manual depois.
    let storeNA = await (this.prisma as any).store.findUnique({ where: { code: 'NA' } });
    if (!storeNA) {
      try {
        storeNA = await (this.prisma as any).store.create({
          data: {
            code: 'NA',
            name: 'Não Atribuída',
            active: true,
            city: '—',
            uf: '—',
          },
        });
        this.logger.log(`[giga-etl] Criada store catch-all 'NA' (id=${storeNA.id})`);
      } catch (e: any) {
        this.logger.warn(`[giga-etl] Falha ao criar store 'NA': ${e?.message}`);
      }
    }
    this._fallbackStoreId = storeNA?.id || null;

    const stores = await (this.prisma as any).store.findMany({
      select: { id: true, code: true, name: true },
    });
    this._storeByCode = new Map<string, string>();
    for (const s of stores as any[]) {
      this._storeByCode.set(String(s.code).trim().toUpperCase().padStart(2, '0'), s.id);
      this._storeByCode.set(String(s.code).trim().toUpperCase(), s.id);
      if (s.name) this._storeByCode.set(String(s.name).trim().toUpperCase(), s.id);
    }
    this.logger.log(
      `[giga-etl] FASE 1: ${stores.length} lojas mapeadas. Coluna LOJA Giga: ${cols.loja || 'NÃO ENCONTRADA'}. ` +
      `Fallback store NA: ${this._fallbackStoreId || 'NÃO DISPONÍVEL'}`,
    );

    // 3. Lê em batches de 500
    const BATCH = 500;
    let offset = 0;
    while (offset < this.state.totalGiga) {
      // Verifica cancelamento ANTES de cada batch
      if (this.state.abortRequested) {
        this.logger.warn(`[giga-etl] FASE 1 abortada em offset=${offset}`);
        break;
      }
      try {
        const selectFields = [
          `${cols.codigo} AS codCliente`,
          `${cols.nome} AS nome`,
          `${cols.cpf} AS cpf`,
          cols.foneCel ? `${cols.foneCel} AS foneCel` : `NULL AS foneCel`,
          cols.foneRes ? `${cols.foneRes} AS foneRes` : `NULL AS foneRes`,
          cols.email ? `${cols.email} AS email` : `NULL AS email`,
          cols.nascimento ? `${cols.nascimento} AS nascimento` : `NULL AS nascimento`,
          cols.endereco ? `${cols.endereco} AS endereco` : `NULL AS endereco`,
          cols.numero ? `${cols.numero} AS numero` : `NULL AS numero`,
          cols.complemento ? `${cols.complemento} AS complemento` : `NULL AS complemento`,
          cols.bairro ? `${cols.bairro} AS bairro` : `NULL AS bairro`,
          cols.cidade ? `${cols.cidade} AS cidade` : `NULL AS cidade`,
          cols.uf ? `${cols.uf} AS uf` : `NULL AS uf`,
          cols.cep ? `${cols.cep} AS cep` : `NULL AS cep`,
          cols.loja ? `${cols.loja} AS loja` : `NULL AS loja`,
        ].join(', ');

        const [rows]: any = await pool.query(
          `SELECT ${selectFields} FROM clientes ORDER BY ${cols.codigo} LIMIT ? OFFSET ?`,
          [BATCH, offset],
        );

        for (const r of rows) {
          try {
            await this._upsertCustomerFromGiga(r);
            this.state.processados++;
          } catch (e: any) {
            this.state.erros++;
            this.state.lastError = `${r.cpf || r.nome}: ${e?.message}`;
            this.logger.warn(`[giga-etl] erro upsert: ${this.state.lastError}`);
          }
        }
        offset += BATCH;
        this.state.faseProgresso.current = offset;
        // pause 50ms entre batches pra não asfixiar Giga
        await new Promise((res) => setTimeout(res, 50));
      } catch (e: any) {
        this.state.erros++;
        this.state.lastError = `Batch offset=${offset}: ${e?.message}`;
        this.logger.error(`[giga-etl] FASE 1 batch falhou: ${this.state.lastError}`);
        offset += BATCH; // pula esse batch
      }
    }
  }

  /**
   * Detecta nomes reais das colunas na tabela `clientes` do Giga.
   * Lurd's usa o padrão com sufixo RES (residencial).
   */
  private async _detectarColunasClientes(): Promise<{
    codigo: string; nome: string; cpf: string;
    foneCel: string | null; foneRes: string | null;
    email: string | null; nascimento: string | null;
    endereco: string | null; numero: string | null; complemento: string | null;
    bairro: string | null; cidade: string | null; uf: string | null; cep: string | null;
    loja: string | null;
  }> {
    const pool = (this.erp as any).pool;
    const [rows]: any = await pool.query(`SHOW COLUMNS FROM clientes`);
    const available = new Set((rows as any[]).map((r: any) => String(r.Field).toUpperCase()));

    const pick = (...candidates: string[]): string | null => {
      for (const c of candidates) {
        if (available.has(c.toUpperCase())) return c;
      }
      return null;
    };

    return {
      codigo: pick('CODIGO') || 'CODIGO',
      nome: pick('NOME', 'CLIENTE', 'RAZAO_SOCIAL') || 'NOME',
      cpf: pick('CPF', 'CPF_CNPJ', 'DOCUMENTO') || 'CPF',
      foneCel: pick('FONECEL', 'CELULAR', 'WHATSAPP', 'FONE2'),
      foneRes: pick('FONERES', 'TELEFONE', 'FONE', 'FONE1'),
      email: pick('EMAIL', 'E_MAIL', 'MAIL'),
      nascimento: pick('NASCIMENTO', 'DATA_NASCIMENTO', 'DTNASC', 'NASC'),
      endereco: pick('ENDERECORES', 'ENDERECO', 'LOGRADOURO', 'RUA', 'END'),
      numero: pick('NUMERORES', 'NUMERO', 'NUM'),
      complemento: pick('COMPRES', 'COMPLEMENTO', 'COMP'),
      bairro: pick('BAIRRORES', 'BAIRRO', 'BAI'),
      cidade: pick('CIDADERES', 'CIDADE', 'MUNICIPIO'),
      uf: pick('UFRES', 'UF', 'ESTADO'),
      cep: pick('CEPRES', 'CEP'),
      // LOJA char(2) — campo do cadastro do cliente que indica a loja
      // de origem (a que cadastrou). Esta é a fonte de verdade definitiva
      // pra originStoreId no FlowOps.
      loja: pick('LOJA', 'LOJA_ORIGEM', 'COD_LOJA'),
    };
  }

  /**
   * UPSERT de 1 cliente Giga no Customer FlowOps.
   * MERGE: nunca sobrescreve dados marketing. Só preenche o que está null.
   */
  private async _upsertCustomerFromGiga(row: any): Promise<void> {
    const cpfDigits = String(row.cpf || '').replace(/\D/g, '');
    const codCliente = Number(row.codCliente) || null;
    const cpfValido = cpfDigits && cpfDigits.length === 11;

    // Precisa de PELO MENOS codCliente pra rastreabilidade. Sem CPF nem
    // codCliente, não tem como deduplicar — pula.
    if (!cpfValido && !codCliente) {
      this.state.pulados++;
      return;
    }

    // SEM CPF, COM codCliente: importa MESMO ASSIM usando registroGiga
    // como chave (clientes antigos do Giga frequentemente não têm CPF —
    // ex: códigos 1, 2, 3, 4 do cadastro inicial da loja).
    if (!cpfValido) {
      const existing = await (this.prisma as any).customer.findFirst({
        where: { registroGiga: codCliente },
      });
      if (existing) {
        await this._aplicarMerge(existing, row);
        this.state.atualizados++;
        return;
      }
      // Cria NOVO sem CPF
      await this._criarNovo(row, '', codCliente);
      this.state.criados++;
      return;
    }

    // COM CPF VÁLIDO: busca por CPF (ambos formatos) OU por registroGiga.
    // CPF formatado pro padrão FlowOps: 12345678901 → 123.456.789-01
    const cpfFormatted = this._formatCpf(cpfDigits);
    const whereClauses: any[] = [{ cpf: cpfDigits }, { cpf: cpfFormatted }];
    if (codCliente) whereClauses.push({ registroGiga: codCliente });
    const existing = await (this.prisma as any).customer.findFirst({
      where: { OR: whereClauses },
    });

    if (existing) {
      await this._aplicarMerge(existing, row);
      this.state.atualizados++;
    } else {
      await this._criarNovo(row, cpfDigits, codCliente);
      this.state.criados++;
    }
  }

  /**
   * MERGE NÃO-DESTRUTIVO: só preenche campos null/vazios.
   * Marketing/cashback/opt-in nunca são tocados.
   */
  private async _aplicarMerge(existing: any, row: any): Promise<void> {
    const updates: any = {};

    // registroGiga sempre atualiza (rastreio)
    const codCliente = Number(row.codCliente) || null;
    if (codCliente && existing.registroGiga !== codCliente) {
      updates.registroGiga = codCliente;
    }

    // Reclassifica cliente-sistema se aplicável (e ainda não foi marcado).
    // Útil pra clientes importados antes do filtro de heurística existir.
    if (existing.originSource === 'giga') {
      const nomeAtual = (existing.name || row.nome || '').toString().toUpperCase();
      if (this._ehClienteSistema(nomeAtual)) {
        updates.originSource = 'giga_sistema';
        updates.active = false;
      }
    }

    // originStoreId: o campo LOJA do Giga é a FONTE DE VERDADE pra clientes
    // Giga. SEMPRE atualiza, mesmo se já tinha valor (corrige clientes
    // importados em syncs antigos com lógica errada). EXCEÇÃO: clientes WC
    // (originSource='woo') ficam com loja 13 (SITE) intocada.
    if (existing.originSource !== 'woo') {
      const storeId = this._resolveStoreId(row.loja);
      if (storeId && storeId !== existing.originStoreId) {
        updates.originStoreId = storeId;
      }
    }

    // ZERAR LTV inflado de syncs anteriores (que tentava importar histórico
    // Giga não confiável). LTV dos clientes Giga começa do zero — vai sendo
    // construído pelas vendas no PDV daqui em diante.
    // Só zera se NÃO é cliente WC (WC tem LTV real do site).
    if (existing.originSource !== 'woo' && Number(existing.ltvCents || 0) > 0) {
      updates.ltvCents = BigInt(0);
      updates.orderCount = 0;
      updates.ticketMedioCents = 0;
      updates.lastOrderAt = null;
    }

    // Nome: só preenche se Customer.name é null/vazio
    if (!existing.name && row.nome) {
      updates.name = String(row.nome).trim().toUpperCase();
    }

    // WhatsApp: prefere FONECEL, fallback FONERES. Só preenche se null.
    if (!existing.whatsapp) {
      const tel = String(row.foneCel || row.foneRes || '').replace(/\D/g, '');
      if (tel && tel.length >= 10) updates.whatsapp = tel;
    }

    // Telefone fixo separado se foneRes existe E é diferente do whatsapp
    if (!existing.phone && row.foneRes) {
      const tel = String(row.foneRes).replace(/\D/g, '');
      if (tel && tel.length >= 10) updates.phone = tel;
    }

    // Email
    if (!existing.email && row.email) {
      const email = String(row.email).trim().toLowerCase();
      if (email.includes('@')) updates.email = email;
    }

    // Aniversário: tenta parse de várias formatações
    if (!existing.birthDate && row.nascimento) {
      const dt = this._parseDate(row.nascimento);
      if (dt) updates.birthDate = dt;
    }

    if (Object.keys(updates).length > 0) {
      await (this.prisma as any).customer.update({
        where: { id: existing.id },
        data: updates,
      });
    }

    // Endereço: cria CustomerAddress(type=residencial) se ainda não tiver
    await this._criarEnderecoSeFaltar(existing.id, row);
  }

  /**
   * Detecta se o "cliente" do Giga é na verdade um registro de sistema/lixo
   * (VENDAS ONLINE, VISA ELECTRON, PEÇAS RESERVADAS XYZ, FISICAMENTE NÃO
   * CONSTA, etc). Esses ficam marcados com originSource='giga_sistema' pra
   * vendedora poder filtrar fora da base de marketing.
   */
  private _ehClienteSistema(nome: string | null): boolean {
    if (!nome) return false;
    const upper = String(nome).toUpperCase().trim();
    const padroes = [
      /^VENDA/, /^VENDAS/, /^VISA\s/, /^MASTER\s/, /^CART[AÃ]O/, /^CARTAO/,
      /^PE[CÇ]AS?\s/, /^PRODUTO/, /^SISTEMA/, /^CAIXA/,
      /^FISICAMENTE/, /^ARMAZ[EÉ]M/, /^DEPOSITO/, /^DEP[ÓO]SITO/,
      /^FARM[AÁ]CIA\b/, // ex: "MICHELE FARMÁCIA" (nome estranho)
      /^TESTE/, /^TEST\s/, /^X+$/, /^N[AÃ]O\s/,
      /^CONSUMIDOR\s*FINAL/, /^DIVERSOS/,
      /RESERVADA/, /RESERVADO/, /^SEM\s/,
    ];
    return padroes.some((re) => re.test(upper));
  }

  /**
   * Cria Customer novo a partir de linha do Giga.
   * vipTier inicial = 'bronze' (recalculado na fase 3 com base no LTV).
   * originStoreId = loja do campo LOJA do Giga (fonte de verdade definitiva).
   * Clientes-sistema (VENDAS ONLINE, VISA, etc) viram originSource='giga_sistema'
   * pra ficarem fora da base de marketing.
   */
  private async _criarNovo(row: any, cpfDigits: string, codCliente: number | null): Promise<void> {
    const tel = String(row.foneCel || row.foneRes || '').replace(/\D/g, '');
    const telRes = String(row.foneRes || '').replace(/\D/g, '');
    const email = String(row.email || '').trim().toLowerCase();
    const birthDate = this._parseDate(row.nascimento);
    const originStoreId = this._resolveStoreId(row.loja);
    const nomeUpper = String(row.nome || '').trim().toUpperCase() || null;

    // Cliente-sistema (VENDAS ONLINE, VISA, PEÇAS RESERVADAS, etc) marca
    // como giga_sistema pra não poluir marketing. active=false pra não
    // aparecer em listas/campanhas por padrão.
    const isSistema = this._ehClienteSistema(nomeUpper);

    // CPF é opcional — clientes antigos do Giga (códigos 1, 2, 3...) podem
    // não ter CPF cadastrado. Nesse caso fica null e a chave de dedupe vira
    // apenas o registroGiga.
    const customer = await (this.prisma as any).customer.create({
      data: {
        cpf: cpfDigits && cpfDigits.length === 11 ? this._formatCpf(cpfDigits) : null,
        name: nomeUpper,
        whatsapp: tel.length >= 10 ? tel : null,
        phone: telRes.length >= 10 && telRes !== tel ? telRes : null,
        email: email.includes('@') ? email : null,
        birthDate,
        registroGiga: codCliente,
        originSource: isSistema ? 'giga_sistema' : 'giga',
        originStoreId,
        vipTier: 'bronze',
        active: !isSistema,
      },
    });

    await this._criarEnderecoSeFaltar(customer.id, row);
  }

  /**
   * Cria CustomerAddress(type='residencial', isPrimary=true) se ainda não houver
   * endereço residencial pra esse cliente.
   */
  private async _criarEnderecoSeFaltar(customerId: string, row: any): Promise<void> {
    if (!row.endereco && !row.cep) return; // sem endereço minimamente preenchido, pula

    const existing = await (this.prisma as any).customerAddress.findFirst({
      where: { customerId, type: 'residencial' },
    });
    if (existing) return;

    const cep = String(row.cep || '').replace(/\D/g, '');
    await (this.prisma as any).customerAddress.create({
      data: {
        customerId,
        type: 'residencial',
        isPrimary: true,
        active: true,
        street: String(row.endereco || '').trim() || null,
        number: String(row.numero || '').trim() || null,
        complement: String(row.complemento || '').trim() || null,
        district: String(row.bairro || '').trim() || null,
        city: String(row.cidade || '').trim() || null,
        state: String(row.uf || '').trim().toUpperCase().slice(0, 2) || null,
        zipCode: cep.length === 8 ? cep : null,
      },
    }).catch((e: any) => {
      this.logger.warn(`[giga-etl] criar endereço falhou customer=${customerId}: ${e?.message}`);
    });
  }

  /**
   * FASE 2 — Recalcula LTV/orderCount/lastOrderAt somando histórico do Giga
   * (tabela caixa). Importante: PULA registros que vieram do PDV FlowOps
   * pra não dupla-contar (PDV já gravou no Customer via finalize).
   *
   * Como identificar PDV no Giga? Vou usar OBSERVACAO ou OPERACAO que contenha
   * marcador. Em última instância, posso filtrar por janela de data (vendas
   * antes da data de início do FlowOps).
   *
   * Por ora: simples — soma TUDO. Em produção real, podemos refinar depois.
   */
  private async _syncHistorico(): Promise<void> {
    const pool = (this.erp as any).pool;

    // FASE 2 só calcula histórico (LTV, orderCount, lastOrderAt).
    // originStoreId já veio da Fase 1 (campo LOJA da tabela clientes do Giga).
    const customers = await (this.prisma as any).customer.findMany({
      where: { registroGiga: { not: null } },
      select: { id: true, registroGiga: true, cpf: true },
    });

    this.state.faseProgresso = { current: 0, total: customers.length };
    this.logger.log(`[giga-etl] FASE 2: histórico (LTV) de ${customers.length} clientes`);

    for (const c of customers as any[]) {
      if (this.state.abortRequested) {
        this.logger.warn(`[giga-etl] FASE 2 abortada em ${this.state.faseProgresso.current}/${this.state.faseProgresso.total}`);
        break;
      }
      try {
        // 1) Soma compras (LTV/orderCount/lastOrderAt)
        const [rows]: any = await pool.query(
          `SELECT
              COUNT(DISTINCT NUMERO) AS totalCompras,
              SUM(VALORTOTAL) AS valorTotal,
              MAX(DATA) AS ultimaCompra
            FROM caixa
            WHERE CLIENTE = ?
              AND VALORTOTAL > 0
              AND UPPER(COALESCE(MARCADO, '')) != 'SIM'`,
          [c.registroGiga],
        );
        const r = rows[0] || {};
        const ltvCents = Math.round((Number(r.valorTotal) || 0) * 100);
        const orderCount = Number(r.totalCompras) || 0;
        const lastOrderAt = r.ultimaCompra ? new Date(r.ultimaCompra) : null;

        if (orderCount > 0) {
          await (this.prisma as any).customer.update({
            where: { id: c.id },
            data: {
              ltvCents: BigInt(ltvCents),
              orderCount,
              lastOrderAt,
              ticketMedioCents: Math.round(ltvCents / orderCount),
            },
          });
        }
      } catch (e: any) {
        this.logger.warn(`[giga-etl] histórico cliente ${c.id} falhou: ${e?.message}`);
      }
      this.state.faseProgresso.current++;
    }
  }

  /**
   * FASE 3 — Recalcula vipTier conforme régua oficial:
   *   bronze:   LTV < R$ 500
   *   prata:    R$ 500-1500
   *   ouro:     R$ 1500-5000
   *   diamante: R$ 5000+
   * tierEnteredAt = data em que entrou no tier atual (now() se mudou).
   */
  private async _recalcularTiers(): Promise<void> {
    const customers = await (this.prisma as any).customer.findMany({
      select: { id: true, vipTier: true, ltvCents: true, tierEnteredAt: true },
    });
    this.state.faseProgresso = { current: 0, total: customers.length };
    this.logger.log(`[giga-etl] FASE 3: recalculando tier de ${customers.length} clientes`);

    for (const c of customers as any[]) {
      if (this.state.abortRequested) {
        this.logger.warn(`[giga-etl] FASE 3 abortada em ${this.state.faseProgresso.current}/${this.state.faseProgresso.total}`);
        break;
      }
      try {
        const ltvBRL = Number(c.ltvCents || 0) / 100;
        let novoTier: string;
        if (ltvBRL < 500) novoTier = 'bronze';
        else if (ltvBRL < 1500) novoTier = 'prata';
        else if (ltvBRL < 5000) novoTier = 'ouro';
        else novoTier = 'diamante';

        if (novoTier !== c.vipTier) {
          await (this.prisma as any).customer.update({
            where: { id: c.id },
            data: {
              vipTier: novoTier,
              tierEnteredAt: new Date(),
            },
          });
        }
      } catch (e: any) {
        this.logger.warn(`[giga-etl] tier cliente ${c.id} falhou: ${e?.message}`);
      }
      this.state.faseProgresso.current++;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private _formatCpf(digits: string): string {
    if (digits.length !== 11) return digits;
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }

  private _parseDate(input: any): Date | null {
    if (!input) return null;
    if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
    const s = String(input).trim();
    if (!s) return null;
    // Formato YYYY-MM-DD ou ISO
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const dt = new Date(s);
      return isNaN(dt.getTime()) ? null : dt;
    }
    // DD/MM/YYYY
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) {
      const dt = new Date(`${m[3]}-${m[2]}-${m[1]}`);
      return isNaN(dt.getTime()) ? null : dt;
    }
    return null;
  }
}
