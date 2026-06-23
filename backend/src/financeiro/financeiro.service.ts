import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { RealignmentPricingService } from '../realignment/realignment-pricing.service';

/**
 * FinanceiroService — gerencia obrigações intercompany REDE↔FILIAL.
 *
 * Responsabilidades:
 *   1. Lista obrigações por mês de referência (com agrupamento por par de lojas).
 *   2. Calcula royalties (8%) + marketing (4%) sobre venda bruta das filiais
 *      no período (fonte: tabela `caixa` do Gigasistemas).
 *   3. Marca obrigações como pagas.
 *   4. Fecha o mês (cria snapshot imutável em MonthlyClosure).
 *   5. Histórico de fechamentos.
 *
 * Acesso: TODOS endpoints só pra admin (verificação no controller).
 */
@Injectable()
export class FinanceiroService {
  private readonly logger = new Logger(FinanceiroService.name);
  // Percentuais hardcoded por enquanto (futuro: configurável por filial)
  private readonly ROYALTIES_PCT = 0.08; // 8%
  private readonly MARKETING_PCT = 0.04; // 4%

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
    private readonly pricing: RealignmentPricingService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // OBRIGAÇÕES (transferências REDE↔FILIAL)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista obrigações de um mês específico com totais agregados por par de lojas.
   *
   * mesReferencia: "YYYY-MM", ex: "2026-04"
   * status: filtro opcional. Se omitido, retorna pending+closed (não inclui paid/cancelled
   *         por padrão pra deixar a tela limpa).
   */
  async listObligationsByMonth(mesReferencia: string, statusFilter?: string) {
    if (!/^\d{4}-\d{2}$/.test(mesReferencia)) {
      throw new BadRequestException('mesReferencia inválido (formato YYYY-MM)');
    }

    const where: any = { mesReferencia };
    if (statusFilter) {
      where.status = statusFilter;
    } else {
      where.status = { in: ['pending', 'closed'] };
    }

    const obligations = await (this.prisma as any).interStoreObligation.findMany({
      where,
      orderBy: [{ fromStoreCode: 'asc' }, { toStoreCode: 'asc' }, { createdAt: 'asc' }],
    });

    // Agrega por par (from→to)
    const groupedMap = new Map<
      string,
      {
        fromStoreCode: string;
        fromStoreName: string;
        fromStoreTipo: string;
        toStoreCode: string;
        toStoreName: string;
        toStoreTipo: string;
        totalQty: number;
        totalPrecoTotal: number;
        totalValorObrigacao: number;
        items: any[];
      }
    >();

    for (const o of obligations as any[]) {
      const key = `${o.fromStoreCode}::${o.toStoreCode}`;
      let g = groupedMap.get(key);
      if (!g) {
        g = {
          fromStoreCode: o.fromStoreCode,
          fromStoreName: o.fromStoreName,
          fromStoreTipo: o.fromStoreTipo,
          toStoreCode: o.toStoreCode,
          toStoreName: o.toStoreName,
          toStoreTipo: o.toStoreTipo,
          totalQty: 0,
          totalPrecoTotal: 0,
          totalValorObrigacao: 0,
          items: [],
        };
        groupedMap.set(key, g);
      }
      g.totalQty += o.qty;
      g.totalPrecoTotal += o.precoTotal;
      g.totalValorObrigacao += o.valorObrigacao;
      g.items.push(o);
    }

    const grouped = Array.from(groupedMap.values()).sort((a, b) =>
      (a.fromStoreCode + a.toStoreCode).localeCompare(b.fromStoreCode + b.toStoreCode),
    );

    return {
      mesReferencia,
      totalObrigacoes: obligations.reduce((s: number, o: any) => s + o.valorObrigacao, 0),
      countObligations: obligations.length,
      grouped,
    };
  }

