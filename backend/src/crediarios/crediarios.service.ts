import { Injectable, Logger } from '@nestjs/common';
import { ErpService } from '../erp/erp.service';

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
 */
@Injectable()
export class CrediariosService {
  private readonly logger = new Logger(CrediariosService.name);
  private columnMapCache: ColumnMap | null = null;

  constructor(private readonly erp: ErpService) {}

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
      status:         pickColumn(cols, /^status$/i, /^situacao$/i, /^pago$/i, /^baixado$/i),
      tipo:           pickColumn(cols, /^tipo$/i, /^tipo_?pagamento$/i, /^forma_?pagamento$/i),
      telefone:       pickColumn(cols, /^telefone$/i, /^fone$/i, /^celular$/i),
    };
    this.columnMapCache = map;
    this.logger.log(`detectColumns mapeamento: ${JSON.stringify(map)}`);
    return map;
  }

  /**
   * Lista parcelas VENCIDAS e NÃO PAGAS de uma loja, ordenadas por
   * cliente + vencimento. Cada linha = 1 parcela.
   *
   * Vencida: VENCIMENTO < hoje
   * Não paga: DATA_PAGAMENTO IS NULL OR DATA_PAGAMENTO = '0000-00-00'
   *           (Giga frequentemente usa 0000-00-00 como "não pago")
   */
  async listOverdue(opts: {
    storeCode: string;
    daysBack?: number; // limite máximo no passado (default 365 — pra não pegar "lixo" de 2010)
    limit?: number;    // default 5000
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
    addCol('status', 'status');

    // WHERE
    const where: string[] = [];
    where.push(`\`${map.loja}\` = '${safeStore}'`);
    where.push(`\`${map.vencimento}\` < CURDATE()`);
    where.push(`\`${map.vencimento}\` >= DATE_SUB(CURDATE(), INTERVAL ${daysBack} DAY)`);
    if (map.dataPagamento) {
      // não pago = NULL ou 0000-00-00 (Giga zero-date)
      where.push(`(\`${map.dataPagamento}\` IS NULL OR \`${map.dataPagamento}\` = '0000-00-00' OR \`${map.dataPagamento}\` = '0000-00-00 00:00:00')`);
    }

    const orderBy = `\`${map.codCliente}\` ASC, \`${map.vencimento}\` ASC`;
    const sql = `SELECT ${select.join(', ')} FROM \`movimento\` WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ${limit}`;

    const result = await this.erp.runReadOnly(sql, { maxRows: limit, timeoutMs: 30000 });

    // Sumário
    const totalDevido = result.rows.reduce((sum: number, r: any) => {
      const v = Number(r.valorParcela ?? 0);
      const pago = Number(r.valorPago ?? 0);
      return sum + Math.max(0, v - pago);
    }, 0);
    const clientes = new Set(result.rows.map((r: any) => String(r.codCliente))).size;

    return {
      columnMap: map,
      rows: result.rows,
      summary: {
        totalParcelas: result.rows.length,
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
  async listOverdueByCustomer(opts: { storeCode: string; daysBack?: number }): Promise<{
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
      g.parcelas.push(r);
    }

    const today = new Date();
    const customers = Array.from(grouped.values()).map((c) => {
      const oldest = c.vencimentoMaisAntigo ? new Date(c.vencimentoMaisAntigo) : null;
      const dias = oldest ? Math.floor((today.getTime() - oldest.getTime()) / 86400000) : 0;
      return { ...c, diasAtraso: dias };
    });
    // Ordena por totalDevido DESC (quem deve mais primeiro)
    customers.sort((a, b) => b.totalDevido - a.totalDevido);

    return {
      customers,
      summary: {
        totalClientes: customers.length,
        totalParcelas: overdue.summary.totalParcelas,
        totalDevido: overdue.summary.totalDevido,
      },
      columnMap: overdue.columnMap,
    };
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
  status: string | null;
  tipo: string | null;
  telefone: string | null;
}

const EMPTY_MAP: ColumnMap = {
  registro: null, controle: null, numeroCompra: null, loja: null,
  codCliente: null, nome: null, dataCompra: null, valorCompra: null,
  parcela: null, totalParcelas: null, vencimento: null, valorParcela: null,
  dataPagamento: null, valorPago: null, status: null, tipo: null, telefone: null,
};

function pickColumn(cols: string[], ...patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const found = cols.find((c) => re.test(c));
    if (found) return found;
  }
  return null;
}
