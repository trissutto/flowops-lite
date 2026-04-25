import { Injectable, Logger } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  CobrancaContext, ParcelaCobranca, renderCobranca, TEMPLATES,
} from './cobranca-templates';

/**
 * CrediariosService — cobrança de parcelas vencidas direto da tabela
 * `movimento` do MySQL Gigasistemas.
 *
 * A tabela `movimento` no Giga (700k+ linhas) é o "razão" do crediário:
 * cada linha é UMA parcela de uma compra. Os nomes das colunas variam
 * entre instalações antigas do Gigasistemas (nem sempre tem padrão ANSI),
 * então o módulo usa AUTODETECÇÃO via SHOW COLUMNS + heurística por regex.
 *
 * Padrão típico (confirmado pelo print do Thiago):
 *   REGISTRO       PK
 *   CONTROLE       ID da parcela (sequencial)
 *   NUMEROCOMPRA   ID da compra (mesmo pra todas as parcelas dela)
 *   LOJA           '01'..'20'
 *   CODCLIENTE
 *   NOME           desnormalizado pra cobrança rápida
 *   DATACOMPRA
 *   VALORCOMPRA    (truncado VALORCON no print — checar)
 *   ...mais 16 colunas: PARCELA / VENCIMENTO / VALOR_PARCELA /
 *      DATA_PAGAMENTO / etc.
 *
 * Pra puxar TELEFONE do cliente também detectamos a tabela `clientes`
 * (ou `cadcli`) e cacheamos o mapping de colunas dela.
 */
@Injectable()
export class CrediariosService {
  private readonly logger = new Logger(CrediariosService.name);
  private columnMapCache: ColumnMap | null = null;
  private clientesMapCache: ClientesMap | null = null;

  constructor(
    private readonly erp: ErpService,
    private readonly wa: WhatsappService,
  ) {}

  /**
   * Lê SHOW COLUMNS FROM movimento e tenta mapear nomes da instalação local
   * pros nossos nomes lógicos (parcela, vencimento, valorParcela, etc).
   * Cache em memória: detecção é feita 1x por boot.
   */
  async detectColumns(force = false): Promise<ColumnMap> {
    if (this.columnMapCache && !force) return this.columnMapCache;

    const schema = await this.erp.getTableSchema('movimento', 1);
    if (!schema) {
      this.logger.error('detectColumns: tabela movimento não encontrada');
      return EMPTY_MAP;
    }
    const cols = schema.columns.map((c) => c.field);
    const map: ColumnMap = {
      registro:       pickColumn(cols, /^registro$/i, /^id$/i),
      controle:       pickColumn(cols, /^controle$/i),
      numeroCompra:   pickColumn(cols, /^numero?_?compra$/i, /^num_?venda$/i),
      loja:           pickColumn(cols, /^loja$/i, /^codloja$/i, /^cod_?loja$/i),
      codCliente:     pickColumn(cols, /^cod_?cliente$/i, /^codcli$/i, /^idcliente$/i),
      nome:           pickColumn(cols, /^nome$/i, /^nome_?cliente$/i, /^cliente$/i),
      dataCompra:     pickColumn(cols, /^data_?compra$/i, /^dt_?compra$/i, /^data$/i),
      valorCompra:    pickColumn(cols, /^valor_?compra$/i, /^valorcon$/i, /^valor_?con$/i, /^total_?compra$/i, /^vlr_?compra$/i),
      parcela:        pickColumn(cols, /^parcela$/i, /^num_?parcela$/i, /^numparcela$/i, /^parc(?:ela)?$/i),
      totalParcelas:  pickColumn(cols, /^qtd_?parcelas?$/i, /^total_?parcelas?$/i, /^numparcelas$/i, /^np$/i),
      vencimento:     pickColumn(cols, /^vencimento$/i, /^data_?vencimento$/i, /^dt_?venc$/i, /^vencto$/i, /^venc$/i),
      valorParcela:   pickColumn(cols, /^valor_?parcela$/i, /^valor_?parc$/i, /^vlrparc$/i, /^valor$/i),
      dataPagamento:  pickColumn(cols, /^data_?pagamento$/i, /^dt_?pagto$/i, /^data_?pagto$/i, /^datapagto$/i, /^data_?baixa$/i, /^datapag$/i),
      valorPago:      pickColumn(cols, /^valor_?pago$/i, /^valorpago$/i, /^vlrpago$/i),
      pago:           pickColumn(cols,
        /^pago$/i, /^pg$/i, /^pago_?sn$/i, /^st_?pago$/i, /^stat_?pago$/i, /^status_?pago$/i,
        /^flag_?pago$/i, /^baixado$/i, /^baixa$/i, /^bx$/i, /^quitado$/i, /^liquidado$/i,
        /^pgto$/i, /^pgo$/i, /^paga$/i,
      ),
      status:         pickColumn(cols, /^status$/i, /^situacao$/i),
      tipo:           pickColumn(cols, /^tipo$/i, /^tipo_?pagamento$/i, /^forma_?pagamento$/i),
      telefone:       pickColumn(cols, /^telefone$/i, /^fone$/i, /^celular$/i),
    };
    this.columnMapCache = map;
    this.logger.log(`detectColumns mapeamento: ${JSON.stringify(map)}`);
    return map;
  }

