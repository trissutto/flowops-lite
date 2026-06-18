import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CommissionsService — F4 do plano de migração 30/06.
 *
 * Substitui o cálculo de comissão que hoje sai do Wincred/Giga. A partir do
 * cut-over, o flowops é source-of-truth pra remunerar vendedoras.
 *
 * Arquitetura de regras (hierárquica):
 *   1. Procura por scope='seller' WHERE sellerId = X (mais específico)
 *   2. Se nao achar, scope='store' WHERE storeId = Y
 *   3. Se nao achar, scope='global'
 *   4. Se nao achar nada, aplica zero (e loga aviso)
 *
 * Cálculo por entry (vendedora × loja × período):
 *   totalVendido    = SOMA(valor das vendas finalizadas da vendedora no período)
 *   totalTrocas     = SOMA(valor de trocas/devoluções no mesmo período)
 *   vendidoLiquido  = totalVendido - totalTrocas
 *   comissaoBase    = vendidoLiquido × (percentBase / 100)
 *   bonusValue      = (vendidoLiquido >= meta) ? vendidoLiquido × (bonusPercent / 100) : 0
 *   total           = comissaoBase + bonusValue
 *
 * Idempotente: chamar `calculateForPeriod` 2 vezes gera o mesmo resultado.
 * Re-cálculo sobrescreve entries existentes do MESMO período (se não estiver paid).
 */