  /**
   * Recalcula precos das obrigacoes PENDENTES de um mes — rebusca preco
   * de venda atual no Giga e atualiza precoUnitario / precoTotal / valorObrigacao.
   *
   * Util quando o backend pulled preco da coluna errada (ex: VENDAUN = custo)
   * e gerou obrigacoes com valor unitario absurdo (R$ 0,80 por peca).
   * Apos correcao na regra de busca, este endpoint reseta todas as pending.
   */
  async recalcObligationsPrices(mesReferencia: string) {
    if (!/^\d{4}-\d{2}$/.test(mesReferencia)) {
      throw new BadRequestException('mesReferencia deve ser YYYY-MM');
    }
    const obligations = await (this.prisma as any).interStoreObligation.findMany({
      where: { mesReferencia, status: 'pending' },
    });
    if (obligations.length === 0) {
      return { mesReferencia, total: 0, atualizadas: 0, semSku: 0, semPreco: 0 };
    }

    // Coleta SKUs + REFs unicos pra buscar precos em batch.
    // USA RealignmentPricingService (VENDAUN em REAIS) — NÃO o
    // getProductPricesBySkus (que divide VENDAUN por 100 e gerava obrigações
    // ÷100, ex.: R$ 1,90/peça em vez de R$ 190). Fallback por REF.
    const skus = Array.from(new Set(
      (obligations as any[]).map((o) => o.sku).filter(Boolean),
    ));
    const refs = Array.from(new Set(
      (obligations as any[]).map((o) => o.refCode).filter(Boolean),
    ));
    const priceMap = await this.pricing.getPricesByCodigos(skus);
    const refPriceMap = await this.pricing.getPricesByRefs(refs);

    let atualizadas = 0;
    let semSku = 0;
    let semPreco = 0;
    const divisorPadrao = 2.5;

    for (const o of obligations as any[]) {
      const novoPreco = (o.sku ? priceMap.get(o.sku) || 0 : 0) || refPriceMap.get(o.refCode) || 0;
      if (novoPreco <= 0) { if (!o.sku) semSku++; else semPreco++; continue; }
      // Mantem o mesmo se for igual (nao re-update sem necessidade)
      if (Math.abs(Number(o.precoUnitario || 0) - novoPreco) < 0.01) continue;

      const novoPrecoTotal = novoPreco * (Number(o.qty) || 1);
      const novoValorObrigacao = novoPrecoTotal / (Number(o.divisor) || divisorPadrao);
      await (this.prisma as any).interStoreObligation.update({
        where: { id: o.id },
        data: {
          precoUnitario: novoPreco,
          precoTotal: novoPrecoTotal,
          valorObrigacao: novoValorObrigacao,
        },
      });
      atualizadas++;
    }

    this.logger.log(
      `[financeiro] recalc obligations ${mesReferencia}: total=${obligations.length} atualizadas=${atualizadas} semSku=${semSku} semPreco=${semPreco}`,
    );

    return {
      mesReferencia,
      total: obligations.length,
      atualizadas,
      semSku,
      semPreco,
    };
  }

  /**
   * Marca uma obrigação como paga.
   */
  async markObligationPaid(id: string, userId: string | null, note?: string) {
    const obligation = await (this.prisma as any).interStoreObligation.findUnique({
      where: { id },
    });
    if (!obligation) throw new NotFoundException('Obrigação não encontrada');
    if (obligation.status === 'paid')
      throw new BadRequestException('Obrigação já estava paga');
    if (obligation.status === 'cancelled')
      throw new BadRequestException('Obrigação cancelada não pode ser paga');

    const updated = await (this.prisma as any).interStoreObligation.update({
      where: { id },
      data: {
        status: 'paid',
        paidAt: new Date(),
        paidByUserId: userId,
        paidNote: note?.trim() || null,
      },
    });
    return { ok: true, id: updated.id };
  }

  /**
   * Marca um LOTE de obrigações como pagas (atalho pra "pagar tudo do par X→Y").
   */
  async markObligationsPaidBulk(ids: string[], userId: string | null, note?: string) {
    if (!Array.isArray(ids) || !ids.length) {
      throw new BadRequestException('Nenhuma obrigação selecionada');
    }
    const result = await (this.prisma as any).interStoreObligation.updateMany({
      where: {
        id: { in: ids },
        status: { in: ['pending', 'closed'] }, // só atualiza as elegíveis
      },
      data: {
        status: 'paid',
        paidAt: new Date(),
        paidByUserId: userId,
        paidNote: note?.trim() || null,
      },
    });
    return { ok: true, updated: result.count };
  }

