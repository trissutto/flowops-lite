import { Injectable, Logger } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CobrancaContext, ParcelaCobranca, renderCobranca, TEMPLATES,
  DEFAULT_TEMPLATE_STRINGS,
} from './cobranca-templates';

const TEMPLATES_KEY = 'cobranca_templates';
const LOJA_NOME_KEY = 'cobranca_loja_nome';

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
    private readonly prisma: PrismaService,
  ) {}

  // =========== TEMPLATES EDITÁVEIS ===========

  /**
   * Lê os 6 templates configuráveis. Se não tiver salvo, retorna os defaults.
   * Cache em memória 30s pra evitar SELECT em cada disparo.
   */
  private templatesCache: { value: string[]; lojaNome: string; expiresAt: number } | null = null;

  async getEditableTemplates(force = false): Promise<{ templates: string[]; lojaNome: string; isDefault: boolean }> {
    if (!force && this.templatesCache && Date.now() < this.templatesCache.expiresAt) {
      return {
        templates: this.templatesCache.value,
        lojaNome: this.templatesCache.lojaNome,
        isDefault: false,
      };
    }
    let templates = [...DEFAULT_TEMPLATE_STRINGS];
    let lojaNome = `Lurd's Plus Size`;
    let isDefault = true;
    try {
      const rec = await (this.prisma as any).systemSetting.findUnique({ where: { key: TEMPLATES_KEY } });
      if (rec?.value) {
        const parsed = JSON.parse(rec.value);
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
          templates = parsed.filter((s: string) => s && s.trim().length > 0);
          isDefault = false;
        }
      }
      const recLoja = await (this.prisma as any).systemSetting.findUnique({ where: { key: LOJA_NOME_KEY } });
      if (recLoja?.value && typeof recLoja.value === 'string') {
        lojaNome = recLoja.value;
      }
    } catch (e: any) {
      this.logger.warn(`getEditableTemplates: usando defaults (${e?.message})`);
    }
    if (!templates.length) templates = [...DEFAULT_TEMPLATE_STRINGS];
    this.templatesCache = { value: templates, lojaNome, expiresAt: Date.now() + 30_000 };
    return { templates, lojaNome, isDefault };
  }

  async setEditableTemplates(templates: string[], lojaNome?: string): Promise<{ ok: boolean }> {
    const clean = (templates || [])
      .map((s) => String(s ?? '').trim())
      .filter((s) => s.length > 0);
    if (clean.length < 1) {
      throw new Error('Pelo menos 1 template precisa ter conteúdo');
    }
    if (clean.length > 12) {
      throw new Error('Máximo 12 templates');
    }
    await (this.prisma as any).systemSetting.upsert({
      where: { key: TEMPLATES_KEY },
      update: { value: JSON.stringify(clean) },
      create: { key: TEMPLATES_KEY, value: JSON.stringify(clean) },
    });
    if (typeof lojaNome === 'string' && lojaNome.trim().length > 0) {
      await (this.prisma as any).systemSetting.upsert({
        where: { key: LOJA_NOME_KEY },
        update: { value: lojaNome.trim() },
        create: { key: LOJA_NOME_KEY, value: lojaNome.trim() },
      });
    }
    this.templatesCache = null;
    return { ok: true };
  }

  async resetEditableTemplates(): Promise<{ ok: boolean }> {
    await (this.prisma as any).systemSetting.delete({ where: { key: TEMPLATES_KEY } }).catch(() => null);
    this.templatesCache = null;
    return { ok: true };
  }

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
      // Lurd's usa simplesmente "PAGAMENTO" (sem prefixo data_). MUITO CRÍTICO:
      // colocar /^pagamento$/i ANTES de /^pago$/i conflict — não, são regex
      // diferentes em campos diferentes (pago vs dataPagamento), sem conflito.
      dataPagamento:  pickColumn(cols, /^pagamento$/i, /^data_?pagamento$/i, /^dt_?pagto$/i, /^data_?pagto$/i, /^datapagto$/i, /^data_?baixa$/i, /^datapag$/i),
      valorPago:      pickColumn(cols, /^valor_?pago$/i, /^valorpago$/i, /^vlrpago$/i),
      pago:           pickColumn(cols,
        /^pago$/i, /^pg$/i, /^pago_?sn$/i, /^st_?pago$/i, /^stat_?pago$/i, /^status_?pago$/i,
        /^flag_?pago$/i, /^baixado$/i, /^baixa$/i, /^bx$/i, /^quitado$/i, /^liquidado$/i,
        /^pgto$/i, /^pgo$/i, /^paga$/i, /^pagto$/i, /^foi_?pago$/i, /^pago_?nao$/i,
        /^pg_?sn$/i, /^bxd$/i, /^marc(?:ado)?_?pago$/i,
      ),
      status:         pickColumn(cols, /^status$/i, /^situacao$/i),
      tipo:           pickColumn(cols, /^tipo$/i, /^tipo_?pagamento$/i, /^forma_?pagamento$/i),
      telefone:       pickColumn(cols, /^telefone$/i, /^fone$/i, /^celular$/i),
      juros:          pickColumn(cols, /^juros$/i, /^vlr_?juros$/i, /^valor_?juros$/i),
      multa:          pickColumn(cols, /^multa$/i, /^vlr_?multa$/i, /^valor_?multa$/i),
      // OBS — coluna de observação livre da promissória (recibo, lembrete, etc)
      obs:            pickColumn(cols,
        /^obs$/i, /^obs_?promiss?oria$/i, /^observacao$/i, /^observacoes$/i,
        /^observa(?:[çc][ãa]o)?$/i, /^historico$/i, /^memo$/i, /^nota$/i, /^notas$/i,
        /^complemento$/i, /^obs_?fin$/i, /^obs_?cred$/i, /^descricao$/i,
      ),
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
    let connectionError: any = null;
    for (const tbl of candidates) {
      try {
        const schema = await this.erp.getTableSchema(tbl, 1);
        if (!schema) continue;
        const cols = schema.columns.map((c) => c.field);
        const codCliente = pickColumn(cols, /^cod_?cliente$/i, /^codcli$/i, /^codigo$/i, /^id_?cliente$/i, /^id$/i);
        const nome = pickColumn(cols, /^nome$/i, /^nome_?cliente$/i, /^cliente$/i, /^razao_?social$/i);
        // PRINCIPAL → CELULAR. Lurd's usa FONECEL no Gigasistemas.
        const telefone = pickColumn(cols,
          /^fonecel$/i, /^fone_?cel$/i,             // ← Lurd's / Giga (PRIORIDADE)
          /^celular$/i, /^cel$/i, /^whatsapp$/i, /^wpp$/i,
          /^telefone$/i, /^tel$/i, /^fone$/i,
          /^telefone1$/i, /^tel1$/i, /^fone1$/i,
        );
        // FALLBACK → RESIDENCIAL. Lurd's usa FONERES.
        const telefone2 = pickColumn(cols,
          /^foneres$/i, /^fone_?res$/i,             // ← Lurd's / Giga (PRIORIDADE)
          /^telefone2$/i, /^tel2$/i, /^fone2$/i, /^celular2$/i, /^contato$/i,
        );
        // CPF — coluna pode variar muito no Giga.
        // Lurd's costuma usar CPF puro, mas alguns clones usam CPFCGC, CGCCPF, CPF_CNPJ.
        const cpf = pickColumn(cols,
          /^cpf$/i, /^cpf_?cnpj$/i, /^cnpj_?cpf$/i, /^cpfcgc$/i, /^cgccpf$/i,
          /^doc(?:umento)?$/i, /^num_?doc$/i,
        );
        const cidade = pickColumn(cols, /^cidade$/i, /^municipio$/i, /^localidade$/i);
        const endereco = pickColumn(cols, /^endereco$/i, /^logradouro$/i, /^rua$/i, /^endereço$/i);
        const bairro = pickColumn(cols, /^bairro$/i, /^distrito$/i);
        const cep = pickColumn(cols, /^cep$/i, /^codigo_?postal$/i);
        if (!codCliente) continue;
        const result: ClientesMap = {
          table: tbl, codCliente, nome, telefone, telefone2,
          cpf, cidade, endereco, bairro, cep,
        };
        this.clientesMapCache = result;
        this.logger.log(`detectClientesTable: ${JSON.stringify(result)}`);
        return result;
      } catch (e: any) {
        // Captura erro de CONEXAO (não de tabela inexistente). Códigos típicos
        // de problema de rede: EHOSTUNREACH, ETIMEDOUT, ECONNREFUSED, PROTOCOL_*.
        // Esses não significam que a tabela não existe — o MySQL tá fora do ar.
        const code = e?.code || e?.errno;
        const msg = String(e?.message || '');
        if (
          code === 'EHOSTUNREACH' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' ||
          code === 'ECONNRESET' || code === 'ENOTFOUND' ||
          msg.includes('Connection lost') || msg.includes('connect ETIMEDOUT')
        ) {
          connectionError = e;
          break; // não adianta tentar outras tabelas — é problema de rede
        }
        // tabela não existe — segue tentando próxima
      }
    }
    // Se foi erro de CONEXAO e já temos cache válido, usa o cache pra não quebrar UX.
    if (connectionError && this.clientesMapCache) {
      this.logger.warn(
        `detectClientesTable: Wincred indisponível (${connectionError.code || connectionError.message}) — usando cache em fallback`,
      );
      return this.clientesMapCache;
    }
    if (connectionError) {
      this.logger.error(
        `detectClientesTable: erro de conexão Wincred (${connectionError.code || connectionError.message}) e SEM cache — vai retornar null`,
      );
    } else {
      this.logger.warn('detectClientesTable: nenhuma tabela de clientes encontrada');
    }
    return null;
  }

  /**
   * Diagnóstico do universo de clientes do Giga: totais + cobertura de telefone.
   * Útil pra responder "286 sem telefone do total de quantos?".
   */
  async diagnoseClientesPhones(): Promise<{
    table: string | null;
    columnMap: any;
    total: number;
    comTelefonePrincipal: number;
    comTelefoneFallback: number;
    semNenhum: number;
    sample: any[];
  }> {
    const cm = await this.detectClientesTable(true);
    if (!cm) {
      return {
        table: null, columnMap: null, total: 0,
        comTelefonePrincipal: 0, comTelefoneFallback: 0, semNenhum: 0,
        sample: [],
      };
    }

    const tel1 = cm.telefone ? `\`${cm.telefone}\`` : null;
    const tel2 = cm.telefone2 ? `\`${cm.telefone2}\`` : null;

    // Conta total + cobertura
    const cond1 = tel1 ? `${tel1} IS NOT NULL AND TRIM(${tel1}) <> ''` : 'FALSE';
    const cond2 = tel2 ? `${tel2} IS NOT NULL AND TRIM(${tel2}) <> ''` : 'FALSE';
    const sql = `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${cond1} THEN 1 ELSE 0 END) AS comTel1,
        SUM(CASE WHEN ${cond2} THEN 1 ELSE 0 END) AS comTel2,
        SUM(CASE WHEN NOT (${cond1}) AND NOT (${cond2}) THEN 1 ELSE 0 END) AS semNenhum
      FROM \`${cm.table}\`
    `;

    let total = 0, comTel1 = 0, comTel2 = 0, semNenhum = 0;
    try {
      const r = await this.erp.runReadOnly(sql, { maxRows: 1, timeoutMs: 30000 });
      const row = r.rows[0] || {};
      total = Number(row.total ?? 0);
      comTel1 = Number(row.comTel1 ?? 0);
      comTel2 = Number(row.comTel2 ?? 0);
      semNenhum = Number(row.semNenhum ?? 0);
    } catch (e: any) {
      this.logger.warn(`diagnoseClientesPhones: count falhou: ${e?.message}`);
    }

    // Amostra de 5 clientes pra ver os dados (NOMES MASCARADOS, telefones FULL pra debug)
    const sampleCols: string[] = [];
    if (cm.codCliente) sampleCols.push(`\`${cm.codCliente}\` AS codCliente`);
    if (cm.nome) sampleCols.push(`\`${cm.nome}\` AS nome`);
    if (cm.telefone) sampleCols.push(`\`${cm.telefone}\` AS telefonePrincipal`);
    if (cm.telefone2) sampleCols.push(`\`${cm.telefone2}\` AS telefoneFallback`);
    let sample: any[] = [];
    try {
      const r = await this.erp.runReadOnly(
        `SELECT ${sampleCols.join(', ')} FROM \`${cm.table}\` LIMIT 5`,
        { maxRows: 5, timeoutMs: 10000 },
      );
      sample = r.rows;
    } catch (e: any) {
      this.logger.warn(`diagnoseClientesPhones: sample falhou: ${e?.message}`);
    }

    return {
      table: cm.table,
      columnMap: { codCliente: cm.codCliente, nome: cm.nome, telefonePrincipal: cm.telefone, telefoneFallback: cm.telefone2 },
      total,
      comTelefonePrincipal: comTel1,
      comTelefoneFallback: comTel2,
      semNenhum,
      sample,
    };
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
      const { normalizeBrPhone } = await import('../lib/phone-br');
      const result = await this.erp.runReadOnly(sql, { maxRows: ids.length + 100, timeoutMs: 20000 });
      for (const r of result.rows) {
        const id = String(r.codCliente);
        // Prefere telefone1 (FONECEL); se vazio, telefone2 (FONERES).
        // Normaliza pra formato BR — adiciona DDD 13 (Lurd's default) se faltar.
        const raw1 = String(r.telefone || '').trim();
        const raw2 = String(r.telefone2 || '').trim();
        const norm1 = normalizeBrPhone(raw1);
        const norm2 = normalizeBrPhone(raw2);
        const tel = norm1 || norm2 || null;
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
      where.push(`(\`${map.pago}\` IS NULL OR \`${map.pago}\` = '' OR UPPER(\`${map.pago}\`) IN ('N','NAO','NÃO'))`);
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
    const cfg = await this.getEditableTemplates();

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
        lojaNome: cfg.lojaNome,
      };
      const { text, templateIndex } = renderCobranca(ctx, seq, dayOffset, cfg.templates);

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

  /**
   * Envia 1 mensagem direto via Baileys (já conectado).
   * Usado pelos botões individuais "WA" da tela — em vez de abrir aba do
   * web.whatsapp.com (que exige login toda vez), reusa a sessão do backend.
   *
   * Aplica o testPhone se a env COBRANCA_TEST_PHONE estiver setada.
   */
  async sendOne(opts: {
    rawNumber: string;
    text: string;
  }): Promise<{ ok: boolean; testMode: boolean; usedNumber: string; error?: string }> {
    const status = this.wa.getStatus();
    if (!status.connected) {
      return { ok: false, testMode: false, usedNumber: '', error: 'WhatsApp desconectado. Conecte primeiro em /retaguarda/whatsapp.' };
    }
    const testPhone = (process.env.COBRANCA_TEST_PHONE || '').replace(/\D/g, '') || null;
    const usedNumber = testPhone || String(opts.rawNumber || '').replace(/\D/g, '');
    if (!usedNumber) {
      return { ok: false, testMode: !!testPhone, usedNumber: '', error: 'Número inválido' };
    }
    const r = await this.wa.sendText(usedNumber, opts.text);
    return { ok: r.ok, testMode: !!testPhone, usedNumber, error: r.error };
  }

  /**
   * Valida em lote se os números têm WhatsApp ativo. Retorna objeto serializável.
   */
  async validateNumbers(rawNumbers: string[]): Promise<{
    results: Record<string, { exists: boolean | null; jid?: string }>;
    summary: { total: number; ativos: number; inativos: number; erros: number };
    connected: boolean;
  }> {
    const status = this.wa.getStatus();
    const map = await this.wa.validateNumbers(rawNumbers || []);
    const results: Record<string, { exists: boolean | null; jid?: string }> = {};
    let ativos = 0, inativos = 0, erros = 0;
    for (const [k, v] of map.entries()) {
      results[k] = v;
      if (v.exists === true) ativos++;
      else if (v.exists === false) inativos++;
      else erros++;
    }
    return {
      results,
      summary: { total: map.size, ativos, inativos, erros },
      connected: status.connected,
    };
  }

  /** Lista os templates renderizados com dados-exemplo — pra preview no admin. */
  async previewTemplates(): Promise<Array<{ index: number; preview: string }>> {
    const cfg = await this.getEditableTemplates();
    const ctx: CobrancaContext = {
      nome: 'Maria Silva',
      lojaNome: cfg.lojaNome,
      parcelas: [
        { vencimento: '2026-04-10', valor: 89.90, parcela: 2, totalParcelas: 4 },
        { vencimento: '2026-04-25', valor: 89.90, parcela: 3, totalParcelas: 4 },
      ],
    };
    return cfg.templates.map((_, i) => {
      const { text } = renderCobranca(ctx, i, 0, cfg.templates);
      return { index: i, preview: text };
    });
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
  obs: string | null;
  juros: string | null;
  multa: string | null;
}

export interface ClientesMap {
  table: string;
  codCliente: string;
  nome: string | null;
  telefone: string | null;
  telefone2: string | null;
  cpf: string | null;       // ← coluna do CPF (varia: CPF, cpf, CPFCGC, CPF_CNPJ…)
  cidade: string | null;    // ← coluna da cidade (CIDADE, cidade, MUNICIPIO…)
  endereco: string | null;
  bairro: string | null;
  cep: string | null;
}

const EMPTY_MAP: ColumnMap = {
  registro: null, controle: null, numeroCompra: null, loja: null,
  codCliente: null, nome: null, dataCompra: null, valorCompra: null,
  parcela: null, totalParcelas: null, vencimento: null, valorParcela: null,
  dataPagamento: null, valorPago: null, pago: null, status: null, tipo: null, telefone: null,
  obs: null, juros: null, multa: null,
};

function pickColumn(cols: string[], ...patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const found = cols.find((c) => re.test(c));
    if (found) return found;
  }
  return null;
}