@Injectable()
export class CommissionsService {
  private readonly logger = new Logger(CommissionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Rules CRUD ─────────────────────────────────────────────────────

  async listRules(filters?: {
    scope?: string;
    storeId?: string;
    sellerId?: string;
    activeOnly?: boolean;
  }) {
    const where: any = {};
    if (filters?.scope) where.scope = filters.scope;
    if (filters?.storeId !== undefined) where.storeId = filters.storeId || null;
    if (filters?.sellerId !== undefined) where.sellerId = filters.sellerId || null;
    if (filters?.activeOnly) where.active = true;
    return (this.prisma as any).commissionRule.findMany({
      where,
      orderBy: [{ scope: 'asc' }, { validFrom: 'desc' }],
      include: {
        store: { select: { code: true, name: true } },
        seller: { select: { name: true } },
      },
    });
  }

  async createRule(input: {
    scope: 'global' | 'store' | 'seller';
    storeId?: string | null;
    sellerId?: string | null;
    percentBase: number;
    meta?: number | null;
    bonusPercent?: number | null;
    validFrom: Date;
    validTo?: Date | null;
    active?: boolean;
    note?: string | null;
    createdBy?: string;
  }) {
    if (!['global', 'store', 'seller'].includes(input.scope)) {
      throw new BadRequestException('scope inválido (global | store | seller)');
    }
    if (input.scope === 'store' && !input.storeId) {
      throw new BadRequestException('storeId obrigatório pra scope=store');
    }
    if (input.scope === 'seller' && !input.sellerId) {
      throw new BadRequestException('sellerId obrigatório pra scope=seller');
    }
    if (!(input.percentBase >= 0 && input.percentBase <= 100)) {
      throw new BadRequestException('percentBase deve ser 0-100');
    }
    if (input.bonusPercent != null && !(input.bonusPercent >= 0 && input.bonusPercent <= 100)) {
      throw new BadRequestException('bonusPercent deve ser 0-100');
    }
    if (input.meta != null && input.meta < 0) {
      throw new BadRequestException('meta deve ser >= 0');
    }

    return (this.prisma as any).commissionRule.create({
      data: {
        scope: input.scope,
        storeId: input.scope === 'store' ? input.storeId : null,
        sellerId: input.scope === 'seller' ? input.sellerId : null,
        percentBase: input.percentBase,
        meta: input.meta ?? null,
        bonusPercent: input.bonusPercent ?? null,
        validFrom: input.validFrom,
        validTo: input.validTo ?? null,
        active: input.active ?? true,
        note: input.note || null,
        createdBy: input.createdBy || null,
      },
    });
  }

  async updateRule(id: string, input: any) {
    const cur = await (this.prisma as any).commissionRule.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Regra não encontrada');
    return (this.prisma as any).commissionRule.update({
      where: { id },
      data: {
        percentBase: input.percentBase ?? undefined,
        meta: input.meta !== undefined ? input.meta : undefined,
        bonusPercent: input.bonusPercent !== undefined ? input.bonusPercent : undefined,
        validFrom: input.validFrom ?? undefined,
        validTo: input.validTo !== undefined ? input.validTo : undefined,
        active: input.active ?? undefined,
        note: input.note !== undefined ? input.note : undefined,
      },
    });
  }

  async deactivateRule(id: string) {
    return (this.prisma as any).commissionRule.update({
      where: { id },
      data: { active: false },
    });
  }

  /**
   * Resolve qual regra aplicar pra uma vendedora numa loja específica.
   * Hierarquia: seller > cargo > store > global.
   *
   * Pra LIDER/GERENTE → busca regra do cargo dela (que tem calcMode=on_responsible_store).
   * Pra VENDEDORA → busca regra de cargo VENDEDORA (calcMode=on_self).
   */
  async resolveRuleFor(
    sellerId: string,
    storeId: string,
    cargo: string,
    refDate: Date,
  ): Promise<any | null> {
    const where = (extra: any) => ({
      active: true,
      validFrom: { lte: refDate },
      OR: [{ validTo: null }, { validTo: { gte: refDate } }],
      ...extra,
    });

    // 1. seller-specific (override raro pra vendedora especial)
    let r = await (this.prisma as any).commissionRule.findFirst({
      where: where({ scope: 'seller', sellerId }),
      orderBy: { validFrom: 'desc' },
    });
    if (r) return r;

    // 2. por cargo (caminho principal — modelo Lurd's)
    r = await (this.prisma as any).commissionRule.findFirst({
      where: where({ scope: 'cargo', cargo }),
      orderBy: { validFrom: 'desc' },
    });
    if (r) return r;

    // 3. store-specific
    r = await (this.prisma as any).commissionRule.findFirst({
      where: where({ scope: 'store', storeId }),
      orderBy: { validFrom: 'desc' },
    });
    if (r) return r;

    // 4. global
    r = await (this.prisma as any).commissionRule.findFirst({
      where: where({ scope: 'global' }),
      orderBy: { validFrom: 'desc' },
    });
    return r;
  }

  /**
   * Cria as regras-padrão dos 5 cargos Lurd's. Idempotente: pula se já existir
   * regra ativa com o mesmo cargo. Útil pro setup inicial via tela.
   */
  async seedDefaultCargoRules(createdBy?: string) {
    const today = new Date();
    const defaults = [
      { cargo: 'VENDEDORA',  percentBase: 2.0, calcMode: 'on_self',              label: 'Vendedora 2% sobre vendas próprias' },
      { cargo: 'CAIXA',      percentBase: 2.0, calcMode: 'on_self',              label: 'Caixa 2% sobre vendas próprias (on+off)' },
      { cargo: 'LIDER_B',    percentBase: 0.5, calcMode: 'on_responsible_store', label: 'Líder B 0,5% sobre loja responsável' },
      { cargo: 'LIDER_A',    percentBase: 1.0, calcMode: 'on_responsible_store', label: 'Líder A 1,0% sobre loja responsável' },
      { cargo: 'GERENTE_B',  percentBase: 1.5, calcMode: 'on_responsible_store', label: 'Gerente B 1,5% sobre loja responsável' },
      { cargo: 'GERENTE_A',  percentBase: 2.0, calcMode: 'on_responsible_store', label: 'Gerente A 2,0% sobre loja responsável' },
    ];
    const created: any[] = [];
    for (const d of defaults) {
      const existing = await (this.prisma as any).commissionRule.findFirst({
        where: { scope: 'cargo', cargo: d.cargo, active: true },
      });
      if (existing) continue;
      const r = await (this.prisma as any).commissionRule.create({
        data: {
          scope: 'cargo',
          cargo: d.cargo,
          calcMode: d.calcMode,
          percentBase: d.percentBase,
          validFrom: today,
          active: true,
          note: d.label,
          createdBy: createdBy || null,
        },
      });
      created.push(r);
    }
    return { created: created.length, total: defaults.length };
  }

  // ── Period CRUD ────────────────────────────────────────────────────

  /** Cria período (idempotente — se já existir, retorna o existente) */
  async ensurePeriod(yearMonth: string) {
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
      throw new BadRequestException('yearMonth inválido (formato YYYY-MM)');
    }
    const existing = await (this.prisma as any).commissionPeriod.findUnique({
      where: { yearMonth },
    });
    if (existing) return existing;

    const [y, m] = yearMonth.split('-').map((s) => parseInt(s, 10));
    const startDate = new Date(y, m - 1, 1, 0, 0, 0);
    const endDate = new Date(y, m, 0, 23, 59, 59); // último dia do mês

    return (this.prisma as any).commissionPeriod.create({
      data: {
        yearMonth,
        startDate,
        endDate,
        status: 'open',
      },
    });
  }