  /**
   * Cancela uma obrigação (caso tenha sido criada por engano ou
   * a transferência foi revertida).
   */
  async cancelObligation(id: string, userId: string | null, reason: string) {
    if (!reason?.trim()) throw new BadRequestException('Motivo é obrigatório');
    const obligation = await (this.prisma as any).interStoreObligation.findUnique({
      where: { id },
    });
    if (!obligation) throw new NotFoundException('Obrigação não encontrada');
    if (obligation.status === 'paid')
      throw new BadRequestException('Obrigação paga não pode ser cancelada (estorno manual)');

    await (this.prisma as any).interStoreObligation.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: reason.trim(),
      },
    });
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ROYALTIES + MARKETING (sobre venda bruta das filiais)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Calcula royalties (8%) + marketing (4%) por filial pra um mês específico.
   *
   * Fonte: tabela `caixa` do Giga. Soma VALORTOTAL onde LOJA é uma filial e
   * DATA cai no mês de referência. Ignora linhas MARCADO='SIM'.
   *
   * Retorna por filial:
   *   { storeCode, storeName, vendaBruta, royaltiesValor, marketingValor,
   *     totalAPagar }
   */
  async getRoyaltiesByMonth(mesReferencia: string) {
    if (!/^\d{4}-\d{2}$/.test(mesReferencia)) {
      throw new BadRequestException('mesReferencia inválido (formato YYYY-MM)');
    }

    // Busca filiais ativas
    const filiais = await this.prisma.store.findMany({
      where: { active: true, ...({ tipo: 'FILIAL' } as any) } as any,
      select: { code: true, name: true } as any,
      orderBy: { code: 'asc' },
    });

    if (!filiais.length) {
      return {
        mesReferencia,
        royaltiesPct: this.ROYALTIES_PCT,
        marketingPct: this.MARKETING_PCT,
        totalRoyalties: 0,
        totalMarketing: 0,
        totalAPagar: 0,
        porFilial: [],
      };
    }

    // Calcula range do mês
    const [year, month] = mesReferencia.split('-').map(Number);
    const inicio = new Date(Date.UTC(year, month - 1, 1));
    const fim = new Date(Date.UTC(year, month, 1)); // primeiro dia do mês seguinte (exclusive)

    // Busca venda bruta no Giga
    const vendasPorLoja = await this.erp.getSalesGrossByStores(
      (filiais as any[]).map((f) => String(f.code)),
      inicio,
      fim,
    );

    let totalRoyalties = 0;
    let totalMarketing = 0;
    const porFilial = filiais.map((f: any) => {
      const vendaBruta = vendasPorLoja.get(f.code) || 0;
      const royaltiesValor = vendaBruta * this.ROYALTIES_PCT;
      const marketingValor = vendaBruta * this.MARKETING_PCT;
      totalRoyalties += royaltiesValor;
      totalMarketing += marketingValor;
      return {
        storeCode: f.code,
        storeName: f.name,
        vendaBruta,
        royaltiesValor,
        marketingValor,
        totalAPagar: royaltiesValor + marketingValor,
      };
    });

    return {
      mesReferencia,
      royaltiesPct: this.ROYALTIES_PCT,
      marketingPct: this.MARKETING_PCT,
      totalRoyalties,
      totalMarketing,
      totalAPagar: totalRoyalties + totalMarketing,
      porFilial,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FECHAMENTO MENSAL
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Lista fechamentos já feitos (mais recente primeiro).
   */
  async listClosures() {
    return (this.prisma as any).monthlyClosure.findMany({
      orderBy: { mesReferencia: 'desc' },
      take: 24, // últimos 24 meses
    });
  }

  /**
   * Lê um fechamento específico (com detalhe).
   */
  async getClosure(mesReferencia: string) {
    const c = await (this.prisma as any).monthlyClosure.findUnique({
      where: { mesReferencia },
    });
    if (!c) throw new NotFoundException(`Mês ${mesReferencia} não foi fechado`);
    return {
      ...c,
      detalhePorFilial: c.detalhePorFilial ? JSON.parse(c.detalhePorFilial) : [],
    };
  }

  /**
   * Fecha o mês — gera snapshot imutável.
   *
   * Operação:
   *   1. Calcula obrigações (pending) + royalties + marketing do mês.
   *   2. Salva em MonthlyClosure com detalhamento JSON por filial.
   *   3. Atualiza status das obrigações pending → closed (vira snapshot).
   *
   * Se o mês já foi fechado, RECRIA (overwrite) — útil pra reabrir mês e
   * recalcular caso tenha lançamento atrasado. Mas só admin pode reabrir.
   */
  async closeMonth(mesReferencia: string, userId: string | null, force = false) {
    if (!/^\d{4}-\d{2}$/.test(mesReferencia)) {
      throw new BadRequestException('mesReferencia inválido (formato YYYY-MM)');
    }

    const existing = await (this.prisma as any).monthlyClosure.findUnique({
      where: { mesReferencia },
    });
    if (existing && !force) {
      throw new BadRequestException(
        `Mês ${mesReferencia} já foi fechado em ${existing.closedAt.toISOString().slice(0, 10)}. Use force=true pra refazer.`,
      );
    }

    // Calcula tudo
    const obligationsView = await this.listObligationsByMonth(mesReferencia);
    const royalties = await this.getRoyaltiesByMonth(mesReferencia);

    // Monta detalhe por filial (combina obrigações + royalties)
    // Pra cada filial: obrigacoesAPagar (foi destino) + obrigacoesAReceber (foi origem)
    //   + royalties + marketing → saldoLiquido
    const filiais = await this.prisma.store.findMany({
      where: { active: true, ...({ tipo: 'FILIAL' } as any) } as any,
      select: { code: true, name: true } as any,
    });

    const detalhePorFilial = filiais.map((f: any) => {
      const royaltiesData = royalties.porFilial.find((r) => r.storeCode === f.code);
      // Filial paga (foi destino numa transferência REDE→FILIAL)
      const aPagar = obligationsView.grouped
        .filter((g) => g.toStoreCode === f.code)
        .reduce((s, g) => s + g.totalValorObrigacao, 0);
      // Filial recebe (foi origem numa transferência FILIAL→REDE)
      const aReceber = obligationsView.grouped
        .filter((g) => g.fromStoreCode === f.code)
        .reduce((s, g) => s + g.totalValorObrigacao, 0);
      const royaltiesValor = royaltiesData?.royaltiesValor || 0;
      const marketingValor = royaltiesData?.marketingValor || 0;
      // Saldo final que filial deve pagar pra REDE:
      //   (obrigações a pagar - obrigações a receber) + royalties + marketing
      const saldoLiquido = aPagar - aReceber + royaltiesValor + marketingValor;
      return {
        storeCode: f.code,
        storeName: f.name,
        vendaBruta: royaltiesData?.vendaBruta || 0,
        obrigacoesAPagar: aPagar,
        obrigacoesAReceber: aReceber,
        royaltiesValor,
        marketingValor,
        saldoLiquido,
      };
    });

    // Persiste fechamento
    const data = {
      mesReferencia,
      closedByUserId: userId,
      totalObrigacoes: obligationsView.totalObrigacoes,
      totalRoyalties: royalties.totalRoyalties,
      totalMarketing: royalties.totalMarketing,
      detalhePorFilial: JSON.stringify(detalhePorFilial),
    };

    if (existing) {
      await (this.prisma as any).monthlyClosure.update({
        where: { mesReferencia },
        data: { ...data, closedAt: new Date() },
      });
    } else {
      await (this.prisma as any).monthlyClosure.create({ data });
    }

    // Marca obrigações pending→closed
    await (this.prisma as any).interStoreObligation.updateMany({
      where: { mesReferencia, status: 'pending' },
      data: {
        status: 'closed',
        closedAt: new Date(),
        closedByUserId: userId,
      },
    });

    this.logger.log(
      `[financeiro] Mês ${mesReferencia} fechado. Obrigações: R$${obligationsView.totalObrigacoes.toFixed(2)}. ` +
        `Royalties: R$${royalties.totalRoyalties.toFixed(2)}. ` +
        `Marketing: R$${royalties.totalMarketing.toFixed(2)}.`,
    );

    return {
      ok: true,
      mesReferencia,
      totalObrigacoes: obligationsView.totalObrigacoes,
      totalRoyalties: royalties.totalRoyalties,
      totalMarketing: royalties.totalMarketing,
      detalhePorFilial,
    };
  }
}
