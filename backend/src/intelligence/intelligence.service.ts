import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * IntelligenceService — junta dados Giga (estoque + venda) com Postgres
 * (remessas) pra montar o dashboard /retaguarda/inteligencia-estoque.
 *
 * Design: 1 endpoint principal (overview) que faz N queries em paralelo
 * pra montar a tabela "1 linha por loja". Endpoints auxiliares pra drill-down
 * (top vendas, rupturas, parados, heatmap) por loja específica.
 *
 * Performance: cada chamada de overview faz ~3 queries Giga (estoque, vendas
 * peças+valor, top sellers global) + 2 queries Postgres (remessas in/out).
 * Tudo em paralelo via Promise.all. Pra ~15 lojas + 30d janela, fica < 2s.
 */
@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /**
   * Parser de janela de datas (YYYY-MM-DD) com defaults seguros.
   * Default: últimos 30 dias.
   */
  private parseRange(input: { from?: string; to?: string }): { inicio: Date; fim: Date } {
    const fim = input.to ? new Date(`${input.to}T00:00:00.000Z`) : new Date();
    if (isNaN(fim.getTime())) throw new BadRequestException('to inválido');
    const inicio = input.from
      ? new Date(`${input.from}T00:00:00.000Z`)
      : (() => {
          const d = new Date(fim);
          d.setDate(d.getDate() - 30);
          return d;
        })();
    if (isNaN(inicio.getTime())) throw new BadRequestException('from inválido');
    if (inicio > fim) throw new BadRequestException('from > to');
    // half-open: fim exclusivo
    const fimExclusive = new Date(fim);
    fimExclusive.setDate(fimExclusive.getDate() + 1);
    return { inicio, fim: fimExclusive };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OVERVIEW — tabela principal (1 linha por loja)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Visão geral por loja: estoque atual + movimentação de remessas + venda.
   * Saldo movimento = recebido - enviado - vendido (entrada vs saída).
   *
   * Cada loja vira 1 linha. Inclui também totalRede + totalFranquia agregados.
   */
  async getStoresOverview(input: {
    from?: string;
    to?: string;
    plusSize?: boolean;
    year?: string;
  }) {
    const { inicio, fim } = this.parseRange(input);
    const plusSize = !!input.plusSize;
    const year = input.year;

    // Carrega lojas ativas
    const stores = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, tipo: true } as any,
      orderBy: { code: 'asc' },
    });
    const codes = (stores as any[]).map((s) => s.code);

    // Em paralelo: estoque + vendas (Giga) + remessas in/out (Postgres)
    // Estoque e vendas filtram por ANO DE CADASTRO da peça (year). As remessas
    // ficam sem esse filtro porque o histórico de envios não conhece a data
    // de cadastro do SKU — manteve o comportamento atual.
    const [stockMap, salesMap, recebido, enviado] = await Promise.all([
      this.erp.getStockTotalByStores(plusSize, year),
      this.erp.getSalesByStoresInRange(inicio, fim, plusSize, year),
      this.getRecebidoByStore(inicio, fim, codes),
      this.getEnviadoByStore(inicio, fim, codes),
    ]);

    let totalEstoqueRede = 0;
    let totalEstoqueFranquia = 0;
    let totalVendasRede = { pecas: 0, valor: 0 };
    let totalVendasFranquia = { pecas: 0, valor: 0 };

    const rows = (stores as any[]).map((s) => {
      const estoque = stockMap.get(s.code) || 0;
      const vendas = salesMap.get(s.code) || { pecas: 0, valor: 0 };
      const rec = recebido.get(s.code) || 0;
      const env = enviado.get(s.code) || 0;
      const tipo = (s.tipo || 'REDE') as 'REDE' | 'FILIAL';
      // Saldo: o que entrou (recebido) - o que saiu (enviado + vendido)
      const saldo = rec - env - vendas.pecas;

      if (tipo === 'FILIAL') {
        totalEstoqueFranquia += estoque;
        totalVendasFranquia.pecas += vendas.pecas;
        totalVendasFranquia.valor += vendas.valor;
      } else {
        totalEstoqueRede += estoque;
        totalVendasRede.pecas += vendas.pecas;
        totalVendasRede.valor += vendas.valor;
      }

      return {
        storeCode: s.code,
        storeName: s.name,
        tipo,
        estoqueAtual: estoque,
        recebido: rec,
        enviado: env,
        vendidoPecas: vendas.pecas,
        vendidoValor: vendas.valor,
        saldoMovimento: saldo,
        // Ticket médio (só calcula se tiver venda)
        ticketMedio: vendas.pecas > 0 ? vendas.valor / vendas.pecas : 0,
      };
    });

    return {
      periodo: {
        from: inicio.toISOString().slice(0, 10),
        to: new Date(fim.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        plusSize,
        year: year || null,
      },
      totaisGerais: {
        estoqueRede: totalEstoqueRede,
        estoqueFranquia: totalEstoqueFranquia,
        estoqueTotal: totalEstoqueRede + totalEstoqueFranquia,
        vendidoRede: totalVendasRede,
        vendidoFranquia: totalVendasFranquia,
        vendidoTotal: {
          pecas: totalVendasRede.pecas + totalVendasFranquia.pecas,
          valor: totalVendasRede.valor + totalVendasFranquia.valor,
        },
      },
      rows: rows.sort((a, b) => b.vendidoValor - a.vendidoValor),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MOVIMENTAÇÃO DE REMESSAS (Postgres)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Total de PEÇAS recebidas (status = received) por loja destino no período.
   * Considera só remessas que efetivamente chegaram.
   */
  private async getRecebidoByStore(
    inicio: Date,
    fim: Date,
    storeCodes: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!storeCodes.length) return out;
    try {
      // Pega remessas recebidas no período
      const shipments = await (this.prisma as any).realignmentShipment.findMany({
        where: {
          status: 'received',
          receivedAt: { gte: inicio, lt: fim },
          toStoreCode: { in: storeCodes },
        },
        select: { id: true, toStoreCode: true, receivedQty: true },
      });
      // Soma por loja
      for (const s of shipments as any[]) {
        const code = String(s.toStoreCode);
        out.set(code, (out.get(code) || 0) + (s.receivedQty || 0));
      }
      return out;
    } catch (e) {
      this.logger.warn(`getRecebidoByStore falhou: ${(e as Error).message}`);
      return out;
    }
  }

  /**
   * Total de PEÇAS enviadas por loja origem no período (status in_transit ou
   * received, ou seja: caixa saiu da loja). sentAt no range.
   */
  private async getEnviadoByStore(
    inicio: Date,
    fim: Date,
    storeCodes: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!storeCodes.length) return out;
    try {
      const shipments = await (this.prisma as any).realignmentShipment.findMany({
        where: {
          status: { in: ['in_transit', 'received'] },
          sentAt: { gte: inicio, lt: fim },
          fromStoreCode: { in: storeCodes },
        },
        select: { id: true, fromStoreCode: true, totalQty: true },
      });
      for (const s of shipments as any[]) {
        const code = String(s.fromStoreCode);
        out.set(code, (out.get(code) || 0) + (s.totalQty || 0));
      }
      return out;
    } catch (e) {
      this.logger.warn(`getEnviadoByStore falhou: ${(e as Error).message}`);
      return out;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DRILL-DOWN — top vendas, rupturas, parados (escopo: rede ou loja)
  // ═══════════════════════════════════════════════════════════════════════

  async getTopSellers(input: {
    from?: string;
    to?: string;
    storeCode?: string | null;
    plusSize?: boolean;
    orderBy?: 'pecas' | 'valor';
    limit?: number;
  }) {
    const { inicio, fim } = this.parseRange(input);
    return this.erp.getTopRefsBySales({
      inicio,
      fim,
      storeCode: input.storeCode || null,
      plusSize: !!input.plusSize,
      orderBy: input.orderBy || 'pecas',
      limit: input.limit || 10,
    });
  }

  async getRupturas(input: {
    from?: string;
    to?: string;
    storeCode?: string | null;
    plusSize?: boolean;
    limit?: number;
  }) {
    const { inicio, fim } = this.parseRange(input);
    return this.erp.getRupturas({
      inicio,
      fim,
      storeCode: input.storeCode || null,
      plusSize: !!input.plusSize,
      limit: input.limit || 10,
    });
  }

  async getParados(input: {
    storeCode?: string | null;
    daysSemVenda?: number;
    minStock?: number;
    plusSize?: boolean;
    limit?: number;
  }) {
    return this.erp.getParados({
      storeCode: input.storeCode || null,
      daysSemVenda: input.daysSemVenda || 30,
      minStock: input.minStock || 5,
      plusSize: !!input.plusSize,
      limit: input.limit || 10,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STORE DETAIL — tudo de uma loja (drill-down completo)
  // ═══════════════════════════════════════════════════════════════════════

  async getStoreDetail(input: {
    storeCode: string;
    from?: string;
    to?: string;
    plusSize?: boolean;
  }) {
    if (!input.storeCode) throw new BadRequestException('storeCode obrigatório');
    const { inicio, fim } = this.parseRange(input);
    const plusSize = !!input.plusSize;

    const store = await this.prisma.store.findFirst({
      where: { code: input.storeCode, active: true },
      select: { code: true, name: true, tipo: true } as any,
    });
    if (!store) throw new BadRequestException(`Loja ${input.storeCode} não encontrada`);

    const [stockMap, salesMap, topPecas, topValor, rupturas, parados] = await Promise.all([
      this.erp.getStockTotalByStores(plusSize),
      this.erp.getSalesByStoresInRange(inicio, fim, plusSize),
      this.erp.getTopRefsBySales({
        inicio,
        fim,
        storeCode: input.storeCode,
        plusSize,
        orderBy: 'pecas',
        limit: 10,
      }),
      this.erp.getTopRefsBySales({
        inicio,
        fim,
        storeCode: input.storeCode,
        plusSize,
        orderBy: 'valor',
        limit: 10,
      }),
      this.erp.getRupturas({
        inicio,
        fim,
        storeCode: input.storeCode,
        plusSize,
        limit: 10,
      }),
      this.erp.getParados({
        storeCode: input.storeCode,
        daysSemVenda: 30,
        minStock: 5,
        plusSize,
        limit: 10,
      }),
    ]);

    const estoque = stockMap.get(input.storeCode) || 0;
    const vendas = salesMap.get(input.storeCode) || { pecas: 0, valor: 0 };

    // Cobertura: peças em estoque ÷ peças vendidas/dia (no período)
    const dias = Math.max(1, Math.round((fim.getTime() - inicio.getTime()) / (24 * 60 * 60 * 1000)));
    const vendaDiaria = vendas.pecas / dias;
    const cobertura = vendaDiaria > 0 ? estoque / vendaDiaria : null;

    return {
      store: {
        code: (store as any).code,
        name: (store as any).name,
        tipo: ((store as any).tipo || 'REDE') as 'REDE' | 'FILIAL',
      },
      periodo: {
        from: inicio.toISOString().slice(0, 10),
        to: new Date(fim.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        dias,
        plusSize,
      },
      kpis: {
        estoqueAtual: estoque,
        vendidoPecas: vendas.pecas,
        vendidoValor: vendas.valor,
        ticketMedio: vendas.pecas > 0 ? vendas.valor / vendas.pecas : 0,
        vendaDiariaPecas: vendaDiaria,
        coberturaDias: cobertura, // null = sem venda no período
      },
      topVendasPorPeca: topPecas,
      topVendasPorValor: topValor,
      rupturas,
      parados,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HEATMAP REF × LOJA
  // ═══════════════════════════════════════════════════════════════════════

  async getHeatmap(input: { plusSize?: boolean; limit?: number }) {
    return this.erp.getHeatmap({
      plusSize: !!input.plusSize,
      limitRefs: input.limit || 20,
    });
  }
}