  /**
   * Tenta detectar a tabela de clientes do Giga (`clientes` ou `cadcli`)
   * e mapear códigos+nome+telefone. Cache em memória.
   *
   * Retorna null se não conseguir detectar — nesse caso `enrichWithPhone`
   * vira no-op.
   */
  async detectClientesTable(force = false): Promise<ClientesMap | null> {
    if (this.clientesMapCache && !force) return this.clientesMapCache;

    const candidates = ['clientes', 'cliente', 'cadcli', 'cadcliente', 'cadclientes'];
    for (const tbl of candidates) {
      try {
        const schema = await this.erp.getTableSchema(tbl, 1);
        if (!schema) continue;
        const cols = schema.columns.map((c) => c.field);
        const codCliente = pickColumn(cols, /^cod_?cliente$/i, /^codcli$/i, /^codigo$/i, /^id_?cliente$/i, /^id$/i);
        const nome = pickColumn(cols, /^nome$/i, /^nome_?cliente$/i, /^cliente$/i, /^razao_?social$/i);
        const telefone = pickColumn(cols,
          /^celular$/i, /^cel$/i, /^whatsapp$/i, /^wpp$/i,
          /^telefone$/i, /^tel$/i, /^fone$/i,
          /^telefone1$/i, /^tel1$/i, /^fone1$/i,
        );
        const telefone2 = pickColumn(cols,
          /^telefone2$/i, /^tel2$/i, /^fone2$/i, /^celular2$/i, /^contato$/i,
        );
        if (!codCliente) continue;
        const result: ClientesMap = { table: tbl, codCliente, nome, telefone, telefone2 };
        this.clientesMapCache = result;
        this.logger.log(`detectClientesTable: ${JSON.stringify(result)}`);
        return result;
      } catch (e: any) {
        // tabela não existe — segue
      }
    }
    this.logger.warn('detectClientesTable: nenhuma tabela de clientes encontrada');
    return null;
  }