  async listPeriods() {
    return (this.prisma as any).commissionPeriod.findMany({
      orderBy: { yearMonth: 'desc' },
    });
  }

  async getPeriod(yearMonth: string) {
    return (this.prisma as any).commissionPeriod.findUnique({
      where: { yearMonth },
      include: {
        entries: {
          include: {
            seller: { select: { name: true } },
          },
          orderBy: { total: 'desc' },
        },
      },
    });
  }

  // ── Engine de cálculo ──────────────────────────────────────────────

  /**
   * Calcula comissão de TODAS as vendedoras pro período.
   * Retorna lista de entries criadas/atualizadas.
   *
   * Não recalcula entries de período 'paid'. Período 'closed' permite
   * recálculo manual (admin override) mas loga aviso.
   */
  async calculateForPeriod(yearMonth: string): Promise<{ entries: any[]; total: number }> {
    const period = await this.ensurePeriod(yearMonth);
    if (period.status === 'paid') {
      throw new BadRequestException(`Período ${yearMonth} já está PAID — não recalcula`);
    }
    if (period.status === 'closed') {
      this.logger.warn(`[commissions] Recalculando período CLOSED ${yearMonth} (override admin)`);
    }

    // 1) Soma de vendas + trocas POR LOJA (pra cargo=on_responsible_store)
    const salesByStore: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT
         "storeCode",
         COUNT(*)::int AS qtd,
         SUM("totalAmount")::float AS total
       FROM "PdvSale"
       WHERE "finalizedAt" >= $1
         AND "finalizedAt" <= $2
         AND status = 'finalizada'
       GROUP BY "storeCode"`,
      period.startDate,
      period.endDate,
    );
    const trocasByStore: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT "storeCode", SUM("totalAmount")::float AS total
       FROM "PdvSale"
       WHERE "finalizedAt" >= $1 AND "finalizedAt" <= $2
         AND status IN ('estornada', 'devolvida')
       GROUP BY "storeCode"`,
      period.startDate,
      period.endDate,
    );
    const storeTotals = new Map<string, { vendido: number; trocas: number; qtd: number }>();
    for (const r of salesByStore) {
      storeTotals.set(r.storeCode, {
        vendido: Number(r.total) || 0,
        trocas: 0,
        qtd: Number(r.qtd) || 0,
      });
    }
    for (const r of trocasByStore) {
      const cur = storeTotals.get(r.storeCode) || { vendido: 0, trocas: 0, qtd: 0 };
      cur.trocas = Number(r.total) || 0;
      storeTotals.set(r.storeCode, cur);
    }

