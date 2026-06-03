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
   * Calcula personKey (chave de PESSOA) a partir de identidade.
   * Hierarquia: cpf digits → email lower → hash(nome+nascimento).
   * Múltiplos Customers com mesmo personKey = mesma pessoa em canais diferentes.
   */
  private _computePersonKey(input: {
    cpf?: string | null;
    email?: string | null;
    name?: string | null;
    birthDate?: Date | string | null;
  }): string | null {
    const cpfDigits = String(input.cpf || '').replace(/\D/g, '');
    if (cpfDigits.length === 11) return `cpf:${cpfDigits}`;
    const email = String(input.email || '').trim().toLowerCase();
    if (email.includes('@')) return `email:${email}`;
    const name = String(input.name || '').trim().toUpperCase();
    if (name && input.birthDate) {
      const dt = input.birthDate instanceof Date
        ? input.birthDate.toISOString().slice(0, 10)
        : String(input.birthDate).slice(0, 10);
      return `nb:${name}|${dt}`;
    }
    return null;
  }

  /**
   * Extrai campos extras do raw da linha Giga e normaliza pro schema Customer.
   * Retorna objeto pronto pra spread em customer.create({data: {...}}).
   */
  private _extractGigaExtras(row: any): any {
    const raw = row._raw || {};
    const parseDecimal = (v: any): bigint | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return BigInt(Math.round(n * 100));
    };
    const parseFlag3 = (v: any): boolean => {
      // Giga usa 'S'/'N'/'  ' em varchar(3) — só 'S' (ou similar) é true
      if (!v) return false;
      const u = String(v).trim().toUpperCase();
      return u === 'S' || u === 'SIM' || u === '1' || u === 'TRUE';
    };
    const parseDate = (v: any): Date | null => {
      if (!v) return null;
      const d = new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };
    const tel = (v: any): string | null => {
      const s = String(v || '').replace(/\D/g, '');
      return s.length >= 10 ? s : null;
    };
    return {
      rgExp: raw.RGEXP ? String(raw.RGEXP).trim() || null : null,
      rgEmissao: parseDate(raw.RGEMISSAO),
      naturalidade: raw.NATURALIDADE ? String(raw.NATURALIDADE).trim() || null : null,
      pai: raw.PAI ? String(raw.PAI).trim() || null : null,
      mae: raw.MAE ? String(raw.MAE).trim() || null : null,
      conjugeNome: raw.CONJUGE ? String(raw.CONJUGE).trim() || null : null,
      conjugeCpf: raw.CONJUGECPF ? String(raw.CONJUGECPF).replace(/\D/g, '') || null : null,
      trabalhoRazaoSocial: raw.TRABALHORAZAOSOC ? String(raw.TRABALHORAZAOSOC).trim() || null : null,
      trabalhoCargo: raw.TRABALHOCARGO ? String(raw.TRABALHOCARGO).trim() || null : null,
      trabalhoSalarioCents: parseDecimal(raw.TRABALHOSALARIO),
      trabalhoAdmissao: parseDate(raw.TRABALHOADM),
      trabalhoFone: tel(raw.TRABALHOFONE),
      nomeRecado: raw.NOMEREC ? String(raw.NOMEREC).trim() || null : null,
      foneRecado: tel(raw.FONEREC),
      limiteCrediarioCents: parseDecimal(raw.LIMITECOMPRAS),
      bloqueadoGiga: parseFlag3(raw.BLOQUEADO),
      negativadoGiga: parseFlag3(raw.NEGATIVADO),
      fidelidadeGiga: raw.FIDELIDADE ? String(raw.FIDELIDADE).trim() || null : null,
      spcSituacao: raw.SPCSITUACAO ? String(raw.SPCSITUACAO).trim() || null : null,
      spcData: parseDate(raw.SPCDATA),
      gigaPrimeiraCompra: parseDate(raw.PRICOMPRA),
      gigaUltimaCompra: parseDate(raw.ULTCOMPRA),
      casaPropria: raw.CASAPROPRIA ? parseFlag3(raw.CASAPROPRIA) : null,
      aluguelCents: parseDecimal(raw.ALUGUEL),
      gigaRawData: raw,
    };
  }

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

    // 1. Dado bruto Giga — TODAS as linhas com esse codigo (sem LIMIT)
    // Pra detectar colisão: codigo pode se repetir em lojas diferentes
    const [gigaRows]: any = await pool.query(
      `SELECT * FROM clientes WHERE ${cols.codigo} = ?`,
      [codCliente],
    );
    const giga = gigaRows[0] || null;
    const lojaGiga = giga && cols.loja ? giga[cols.loja] : null;
    const todasLinhasGiga = gigaRows.map((r: any) => ({
      codigo: r[cols.codigo],
      nome: r[cols.nome],
      loja: cols.loja ? r[cols.loja] : null,
      cpf: r[cols.cpf],
    }));

    // 2. Customers atuais ligados a esse codCliente via CustomerGigaLink
    //    (chave composta — pode ter até 1 Customer por loja)
    const links = await (this.prisma as any).customerGigaLink.findMany({
      where: { gigaCodigo: codCliente },
      include: {
        customer: {
          include: { originStore: { select: { code: true, name: true } } },
        },
      },
    });
    const customer = links[0]?.customer || null; // primeiro pra compat com output antigo

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
      totalLinhasComEsseCodigo: gigaRows.length,
      ALERTA_CODIGO_DUPLICADO: gigaRows.length > 1
        ? `🔴 BUG CONFIRMADO: existem ${gigaRows.length} clientes com codigo=${codCliente} em lojas diferentes. registroGiga precisa ser composto (LOJA-CODIGO).`
        : null,
      todasLinhasGiga,
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
        registroGiga: customer.registroGiga, // legacy — ignorar
        originSource: customer.originSource,
        originStoreId: customer.originStoreId,
        originStore: customer.originStore,
        active: customer.active,
      } : null,
      todosCustomersLigados: links.map((l: any) => ({
        gigaLoja: l.gigaLoja,
        gigaCodigo: l.gigaCodigo,
        customerId: l.customerId,
        customerName: l.customer?.name,
        customerCpf: l.customer?.cpf,
        originStore: l.customer?.originStore,
      })),
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

    // NOVA LÓGICA (jun/2026): usa CustomerGigaLink (chave composta loja+codigo)
    // em vez de registroGiga (Int único, era ambíguo). Pra cada Customer com
    // pelo menos um link Giga, pega o link MAIS ANTIGO (loja que cadastrou
    // primeiro) e usa essa loja como originStoreId.
    //
    // - sobrescrever=false: só atualiza Customers com originStoreId=null
    // - sobrescrever=true: regrava TODOS os Customers com link Giga
    const where: any = {
      gigaLinks: { some: {} }, // tem pelo menos 1 link
      originSource: { not: 'woo' }, // não toca em quem é só do site
    };
    if (!opts?.sobrescrever) where.originStoreId = null;

    const customers = await (this.prisma as any).customer.findMany({
      where,
      select: {
        id: true,
        originStoreId: true,
        gigaLinks: {
          orderBy: { createdAt: 'asc' }, // mais antigo primeiro
          take: 1,
          select: { gigaLoja: true, gigaCodigo: true },
        },
      },
    });

    let atualizados = 0;
    let semLojaNoGiga = 0;
    let semStoreCorrespondente = 0;
    let pulados = 0;

    for (const c of customers as any[]) {
      const link = c.gigaLinks?.[0];
      if (!link?.gigaLoja) { semLojaNoGiga++; continue; }
      const storeId = this._resolveStoreId(link.gigaLoja);
      if (!storeId) { semStoreCorrespondente++; continue; }
      if (storeId === c.originStoreId) { pulados++; continue; }

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
   * RESET CLIENTES GIGA — apaga todos os Customers com originSource
   * 'giga' ou 'giga_sistema' + os CustomerGigaLink (cascade). Preserva
   * WC, PDV e manual. Use ANTES de rodar Sincronizar Giga do zero pra
   * limpar bagunça de syncs antigos com chave ambígua.
   */
  async resetClientesGiga(): Promise<{
    customersApagados: number;
    linksApagados: number;
    duracaoMs: number;
  }> {
    const t0 = Date.now();

    // 1. Conta + apaga links órfãos (de Customers que serão apagados)
    const customersGiga = await (this.prisma as any).customer.findMany({
      where: { originSource: { in: ['giga', 'giga_sistema'] } },
      select: { id: true },
    });
    const idsGiga = customersGiga.map((c: any) => c.id);

    const linksDel = await (this.prisma as any).customerGigaLink.deleteMany({
      where: { customerId: { in: idsGiga } },
    });

    // 2. Apaga Customers Giga (cascade limpa addresses, consents, tags...)
    const customersDel = await (this.prisma as any).customer.deleteMany({
      where: { originSource: { in: ['giga', 'giga_sistema'] } },
    });

    // 3. Limpa registroGiga residual de Customers que sobraram (WC etc)
    await (this.prisma as any).customer.updateMany({
      where: { registroGiga: { not: null } },
      data: { registroGiga: null },
    });

    this.logger.warn(
      `[giga-etl] RESET CLIENTES GIGA: ${customersDel.count} customers + ` +
      `${linksDel.count} links apagados. ${Date.now() - t0}ms`,
    );

    return {
      customersApagados: customersDel.count,
      linksApagados: linksDel.count,
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
        // PUXA TUDO (SELECT *) — guarda raw em gigaRawData JSON + popula
        // os campos detectados normalmente. Conta+nome são essenciais; resto
        // vai em raw mesmo que não esteja em cols.
        const [rows]: any = await pool.query(
          `SELECT * FROM clientes ORDER BY ${cols.codigo} LIMIT ? OFFSET ?`,
          [BATCH, offset],
        );
        // Normaliza pra os aliases que o resto do código espera
        for (const r of rows as any[]) {
          r.codCliente = r[cols.codigo];
          r.nome = r[cols.nome];
          r.cpf = cols.cpf ? r[cols.cpf] : null;
          r.foneCel = cols.foneCel ? r[cols.foneCel] : null;
          r.foneRes = cols.foneRes ? r[cols.foneRes] : null;
          r.email = cols.email ? r[cols.email] : null;
          r.nascimento = cols.nascimento ? r[cols.nascimento] : null;
          r.endereco = cols.endereco ? r[cols.endereco] : null;
          r.numero = cols.numero ? r[cols.numero] : null;
          r.complemento = cols.complemento ? r[cols.complemento] : null;
          r.bairro = cols.bairro ? r[cols.bairro] : null;
          r.cidade = cols.cidade ? r[cols.cidade] : null;
          r.uf = cols.uf ? r[cols.uf] : null;
          r.cep = cols.cep ? r[cols.cep] : null;
          r.loja = cols.loja ? r[cols.loja] : null;
          // Raw da linha inteira (todos os campos) — pra gravar no JSON
          r._raw = { ...r };
          delete r._raw.codCliente;
          delete r._raw.nome;
          delete r._raw.cpf;
          delete r._raw.foneCel;
          delete r._raw.foneRes;
          delete r._raw.email;
          delete r._raw.nascimento;
          delete r._raw.endereco;
          delete r._raw.numero;
          delete r._raw.complemento;
          delete r._raw.bairro;
          delete r._raw.cidade;
          delete r._raw.uf;
          delete r._raw.cep;
          delete r._raw.loja;
          delete r._raw._raw;
        }

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
    const gigaLoja = row.loja ? String(row.loja).trim().padStart(2, '0') : null;

    // CHAVE COMPOSTA: (loja, codigo). Sem loja não tem como rastrear — pula.
    if (!codCliente || !gigaLoja) {
      this.state.pulados++;
      return;
    }

    // 1. Tenta achar link existente pela chave composta (loja, codigo)
    const linkExistente = await (this.prisma as any).customerGigaLink.findUnique({
      where: { giga_loja_codigo_unique: { gigaLoja, gigaCodigo: codCliente } },
      include: { customer: true },
    });

    if (linkExistente) {
      // Link já existe → atualiza customer com merge não-destrutivo
      await this._aplicarMerge(linkExistente.customer, row);
      await (this.prisma as any).customerGigaLink.update({
        where: { id: linkExistente.id },
        data: { ultimoSync: new Date() },
      });
      this.state.atualizados++;
      return;
    }

    // 2. SEM dedup por CPF — cada (loja, codigo) vira UM Customer
    //    independente. Mesma pessoa cadastrada em N lojas físicas no Giga
    //    vai virar N Customers no FlowOps (regra de negócio aprovada por
    //    Thiago em jun/2026). Cada loja gerencia seu próprio cadastro.
    await this._criarNovoComLink(row, cpfDigits, codCliente, gigaLoja);
    this.state.criados++;
  }

  /**
   * MERGE NÃO-DESTRUTIVO: só preenche campos null/vazios.
   * Marketing/cashback/opt-in nunca são tocados.
   */
  private async _aplicarMerge(existing: any, row: any): Promise<void> {
    const updates: any = {};

    // registroGiga: NÃO toca mais aqui. A vinculação Giga ↔ Customer agora
    // vive na tabela customer_giga_links (chave composta loja+codigo).

    // Reclassifica cliente-sistema se aplicável (e ainda não foi marcado).
    if (existing.originSource === 'giga') {
      const nomeAtual = (existing.name || row.nome || '').toString().toUpperCase();
      if (this._ehClienteSistema(nomeAtual)) {
        updates.originSource = 'giga_sistema';
        updates.active = false;
      }
    }

    // originStoreId: só seta se ainda for null. NÃO sobrescreve loja já
    // gravada — quando o mesmo CPF aparece em múltiplas lojas Giga, a loja
    // origem é a do PRIMEIRO link (loja onde cadastrou primeiro). EXCEÇÃO:
    // clientes WC ficam loja 13 (SITE) intocada.
    if (!existing.originStoreId && existing.originSource !== 'woo') {
      const storeId = this._resolveStoreId(row.loja);
      if (storeId) updates.originStoreId = storeId;
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

    // WhatsApp: prefere FONECEL, fallback FONERES. Aceita >=8 dígitos
    // (Giga muitas vezes grava SEM DDD — ex: 996236888 = 9 dígitos).
    // Quando faltar DDD, infere pela UF da loja Giga depois (TODO).
    if (!existing.whatsapp) {
      const tel = String(row.foneCel || row.foneRes || '').replace(/\D/g, '');
      if (tel && tel.length >= 8) updates.whatsapp = tel;
    }

    // Telefone fixo separado se foneRes existe E é diferente do whatsapp
    if (!existing.phone && row.foneRes) {
      const tel = String(row.foneRes).replace(/\D/g, '');
      if (tel && tel.length >= 8) updates.phone = tel;
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

    // ─── CAMINHO C: enriquece com TODOS os campos Giga (antes do update único) ─
    const extras = this._extractGigaExtras(row);
    for (const key of Object.keys(extras) as string[]) {
      const v = extras[key];
      if (v === null || v === undefined) continue;
      // gigaRawData SEMPRE atualiza (snapshot do último sync)
      if (key === 'gigaRawData') {
        updates.gigaRawData = v;
        continue;
      }
      // booleanos giga: SEMPRE atualiza (status crediário muda no Giga)
      if (key === 'bloqueadoGiga' || key === 'negativadoGiga') {
        if (existing[key] !== v) updates[key] = v;
        continue;
      }
      // demais: só preenche se vazio
      if (existing[key] === null || existing[key] === undefined || existing[key] === '') {
        updates[key] = v;
      }
    }

    // personKey: só seta se ainda não tem (não muda quando já calculado)
    if (!existing.personKey) {
      const pk = this._computePersonKey({
        cpf: existing.cpf || row.cpf,
        email: existing.email || row.email,
        name: existing.name || row.nome,
        birthDate: existing.birthDate || this._parseDate(row.nascimento),
      });
      if (pk) updates.personKey = pk;
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
  private async _criarNovoComLink(
    row: any,
    cpfDigits: string,
    codCliente: number,
    gigaLoja: string,
  ): Promise<void> {
    const tel = String(row.foneCel || row.foneRes || '').replace(/\D/g, '');
    const telRes = String(row.foneRes || '').replace(/\D/g, '');
    const email = String(row.email || '').trim().toLowerCase();
    const birthDate = this._parseDate(row.nascimento);
    const originStoreId = this._resolveStoreId(row.loja);
    const nomeUpper = String(row.nome || '').trim().toUpperCase() || null;

    const isSistema = this._ehClienteSistema(nomeUpper);

    // Caminho C: extras Giga (15+ campos novos) + personKey
    const extras = this._extractGigaExtras(row);
    const personKey = this._computePersonKey({
      cpf: cpfDigits,
      email,
      name: nomeUpper,
      birthDate,
    });

    // Cria Customer + Link em transação atômica
    await (this.prisma as any).$transaction(async (tx: any) => {
      const customer = await tx.customer.create({
        data: {
          cpf: cpfDigits && cpfDigits.length === 11 ? this._formatCpf(cpfDigits) : null,
          name: nomeUpper,
          whatsapp: tel.length >= 8 ? tel : null,
          phone: telRes.length >= 8 && telRes !== tel ? telRes : null,
          email: email.includes('@') ? email : null,
          birthDate,
          originSource: isSistema ? 'giga_sistema' : 'giga',
          originStoreId,
          vipTier: 'bronze',
          active: !isSistema,
          personKey,
          ...extras,
        },
      });

      await tx.customerGigaLink.create({
        data: {
          customerId: customer.id,
          gigaLoja,
          gigaCodigo: codCliente,
        },
      });

      await this._criarEnderecoSeFaltarTx(tx, customer.id, row);
    });
  }

  /**
   * Cria CustomerAddress(type='residencial', isPrimary=true) se ainda não houver
   * endereço residencial pra esse cliente.
   */
  private async _criarEnderecoSeFaltar(customerId: string, row: any): Promise<void> {
    return this._criarEnderecoSeFaltarTx(this.prisma, customerId, row);
  }

  private async _criarEnderecoSeFaltarTx(tx: any, customerId: string, row: any): Promise<void> {
    if (!row.endereco && !row.cep) return; // sem endereço minimamente preenchido, pula

    const existing = await tx.customerAddress.findFirst({
      where: { customerId, type: 'residencial' },
    });
    if (existing) return;

    const cep = String(row.cep || '').replace(/\D/g, '');
    try {
      await tx.customerAddress.create({
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
          // Field é `cep` no schema CustomerAddress (não zipCode — bug
          // antigo silenciava P2002/Unknown field via catch).
          cep: cep.length === 8 ? cep : null,
        },
      });
    } catch (e: any) {
      // Loga ERRO (não warn) — falha de endereço é silenciosa há semanas
      this.logger.error(
        `[giga-etl] criar endereço falhou customer=${customerId} ` +
        `endereco="${row.endereco}" cep="${row.cep}": ${e?.code || ''} ${e?.message}`,
      );
    }
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