  /**
   * Pra cada codCliente recebido, busca telefone na tabela detectada.
   * Retorna Map<codCliente, { telefone, nome }>.
   */
  async fetchPhonesByClienteIds(codClientes: string[]): Promise<Map<string, { telefone: string | null; nome: string | null }>> {
    const out = new Map<string, { telefone: string | null; nome: string | null }>();
    if (codClientes.length === 0) return out;

    const cm = await this.detectClientesTable();
    if (!cm || !cm.telefone) return out;

    // Sanitiza ids
    const ids = Array.from(new Set(codClientes.map((c) => String(c).replace(/['"\\]/g, '')))).filter(Boolean);
    if (ids.length === 0) return out;

    const inList = ids.map((i) => `'${i}'`).join(',');
    const cols: string[] = [`\`${cm.codCliente}\` AS codCliente`];
    if (cm.nome) cols.push(`\`${cm.nome}\` AS nome`);
    if (cm.telefone) cols.push(`\`${cm.telefone}\` AS telefone`);
    if (cm.telefone2) cols.push(`\`${cm.telefone2}\` AS telefone2`);
    const sql = `SELECT ${cols.join(', ')} FROM \`${cm.table}\` WHERE \`${cm.codCliente}\` IN (${inList}) LIMIT ${ids.length + 100}`;

    try {
      const result = await this.erp.runReadOnly(sql, { maxRows: ids.length + 100, timeoutMs: 20000 });
      for (const r of result.rows) {
        const id = String(r.codCliente);
        // Prefere telefone1; se vazio, telefone2
        const tel = (String(r.telefone || '').trim()) || (String(r.telefone2 || '').trim()) || null;
        out.set(id, { telefone: tel, nome: r.nome ? String(r.nome) : null });
      }
    } catch (e: any) {
      this.logger.error(`fetchPhonesByClienteIds falhou: ${e?.message}`);
    }
    return out;
  }

  /**
   * Lista parcelas VENCIDAS e NÃO PAGAS de uma loja, ordenadas por
   * VENCIMENTO ASC (mais antigo primeiro — fila de cobrança real).
   *
   * Vencida: VENCIMENTO < hoje
   * Não paga: PAGO = 'N' (preferencial — confirmado pelo Thiago)
   *           Fallback: DATA_PAGAMENTO IS NULL OR = '0000-00-00'
   *
   * Filtros opcionais:
   *   - daysBack:    janela máxima no passado (default 365)
   *   - dataInicio:  filtro >= (formato YYYY-MM-DD)
   *   - dataFim:     filtro <= (formato YYYY-MM-DD)
   *   - limit:       teto de linhas (default 5000)
   */
  async listOverdue(opts: {
    storeCode: string;
    daysBack?: number;
    dataInicio?: string;
    dataFim?: string;
    limit?: number;
    orderBy?: 'vencimento' | 'cliente';
  }): Promise<{
    columnMap: ColumnMap;
    rows: any[];
    summary: { totalParcelas: number; totalDevido: number; clientes: number };
    rawSql: string;
  }> {
    const map = await this.detectColumns();
    if (!map.vencimento || !map.codCliente || !map.loja) {
      throw new Error(
        `Colunas essenciais não detectadas em "movimento". Faltando: ${
          [!map.vencimento && 'vencimento', !map.codCliente && 'codCliente', !map.loja && 'loja']
            .filter(Boolean).join(', ')
        }`,
      );
    }

    const daysBack = Math.max(1, Math.min(3650, opts.daysBack ?? 365));
    const limit = Math.max(1, Math.min(50000, opts.limit ?? 5000));
    const safeStore = String(opts.storeCode || '').replace(/[^0-9]/g, '').padStart(2, '0').slice(0, 2);
    const safeDate = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
    const dataInicio = safeDate(opts.dataInicio);
    const dataFim = safeDate(opts.dataFim);

    // Monta SELECT só com as colunas detectadas
    const select: string[] = [];
    const aliasMap: Record<string, string> = {};
    const addCol = (logical: keyof ColumnMap, alias: string) => {
      const col = map[logical];
      if (!col) return;
      select.push(`\`${col}\` AS ${alias}`);
      aliasMap[alias] = col;
    };
    addCol('registro', 'registro');
    addCol('controle', 'controle');
    addCol('numeroCompra', 'numeroCompra');
    addCol('codCliente', 'codCliente');
    addCol('nome', 'nome');
    addCol('telefone', 'telefone');
    addCol('dataCompra', 'dataCompra');
    addCol('valorCompra', 'valorCompra');
    addCol('parcela', 'parcela');
    addCol('totalParcelas', 'totalParcelas');
    addCol('vencimento', 'vencimento');
    addCol('valorParcela', 'valorParcela');
    addCol('dataPagamento', 'dataPagamento');
    addCol('valorPago', 'valorPago');
    addCol('pago', 'pago');
    addCol('status', 'status');

    // WHERE
    const where: string[] = [];
    where.push(`\`${map.loja}\` = '${safeStore}'`);
    where.push(`\`${map.vencimento}\` < CURDATE()`);
    // Janela máxima (daysBack) — só aplica se NÃO tiver dataInicio explícito
    if (!dataInicio) {
      where.push(`\`${map.vencimento}\` >= DATE_SUB(CURDATE(), INTERVAL ${daysBack} DAY)`);
    }
    if (dataInicio) where.push(`\`${map.vencimento}\` >= '${dataInicio}'`);
    if (dataFim)    where.push(`\`${map.vencimento}\` <= '${dataFim}'`);
    if (map.pago) {
      where.push(`(\`${map.pago}\` = 'N' OR \`${map.pago}\` = 'n')`);
    } else if (map.dataPagamento) {
      where.push(`(\`${map.dataPagamento}\` IS NULL OR \`${map.dataPagamento}\` = '0000-00-00' OR \`${map.dataPagamento}\` = '0000-00-00 00:00:00')`);
    }
    // Excluir cliente 0 (cartão / avulso / VISANET / CREDICARD / REDESHOP)
    where.push(`\`${map.codCliente}\` IS NOT NULL`);
    where.push(`\`${map.codCliente}\` <> 0`);
    where.push(`\`${map.codCliente}\` <> '0'`);
    where.push(`\`${map.codCliente}\` <> ''`);

    const orderBy = opts.orderBy === 'cliente'
      ? `\`${map.codCliente}\` ASC, \`${map.vencimento}\` ASC`
      : `\`${map.vencimento}\` ASC, \`${map.codCliente}\` ASC`;
    const sql = `SELECT ${select.join(', ')} FROM \`movimento\` WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ${limit}`;

    const result = await this.erp.runReadOnly(sql, { maxRows: limit, timeoutMs: 30000 });

    // Enriquecimento de telefone via tabela `clientes` (se detectada)
    let rows: any[] = result.rows;
    try {
      const ids = Array.from(new Set(rows.map((r) => String(r.codCliente)).filter(Boolean)));
      if (ids.length > 0) {
        const phones = await this.fetchPhonesByClienteIds(ids);
        rows = rows.map((r) => {
          const cli = phones.get(String(r.codCliente));
          if (!cli) return r;
          return {
            ...r,
            // Prioridade: telefone do cadastro > o que veio da movimento
            telefone: cli.telefone ?? r.telefone ?? null,
            nome: r.nome || cli.nome || '',
          };
        });
      }
    } catch (e: any) {
      this.logger.warn(`Enrichment de telefone falhou: ${e?.message}`);
    }

    // Sumário
    const totalDevido = rows.reduce((sum: number, r: any) => {
      const v = Number(r.valorParcela ?? 0);
      const pago = Number(r.valorPago ?? 0);
      return sum + Math.max(0, v - pago);
    }, 0);
    const clientes = new Set(rows.map((r: any) => String(r.codCliente))).size;

    return {
      columnMap: map,
      rows,
      summary: {
        totalParcelas: rows.length,
        totalDevido,
        clientes,
      },
      rawSql: sql,
    };
  }

  /**
   * Agrupa por cliente — pra tela inicial de cobrança ("quem deve quanto").
   * Reusa listOverdue e agrupa em memória (mais simples que GROUP BY no SQL).
   */
  async listOverdueByCustomer(opts: {
    storeCode: string;
    daysBack?: number;
    dataInicio?: string;
    dataFim?: string;
  }): Promise<{
    customers: Array<{
      codCliente: string;
      nome: string;
      telefone: string | null;
      parcelasVencidas: number;
      totalDevido: number;
      vencimentoMaisAntigo: string | null;
      vencimentoMaisRecente: string | null;
      diasAtraso: number;
      parcelas: any[];
    }>;
    summary: { totalClientes: number; totalParcelas: number; totalDevido: number };
    columnMap: ColumnMap;
    rawSql: string;
  }> {
    const overdue = await this.listOverdue({ ...opts, limit: 50000 });
    const grouped = new Map<string, any>();

    for (const r of overdue.rows) {
      const key = String(r.codCliente ?? 'sem-codigo');
      if (!grouped.has(key)) {
        grouped.set(key, {
          codCliente: key,
          nome: String(r.nome ?? ''),
          telefone: r.telefone ?? null,
          parcelasVencidas: 0,
          totalDevido: 0,
          vencimentoMaisAntigo: null as string | null,
          vencimentoMaisRecente: null as string | null,
          parcelas: [] as any[],
        });
      }
      const g = grouped.get(key);
      g.parcelasVencidas += 1;
      g.totalDevido += Math.max(0, Number(r.valorParcela ?? 0) - Number(r.valorPago ?? 0));
      const venc = r.vencimento ? String(r.vencimento) : null;
      if (venc) {
        if (!g.vencimentoMaisAntigo || venc < g.vencimentoMaisAntigo) g.vencimentoMaisAntigo = venc;
        if (!g.vencimentoMaisRecente || venc > g.vencimentoMaisRecente) g.vencimentoMaisRecente = venc;
      }
      // Telefone: pega o primeiro não-nulo (movimento já enriqueceu via clientes)
      if (!g.telefone && r.telefone) g.telefone = r.telefone;
      g.parcelas.push(r);
    }

    const today = new Date();
    const customers = Array.from(grouped.values()).map((c) => {
      const oldest = c.vencimentoMaisAntigo ? new Date(c.vencimentoMaisAntigo) : null;
      const dias = oldest ? Math.floor((today.getTime() - oldest.getTime()) / 86400000) : 0;
      return { ...c, diasAtraso: dias };
    });
    customers.sort((a, b) => b.totalDevido - a.totalDevido);

    return {
      customers,
      summary: {
        totalClientes: customers.length,
        totalParcelas: overdue.summary.totalParcelas,
        totalDevido: overdue.summary.totalDevido,
      },
      columnMap: overdue.columnMap,
      rawSql: overdue.rawSql,
    };
  }

  // =========== CAMPANHA WHATSAPP ===========

  /**
   * Monta a fila de mensagens de cobrança a partir das parcelas vencidas.
   * NÃO envia — só prepara. O frontend usa pra preview.
   *
   * Regras:
   *   - Pula clientes sem telefone (não dá pra mandar)
   *   - Pula parcelas com menos de minDiasAtraso (default 3)
   *   - Agrupa todas parcelas do mesmo cliente em UMA mensagem (lista empilhada)
   *   - Rotaciona templates por seq do cliente (anti-ban)
   *   - Aplica testPhone do env COBRANCA_TEST_PHONE — sobrescreve número real
   */
  async buildCampanhaQueue(opts: {
    storeCode: string;
    dataInicio?: string;
    dataFim?: string;
    daysBack?: number;
    minDiasAtraso?: number;
    dayOffset?: number;
  }): Promise<{
    queue: Array<{
      codCliente: string;
      nome: string;
      telefoneOriginal: string | null;
      telefone: string;       // o que vai realmente ser usado (testPhone se ativo)
      diasAtraso: number;
      parcelasVencidas: number;
      totalDevido: number;
      mensagem: string;
      templateIndex: number;
    }>;
    skipped: Array<{ codCliente: string; nome: string; motivo: string }>;
    testMode: boolean;
    testPhone: string | null;
    summary: { totalClientes: number; totalMensagens: number; totalDevido: number };
  }> {
    const minDiasAtraso = Math.max(0, Math.min(365, opts.minDiasAtraso ?? 3));
    const dayOffset = Math.max(0, Math.min(30, opts.dayOffset ?? 0));
    const data = await this.listOverdueByCustomer(opts);

    const testPhone = (process.env.COBRANCA_TEST_PHONE || '').replace(/\D/g, '') || null;
    const testMode = !!testPhone;

    const queue: Array<any> = [];
    const skipped: Array<{ codCliente: string; nome: string; motivo: string }> = [];

    let seq = 0;
    for (const c of data.customers) {
      // Filtra: só parcelas com diasAtraso >= minDiasAtraso
      // (diasAtraso é do cliente — se a parcela MAIS ANTIGA dele tem >= 3 dias, manda)
      if (c.diasAtraso < minDiasAtraso) {
        skipped.push({ codCliente: c.codCliente, nome: c.nome, motivo: `Atraso < ${minDiasAtraso} dias (${c.diasAtraso}d)` });
        continue;
      }

      const tel = c.telefone ? String(c.telefone).replace(/\D/g, '') : '';
      if (!tel && !testMode) {
        skipped.push({ codCliente: c.codCliente, nome: c.nome, motivo: 'Sem telefone cadastrado' });
        continue;
      }

      // Renderiza mensagem
      const parcelas: ParcelaCobranca[] = c.parcelas.map((p: any) => ({
        vencimento: String(p.vencimento || '').slice(0, 10),
        valor: Math.max(0, Number(p.valorParcela ?? 0) - Number(p.valorPago ?? 0)),
        parcela: p.parcela ? Number(p.parcela) : undefined,
        totalParcelas: p.totalParcelas ? Number(p.totalParcelas) : undefined,
      }));

      const ctx: CobrancaContext = {
        nome: c.nome,
        parcelas,
        lojaNome: `Lurd's Plus Size`,
      };
      const { text, templateIndex } = renderCobranca(ctx, seq, dayOffset);

      queue.push({
        codCliente: c.codCliente,
        nome: c.nome,
        telefoneOriginal: c.telefone,
        telefone: testMode ? testPhone! : tel,
        diasAtraso: c.diasAtraso,
        parcelasVencidas: c.parcelasVencidas,
        totalDevido: c.totalDevido,
        mensagem: text,
        templateIndex,
      });
      seq++;
    }

    return {
      queue,
      skipped,
      testMode,
      testPhone,
      summary: {
        totalClientes: queue.length,
        totalMensagens: queue.length, // 1 por cliente (parcelas empilhadas)
        totalDevido: queue.reduce((s, q) => s + q.totalDevido, 0),
      },
    };
  }

  /**
   * Dispara a campanha em sequência via WhatsappService.
   * Delay padrão 120000ms (2 min) entre mensagens — anti-ban.
   *
   * Roda SÍNCRONO (await) — o frontend deve mostrar progresso ou usar pollingstatus.
   * Pra campanhas grandes (>50 clientes), roda em background e o frontend
   * faz polling em /crediarios/cobranca/status (não implementado nesta fase).
   */
  async dispararCampanha(opts: {
    storeCode: string;
    dataInicio?: string;
    dataFim?: string;
    daysBack?: number;
    minDiasAtraso?: number;
    dayOffset?: number;
    delayMs?: number;
    dryRun?: boolean; // se true, não envia (só monta queue)
  }): Promise<{
    total: number;
    sent: number;
    failed: Array<{ codCliente: string; nome: string; telefone: string; error: string }>;
    testMode: boolean;
    durationMs: number;
  }> {
    const t0 = Date.now();
    const delayMs = Math.max(60_000, Math.min(600_000, opts.delayMs ?? 120_000));
    const built = await this.buildCampanhaQueue(opts);

    if (opts.dryRun) {
      this.logger.log(`[DRY-RUN] Campanha ${built.queue.length} mensagens (test=${built.testMode})`);
      return { total: built.queue.length, sent: 0, failed: [], testMode: built.testMode, durationMs: Date.now() - t0 };
    }

    // Verifica WhatsApp conectado
    const status = this.wa.getStatus();
    if (!status.connected) {
      throw new Error('WhatsApp desconectado. Conecte primeiro em /retaguarda/whatsapp.');
    }

    const items = built.queue.map((q) => ({
      number: q.telefone,
      text: q.mensagem,
      tag: q.codCliente,
    }));

    this.logger.log(
      `Disparando campanha de cobrança: ${items.length} clientes, delay ${delayMs}ms (test=${built.testMode}, phone=${built.testPhone || 'real'})`,
    );

    const result = await this.wa.sendBulk(items, { delayMs });

    const failed = result.failed.map((f) => {
      const original = built.queue.find((q) => q.codCliente === f.tag);
      return {
        codCliente: f.tag || '',
        nome: original?.nome || '',
        telefone: f.number,
        error: f.error,
      };
    });

    return {
      total: result.total,
      sent: result.sent,
      failed,
      testMode: built.testMode,
      durationMs: Date.now() - t0,
    };
  }

  /**
   * Diagnóstico: retorna SCHEMA bruto + 2 linhas reais (mascarando nomes)
   * pra Thiago identificar visualmente qual coluna é PAGO/baixa e me passar.
   */
  async diagnoseRawColumns(): Promise<{
    columns: { field: string; type: string; null: string; default: any }[];
    sample: any[];
    pagoCandidates: string[];
    detected: ColumnMap;
    clientesTable: ClientesMap | null;
  }> {
    const schema = await this.erp.getTableSchema('movimento', 1);
    if (!schema) throw new Error('Tabela `movimento` não encontrada');
    const columns = schema.columns.map((c: any) => ({
      field: c.field, type: c.type, null: c.null, default: c.default ?? null,
    }));
    const sampleSql = 'SELECT * FROM `movimento` LIMIT 5';
    const sampleResult = await this.erp.runReadOnly(sampleSql, { maxRows: 5, timeoutMs: 10000 });

    const pagoCandidates = columns
      .filter((c) => /pag|pg|baix|liq|quit|status|sit/i.test(c.field))
      .map((c) => `${c.field} (${c.type})`);

    const detected = await this.detectColumns(true);
    const clientesTable = await this.detectClientesTable(true);
    return { columns, sample: sampleResult.rows, pagoCandidates, detected, clientesTable };
  }

  /** Lista os templates renderizados com dados-exemplo — pra preview no admin. */
  previewTemplates(): Array<{ index: number; preview: string }> {
    const ctx: CobrancaContext = {
      nome: 'Maria Silva',
      lojaNome: `Lurd's Plus Size`,
      parcelas: [
        { vencimento: '2026-04-10', valor: 89.90, parcela: 2, totalParcelas: 4 },
        { vencimento: '2026-04-25', valor: 89.90, parcela: 3, totalParcelas: 4 },
      ],
    };
    return TEMPLATES.map((t, i) => ({ index: i, preview: t(ctx) }));
  }
}

// ----------- types & helpers -----------

export interface ColumnMap {
  registro: string | null;
  controle: string | null;
  numeroCompra: string | null;
  loja: string | null;
  codCliente: string | null;
  nome: string | null;
  dataCompra: string | null;
  valorCompra: string | null;
  parcela: string | null;
  totalParcelas: string | null;
  vencimento: string | null;
  valorParcela: string | null;
  dataPagamento: string | null;
  valorPago: string | null;
  pago: string | null;
  status: string | null;
  tipo: string | null;
  telefone: string | null;
}

export interface ClientesMap {
  table: string;
  codCliente: string;
  nome: string | null;
  telefone: string | null;
  telefone2: string | null;
}

const EMPTY_MAP: ColumnMap = {
  registro: null, controle: null, numeroCompra: null, loja: null,
  codCliente: null, nome: null, dataCompra: null, valorCompra: null,
  parcela: null, totalParcelas: null, vencimento: null, valorParcela: null,
  dataPagamento: null, valorPago: null, pago: null, status: null, tipo: null, telefone: null,
};

function pickColumn(cols: string[], ...patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const found = cols.find((c) => re.test(c));
    if (found) return found;
  }
  return null;
}