    // 2) Soma de vendas POR (vendedora × loja) (pra cargo=on_self da VENDEDORA)
    const salesBySeller: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT "sellerId", "storeCode",
         COUNT(*)::int AS qtd,
         SUM("totalAmount")::float AS total
       FROM "PdvSale"
       WHERE "finalizedAt" >= $1
         AND "finalizedAt" <= $2
         AND "sellerId" IS NOT NULL
         AND status = 'finalizada'
       GROUP BY "sellerId", "storeCode"`,
      period.startDate,
      period.endDate,
    );
    const trocasBySeller: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT "sellerId", "storeCode", SUM("totalAmount")::float AS total
       FROM "PdvSale"
       WHERE "finalizedAt" >= $1 AND "finalizedAt" <= $2
         AND "sellerId" IS NOT NULL
         AND status IN ('estornada', 'devolvida')
       GROUP BY "sellerId", "storeCode"`,
      period.startDate,
      period.endDate,
    );
    const sellerSalesMap = new Map<string, { vendido: number; trocas: number; qtd: number }>();
    for (const r of salesBySeller) {
      sellerSalesMap.set(`${r.sellerId}|${r.storeCode}`, {
        vendido: Number(r.total) || 0,
        trocas: 0,
        qtd: Number(r.qtd) || 0,
      });
    }
    for (const r of trocasBySeller) {
      const k = `${r.sellerId}|${r.storeCode}`;
      const cur = sellerSalesMap.get(k) || { vendido: 0, trocas: 0, qtd: 0 };
      cur.trocas = Number(r.total) || 0;
      sellerSalesMap.set(k, cur);
    }

    const stores = await this.prisma.store.findMany({ select: { id: true, code: true } });
    const storeCodeToId = new Map(stores.map((s) => [s.code, s.id]));
    const storeIdToCode = new Map(stores.map((s) => [s.id, s.code]));

    // 3) Lista TODAS as vendedoras/líderes/gerentes ativas — pra cobrir
    //    quem ganha sobre a loja toda mesmo se não vendeu.
    const allSellers: any[] = await (this.prisma as any).seller.findMany({
      where: { active: true },
    });

    const entries: any[] = [];
    let totalGeral = 0;

    // Wrapper genérico pra processar uma "entry candidata"
    // sellerId × storeCode → calcula segundo cargo/regra
    const processEntry = async (sellerId: string, sellerCargo: string, storeCode: string) => {
      const storeId = storeCodeToId.get(storeCode);
      if (!storeId) return;

      const rule = await this.resolveRuleFor(sellerId, storeId, sellerCargo, period.endDate);
      const calcMode = rule?.calcMode || 'on_self';

      let totalVendido = 0;
      let totalTrocas = 0;
      let qtdVendas = 0;

      if (calcMode === 'on_responsible_store') {
        // Base é a loja toda (cargo Líder/Gerente)
        const st = storeTotals.get(storeCode);
        if (!st) return;
        totalVendido = st.vendido;
        totalTrocas = st.trocas;
        qtdVendas = st.qtd;
      } else {
        // 'on_self' — base é só as vendas da vendedora
        const sl = sellerSalesMap.get(`${sellerId}|${storeCode}`);
        if (!sl) return;
        totalVendido = sl.vendido;
        totalTrocas = sl.trocas;
        qtdVendas = sl.qtd;
      }

      const vendidoLiquido = Math.max(0, totalVendido - totalTrocas);

      let percentApplied = 0;
      let comissaoBase = 0;
      let metaAtingida = false;
      let bonusValue = 0;
      let metaValue: number | null = null;
      let bonusPercent: number | null = null;
      let ruleSnapshot: any = {
        warning: 'sem regra aplicável — comissão zero',
        cargo: sellerCargo,
      };

      if (rule) {
        percentApplied = Number(rule.percentBase) || 0;
        comissaoBase = (vendidoLiquido * percentApplied) / 100;
        if (rule.meta != null && rule.bonusPercent != null) {
          metaValue = Number(rule.meta);
          bonusPercent = Number(rule.bonusPercent);
          if (vendidoLiquido >= metaValue) {
            metaAtingida = true;
            bonusValue = (vendidoLiquido * bonusPercent) / 100;
          }
        }
        ruleSnapshot = {
          id: rule.id,
          scope: rule.scope,
          cargo: rule.cargo,
          calcMode: rule.calcMode,
          percentBase: rule.percentBase,
          meta: rule.meta,
          bonusPercent: rule.bonusPercent,
        };
      }

      const total = comissaoBase + bonusValue;
      const storeIdResolved = storeCodeToId.get(storeCode);
      if (!storeIdResolved) return;

      // upsert entry
      const entry = await (this.prisma as any).commissionEntry.upsert({
        where: {
          periodId_sellerId_storeId: {
            periodId: period.id,
            sellerId,
            storeId: storeIdResolved,
          },
        },
        create: {
          periodId: period.id,
          sellerId,
          storeId: storeIdResolved,
          totalVendido,
          totalTrocas,
          vendidoLiquido,
          qtdVendas,
          percentApplied,
          comissaoBase,
          metaAtingida,
          metaValue,
          bonusPercent,
          bonusValue,
          total,
          ruleSnapshot,
          ruleId: rule?.id || null,
        },
        update: {
          totalVendido,
          totalTrocas,
          vendidoLiquido,
          qtdVendas,
          percentApplied,
          comissaoBase,
          metaAtingida,
          metaValue,
          bonusPercent,
          bonusValue,
          total,
          ruleSnapshot,
          ruleId: rule?.id || null,
          calculatedAt: new Date(),
        },
      });
      entries.push(entry);
      totalGeral += total;
    };

    // === FLUXO 1: vendedoras (cargo=VENDEDORA) — uma entry por loja onde vendeu ===
    for (const [key, sl] of sellerSalesMap) {
      const [sellerId, storeCode] = key.split('|');
      const seller = allSellers.find((x) => x.id === sellerId);
      const cargo = seller?.cargo || 'VENDEDORA';
      // Vendedoras + Caixa entram aqui (calcMode=on_self). Lideres/gerentes no fluxo 2.
      if (cargo !== 'VENDEDORA' && cargo !== 'CAIXA') continue;
      await processEntry(sellerId, cargo, storeCode);
    }

    // === FLUXO 2: líderes/gerentes — uma entry pela loja responsável ===
    for (const seller of allSellers) {
      const cargo = seller.cargo || 'VENDEDORA';
      if (cargo === 'VENDEDORA' || cargo === 'CAIXA') continue;
      if (!seller.responsibleStoreId) {
        this.logger.warn(
          `[commissions] ${seller.name} cargo=${cargo} sem responsibleStoreId — pulando`,
        );
        continue;
      }
      const storeCode = storeIdToCode.get(seller.responsibleStoreId);
      if (!storeCode) continue;
      await processEntry(seller.id, cargo, storeCode);
    }

    // Atualiza agregados do período
    await (this.prisma as any).commissionPeriod.update({
      where: { id: period.id },
      data: {
        totalSellers: new Set(entries.map((e) => e.sellerId)).size,
        totalCommission: totalGeral,
        totalVendido: entries.reduce((sum, e) => sum + Number(e.vendidoLiquido), 0),
      },
    });

    this.logger.log(
      `[commissions] Período ${yearMonth} calculado: ${entries.length} entries, total R$ ${totalGeral.toFixed(2)}`,
    );

    return { entries, total: totalGeral };
  }

  async closePeriod(yearMonth: string, userId?: string) {
    const period = await (this.prisma as any).commissionPeriod.findUnique({
      where: { yearMonth },
    });
    if (!period) throw new NotFoundException('Período não encontrado');
    if (period.status === 'paid') {
      throw new ConflictException('Período já está PAID');
    }
    return (this.prisma as any).commissionPeriod.update({
      where: { yearMonth },
      data: {
        status: 'closed',
        closedAt: new Date(),
        closedBy: userId || null,
      },
    });
  }

  async markPeriodPaid(yearMonth: string, userId?: string) {
    const period = await (this.prisma as any).commissionPeriod.findUnique({
      where: { yearMonth },
    });
    if (!period) throw new NotFoundException('Período não encontrado');
    if (period.status !== 'closed') {
      throw new BadRequestException('Período precisa estar CLOSED antes de ser PAID');
    }
    return (this.prisma as any).$transaction([
      (this.prisma as any).commissionPeriod.update({
        where: { yearMonth },
        data: {
          status: 'paid',
          paidAt: new Date(),
        },
      }),
      (this.prisma as any).commissionEntry.updateMany({
        where: { periodId: period.id },
        data: {
          paidAt: new Date(),
          paidBy: userId || null,
        },
      }),
    ]);
  }

  // ── Consulta de uma vendedora específica ──────────────────────────

  /**
   * Extrato da vendedora — comissões do período atual + histórico.
   * Auto-calcula se o período atual ainda não tem entry.
   */
  async getSellerStatement(sellerId: string, options?: { history?: number }) {
    const historyMonths = options?.history ?? 6;
    const now = new Date();
    const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Garante período atual + calcula
    await this.ensurePeriod(currentYM);
    await this.calculateForPeriod(currentYM).catch((e) => {
      this.logger.warn(`[commissions] auto-recalc falhou: ${e.message}`);
    });

    const entries: any[] = await (this.prisma as any).commissionEntry.findMany({
      where: { sellerId },
      include: {
        period: true,
        seller: { select: { name: true } },
      },
      orderBy: { calculatedAt: 'desc' },
      take: historyMonths * 3, // ate 3 lojas por vendedora
    });

    // Agrupa por período
    const byPeriod = new Map<string, any>();
    for (const e of entries) {
      const ym = e.period.yearMonth;
      if (!byPeriod.has(ym)) {
        byPeriod.set(ym, {
          yearMonth: ym,
          status: e.period.status,
          totalVendido: 0,
          totalTrocas: 0,
          vendidoLiquido: 0,
          totalComissao: 0,
          metaAtingida: false,
          entriesByStore: [],
        });
      }
      const p = byPeriod.get(ym);
      p.totalVendido += Number(e.totalVendido);
      p.totalTrocas += Number(e.totalTrocas);
      p.vendidoLiquido += Number(e.vendidoLiquido);
      p.totalComissao += Number(e.total);
      p.metaAtingida = p.metaAtingida || e.metaAtingida;
      p.entriesByStore.push({
        storeId: e.storeId,
        vendidoLiquido: Number(e.vendidoLiquido),
        percentApplied: Number(e.percentApplied),
        comissaoBase: Number(e.comissaoBase),
        bonusValue: Number(e.bonusValue),
        total: Number(e.total),
        paidAt: e.paidAt,
      });
    }

    return {
      sellerId,
      sellerName: entries[0]?.seller?.name || null,
      currentMonth: byPeriod.get(currentYM) || null,
      history: Array.from(byPeriod.values()),
    };
  }

  // ── Relatório admin agregado ───────────────────────────────────────

  async reportPeriod(yearMonth: string) {
    const period = await this.getPeriod(yearMonth);
    if (!period) return null;

    const byStore = new Map<string, any>();
    let totalGeral = 0;

    for (const e of period.entries) {
      if (!byStore.has(e.storeId)) {
        byStore.set(e.storeId, {
          storeId: e.storeId,
          sellers: [],
          totalVendido: 0,
          totalComissao: 0,
        });
      }
      const g = byStore.get(e.storeId);
      g.sellers.push({
        sellerId: e.sellerId,
        sellerName: e.seller?.name,
        vendidoLiquido: Number(e.vendidoLiquido),
        comissaoBase: Number(e.comissaoBase),
        bonusValue: Number(e.bonusValue),
        metaAtingida: e.metaAtingida,
        total: Number(e.total),
        paidAt: e.paidAt,
      });
      g.totalVendido += Number(e.vendidoLiquido);
      g.totalComissao += Number(e.total);
      totalGeral += Number(e.total);
    }

    return {
      period: {
        yearMonth: period.yearMonth,
        status: period.status,
        startDate: period.startDate,
        endDate: period.endDate,
        closedAt: period.closedAt,
        paidAt: period.paidAt,
        totalSellers: period.totalSellers,
        totalCommission: Number(period.totalCommission),
        totalVendido: Number(period.totalVendido),
      },
      byStore: Array.from(byStore.values()).sort((a, b) => b.totalComissao - a.totalComissao),
      totalGeral,
    };
  }
}
