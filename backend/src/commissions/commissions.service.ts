import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

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
    // Mês em HORÁRIO DE BRASÍLIA (UTC-3) — no servidor (UTC) o `new Date(y,m,d)`
    // cortava o mês 3h mais cedo: venda do dia 30 à noite caía no mês seguinte.
    const startDate = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0));
    const endDate = new Date(Date.UTC(y, m, 1, 2, 59, 59, 999)); // 23:59:59.999 BRT do último dia

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
  async calculateForPeriod(
    yearMonth: string,
    opts?: { force?: boolean },
  ): Promise<{
    entries: any[];
    total: number;
    skipped: { count: number; vendido: number; sellerIds: string[] };
  }> {
    const period = await this.ensurePeriod(yearMonth);
    if (period.status === 'paid' && !opts?.force) {
      throw new BadRequestException(`Período ${yearMonth} já está PAID — não recalcula`);
    }
    if (period.status === 'paid' && opts?.force) {
      this.logger.warn(
        `[commissions] Recálculo FORÇADO de período PAID ${yearMonth} (override admin — reatribuição de vendedora). paidAt das entries é preservado.`,
      );
    }
    if (period.status === 'closed') {
      this.logger.warn(`[commissions] Recalculando período CLOSED ${yearMonth} (override admin)`);
    }

    // 1) Soma de vendas + trocas POR LOJA (pra cargo=on_responsible_store)
    //
    // NOTA: tabela real = pdv_sales / pdv_returns (@@map), colunas snake_case,
    // status finalizado = 'finalized'. Aliases voltam em camelCase pro código
    // downstream continuar lendo r.storeCode / r.sellerId / r.total.
    // NOTA (22/07): exclui paymentMethod='MARCADO' — marcação ("provar em
    // casa") não é venda; a venda real acontece quando o marcado é puxado
    // pra venda. Contar as duas dava comissão em dobro.
    const salesByStore: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT
         store_code AS "storeCode",
         COUNT(*)::int AS qtd,
         SUM(total)::float AS total
       FROM pdv_sales
       WHERE finalized_at >= $1
         AND finalized_at <= $2
         AND status = 'finalized'
         AND is_training = false
         ${CommissionsService.SEM_MARCACAO_SQL}
       GROUP BY store_code`,
      period.startDate,
      period.endDate,
    );
    // Trocas/devoluções por LOJA: TODAS as devoluções da loja no período
    // (com e sem cupom flowops), pra reduzir a base do líder/gerente.
    const trocasByStore: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode", SUM(valor_total)::float AS total
       FROM pdv_returns
       WHERE created_at >= $1 AND created_at <= $2
         AND is_training = false
       GROUP BY store_code`,
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
      `SELECT seller_id AS "sellerId", store_code AS "storeCode",
         COUNT(*)::int AS qtd,
         SUM(total)::float AS total
       FROM pdv_sales
       WHERE finalized_at >= $1
         AND finalized_at <= $2
         AND seller_id IS NOT NULL
         AND status = 'finalized'
         AND is_training = false
         ${CommissionsService.SEM_MARCACAO_SQL}
       GROUP BY seller_id, store_code`,
      period.startDate,
      period.endDate,
    );
    // Trocas/devoluções atribuídas à VENDEDORA da venda original (via
    // original_sale_id → pdv_sales.seller_id). Devolução manual sem cupom
    // (original_sale_id NULL) NÃO entra aqui — vira desconto só da loja.
    const trocasBySeller: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT s.seller_id AS "sellerId", s.store_code AS "storeCode",
         SUM(r.valor_total)::float AS total
       FROM pdv_returns r
       JOIN pdv_sales s ON s.id = r.original_sale_id
       WHERE r.created_at >= $1 AND r.created_at <= $2
         AND r.is_training = false
         AND s.seller_id IS NOT NULL
       GROUP BY s.seller_id, s.store_code`,
      period.startDate,
      period.endDate,
    );
    const stores = await this.prisma.store.findMany({ select: { id: true, code: true } });
    const storeCodeToId = new Map(stores.map((s) => [s.code, s.id]));
    const storeIdToCode = new Map(stores.map((s) => [s.id, s.code]));

    // TODOS os sellers (ativos + inativos) pra RESOLVER o seller_id da venda.
    // Ativos são usados no FLUXO 2 (líder/gerente da loja).
    const allSellersAny: any[] = await (this.prisma as any).seller.findMany({});
    const allSellers: any[] = allSellersAny.filter((s) => s.active);
    const sellersById = new Map(allSellersAny.map((s) => [s.id, s]));
    const sellersByCodigo = new Map(
      allSellersAny
        .filter((s) => s.wincredCodigo)
        .map((s) => [String(s.wincredCodigo).trim(), s]),
    );

    // Resolve o seller_id gravado na venda pra um Seller REAL.
    // Vendas antigas podem ter gravado o CÓDIGO do Giga em seller_id (fluxo
    // /pdv/sales/:id/vendedora), não o Seller.id. Sem resolver, o upsert da
    // entry estoura o FK (CommissionEntry.sellerId → Seller.id) e derruba o
    // cálculo inteiro (era o 500). Resolve por id; senão por wincredCodigo.
    const resolveSeller = (raw: any): any | null => {
      const key = String(raw ?? '').trim();
      if (!key) return null;
      return sellersById.get(key) || sellersByCodigo.get(key) || null;
    };

    // Monta sellerSalesMap JÁ keyed pelo Seller.id REAL (agrega múltiplos raw
    // ids que apontem pro mesmo Seller). O que não resolver é pulado + contado.
    const sellerSalesMap = new Map<string, { vendido: number; trocas: number; qtd: number }>();
    let skippedVendido = 0;
    const skippedSellerIds = new Set<string>();
    for (const r of salesBySeller) {
      const seller = resolveSeller(r.sellerId);
      if (!seller) {
        skippedVendido += Number(r.total) || 0;
        skippedSellerIds.add(String(r.sellerId));
        continue;
      }
      const k = `${seller.id}|${r.storeCode}`;
      const cur = sellerSalesMap.get(k) || { vendido: 0, trocas: 0, qtd: 0 };
      cur.vendido += Number(r.total) || 0;
      cur.qtd += Number(r.qtd) || 0;
      sellerSalesMap.set(k, cur);
    }
    for (const r of trocasBySeller) {
      const seller = resolveSeller(r.sellerId);
      if (!seller) continue;
      const k = `${seller.id}|${r.storeCode}`;
      const cur = sellerSalesMap.get(k) || { vendido: 0, trocas: 0, qtd: 0 };
      cur.trocas += Number(r.total) || 0;
      sellerSalesMap.set(k, cur);
    }
    if (skippedSellerIds.size > 0) {
      this.logger.warn(
        `[commissions] ${yearMonth}: ${skippedSellerIds.size} seller_id(s) sem Seller ` +
          `correspondente (R$ ${skippedVendido.toFixed(2)} não atribuídos). ` +
          `Corrija essas vendas em "Trocar vendedora". IDs: ` +
          Array.from(skippedSellerIds).slice(0, 20).join(', '),
      );
    }

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
      const seller = sellersById.get(sellerId);
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

    // === ZERA ENTRIES ÓRFÃS ===
    // Vendedora que TINHA entry nesse período mas neste recálculo ficou sem
    // vendas (ex.: a última venda dela foi reatribuída pra outra) não é tocada
    // pelos fluxos acima — sua entry antiga ficaria "fantasma". Zera o valor
    // (preserva a linha e o paidAt pra auditoria).
    const processedKeys = new Set(entries.map((e) => `${e.sellerId}|${e.storeId}`));
    const existingEntries: any[] = await (this.prisma as any).commissionEntry.findMany({
      where: { periodId: period.id },
      select: { id: true, sellerId: true, storeId: true },
    });
    for (const ex of existingEntries) {
      if (processedKeys.has(`${ex.sellerId}|${ex.storeId}`)) continue;
      await (this.prisma as any).commissionEntry.update({
        where: { id: ex.id },
        data: {
          totalVendido: 0,
          totalTrocas: 0,
          vendidoLiquido: 0,
          qtdVendas: 0,
          percentApplied: 0,
          comissaoBase: 0,
          metaAtingida: false,
          bonusValue: 0,
          total: 0,
          ruleSnapshot: {
            note: 'zerado — vendedora sem vendas no período após recálculo/reatribuição',
          },
          calculatedAt: new Date(),
        },
      });
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

    return {
      entries,
      total: totalGeral,
      skipped: {
        count: skippedSellerIds.size,
        vendido: Number(skippedVendido.toFixed(2)),
        sellerIds: Array.from(skippedSellerIds).slice(0, 50),
      },
    };
  }

  /**
   * RELATÓRIO FOLHA RH (dono 22/07) — comissão por FUNCIONÁRIA em período
   * LIVRE (De/Até + loja opcional), com detalhe venda a venda.
   *
   * MESMA matemática do calculateForPeriod (líquido = vendas − trocas, regra
   * por cargo/loja/vendedora, bônus por meta, líder/gerente sobre a loja que
   * responde) — mas SEM persistir nada: é consulta, não fechamento.
   * Só PDV com vendedora identificada (decisão do dono); o que ficou de fora
   * aparece em `semAtribuicao` pra conferência.
   */
  /** Janela do dia em HORÁRIO DE BRASÍLIA (UTC-3). O corte em UTC puro
   *  jogava venda depois das 21h pro dia seguinte (bug 22/07 — a Folha não
   *  batia com o Faturamento nem com o próprio Flow). */
  private brtRange(de: string, ate: string): { startDate: Date; endDate: Date } {
    const startDate = new Date(`${de}T03:00:00.000Z`); // 00:00 BRT
    const endDate = new Date(new Date(`${ate}T03:00:00.000Z`).getTime() + 24 * 3600 * 1000 - 1); // 23:59:59.999 BRT
    return { startDate, endDate };
  }

  /** Marcação (provar em casa) NÃO é venda: fecha com paymentMethod='MARCADO'
   *  e a venda de verdade acontece DEPOIS, quando o marcado é puxado pra
   *  venda — contar as duas seria comissão em dobro (bug 22/07). */
  private static readonly SEM_MARCACAO_SQL = `AND (payment_method IS NULL OR payment_method <> 'MARCADO')`;

  async relatorioRh(input: { de: string; ate: string; storeCode?: string }): Promise<any> {
    const de = String(input.de || '').slice(0, 10);
    const ate = String(input.ate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
      throw new BadRequestException('Período inválido — use De/Até (YYYY-MM-DD)');
    }
    const { startDate, endDate } = this.brtRange(de, ate);
    const lojaFiltro = input.storeCode ? String(input.storeCode).trim() : null;

    const storeFilterSql = lojaFiltro ? `AND store_code = $3` : '';
    const params: any[] = lojaFiltro ? [startDate, endDate, lojaFiltro] : [startDate, endDate];

    // Agregados por loja (base do líder/gerente) e por vendedora×loja
    const salesByStore: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode", COUNT(*)::int AS qtd, SUM(total)::float AS total
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND status = 'finalized' AND is_training = false
          ${CommissionsService.SEM_MARCACAO_SQL} ${storeFilterSql}
        GROUP BY store_code`,
      ...params,
    );
    const trocasByStore: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode", SUM(valor_total)::float AS total
         FROM pdv_returns
        WHERE created_at >= $1 AND created_at <= $2 AND is_training = false ${storeFilterSql}
        GROUP BY store_code`,
      ...params,
    );
    const salesBySeller: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT seller_id AS "sellerId", store_code AS "storeCode",
              COUNT(*)::int AS qtd, SUM(total)::float AS total
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND seller_id IS NOT NULL AND status = 'finalized' AND is_training = false
          ${CommissionsService.SEM_MARCACAO_SQL} ${storeFilterSql}
        GROUP BY seller_id, store_code`,
      ...params,
    );
    const trocasBySeller: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT s.seller_id AS "sellerId", s.store_code AS "storeCode",
              SUM(r.valor_total)::float AS total
         FROM pdv_returns r
         JOIN pdv_sales s ON s.id = r.original_sale_id
        WHERE r.created_at >= $1 AND r.created_at <= $2
          AND r.is_training = false AND s.seller_id IS NOT NULL
          ${lojaFiltro ? 'AND r.store_code = $3' : ''}
        GROUP BY s.seller_id, s.store_code`,
      ...params,
    );
    // Detalhe venda a venda (cascata) — cap de 20k linhas por consulta
    const vendasDetalhe: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT id, seller_id AS "sellerId", store_code AS "storeCode",
              finalized_at AS "finalizedAt", total::float AS total,
              payment_method AS "paymentMethod", customer_name AS "customerName"
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND seller_id IS NOT NULL AND status = 'finalized' AND is_training = false
          ${CommissionsService.SEM_MARCACAO_SQL} ${storeFilterSql}
        ORDER BY finalized_at
        LIMIT 20000`,
      ...params,
    );
    const trocasDetalhe: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT s.seller_id AS "sellerId", s.store_code AS "storeCode",
              r.created_at AS "createdAt", r.valor_total::float AS total
         FROM pdv_returns r
         JOIN pdv_sales s ON s.id = r.original_sale_id
        WHERE r.created_at >= $1 AND r.created_at <= $2
          AND r.is_training = false AND s.seller_id IS NOT NULL
          ${lojaFiltro ? 'AND r.store_code = $3' : ''}
        ORDER BY r.created_at
        LIMIT 20000`,
      ...params,
    );
    // Vendas SEM vendedora — ficam FORA da folha, mas o RH precisa saber
    const semVendedoraAgg: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS qtd, COALESCE(SUM(total), 0)::float AS total
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND seller_id IS NULL AND status = 'finalized' AND is_training = false
          ${CommissionsService.SEM_MARCACAO_SQL} ${storeFilterSql}`,
      ...params,
    );

    const stores = await this.prisma.store.findMany({ select: { id: true, code: true, name: true } });
    const storeCodeToId = new Map(stores.map((s) => [s.code, s.id]));
    const storeIdToCode = new Map(stores.map((s) => [s.id, s.code]));

    const allSellersAny: any[] = await (this.prisma as any).seller.findMany({});
    const sellersById = new Map(allSellersAny.map((s) => [s.id, s]));
    const sellersByCodigo = new Map(
      allSellersAny.filter((s) => s.wincredCodigo).map((s) => [String(s.wincredCodigo).trim(), s]),
    );
    const resolveSeller = (raw: any): any | null => {
      const key = String(raw ?? '').trim();
      if (!key) return null;
      return sellersById.get(key) || sellersByCodigo.get(key) || null;
    };

    const storeTotals = new Map<string, { vendido: number; trocas: number; qtd: number }>();
    for (const r of salesByStore) {
      storeTotals.set(r.storeCode, { vendido: Number(r.total) || 0, trocas: 0, qtd: Number(r.qtd) || 0 });
    }
    for (const r of trocasByStore) {
      const cur = storeTotals.get(r.storeCode) || { vendido: 0, trocas: 0, qtd: 0 };
      cur.trocas = Number(r.total) || 0;
      storeTotals.set(r.storeCode, cur);
    }

    const sellerSalesMap = new Map<string, { vendido: number; trocas: number; qtd: number }>();
    let skippedVendido = 0;
    const skippedSellerIds = new Set<string>();
    for (const r of salesBySeller) {
      const seller = resolveSeller(r.sellerId);
      if (!seller) {
        skippedVendido += Number(r.total) || 0;
        skippedSellerIds.add(String(r.sellerId));
        continue;
      }
      const k = `${seller.id}|${r.storeCode}`;
      const cur = sellerSalesMap.get(k) || { vendido: 0, trocas: 0, qtd: 0 };
      cur.vendido += Number(r.total) || 0;
      cur.qtd += Number(r.qtd) || 0;
      sellerSalesMap.set(k, cur);
    }
    for (const r of trocasBySeller) {
      const seller = resolveSeller(r.sellerId);
      if (!seller) continue;
      const k = `${seller.id}|${r.storeCode}`;
      const cur = sellerSalesMap.get(k) || { vendido: 0, trocas: 0, qtd: 0 };
      cur.trocas += Number(r.total) || 0;
      sellerSalesMap.set(k, cur);
    }

    // Detalhe agrupado por vendedora REAL
    const vendasPorSeller = new Map<string, any[]>();
    for (const v of vendasDetalhe) {
      const seller = resolveSeller(v.sellerId);
      if (!seller) continue;
      if (!vendasPorSeller.has(seller.id)) vendasPorSeller.set(seller.id, []);
      vendasPorSeller.get(seller.id)!.push(v);
    }
    const trocasPorSeller = new Map<string, any[]>();
    for (const t of trocasDetalhe) {
      const seller = resolveSeller(t.sellerId);
      if (!seller) continue;
      if (!trocasPorSeller.has(seller.id)) trocasPorSeller.set(seller.id, []);
      trocasPorSeller.get(seller.id)!.push(t);
    }

    // Uma "linha de cálculo" por vendedora×loja — MESMA regra do fechamento
    type Linha = {
      sellerId: string; storeCode: string; cargo: string; calcMode: string;
      totalVendido: number; totalTrocas: number; vendidoLiquido: number; qtdVendas: number;
      percentApplied: number; comissaoBase: number;
      metaValue: number | null; metaAtingida: boolean; bonusPercent: number | null; bonusValue: number;
      total: number; semRegra: boolean;
    };
    const linhas: Linha[] = [];

    const calcular = async (sellerId: string, cargo: string, storeCode: string) => {
      const storeId = storeCodeToId.get(storeCode);
      if (!storeId) return;
      const rule = await this.resolveRuleFor(sellerId, storeId, cargo, endDate);
      const calcMode = rule?.calcMode || 'on_self';
      let totalVendido = 0, totalTrocas = 0, qtdVendas = 0;
      if (calcMode === 'on_responsible_store') {
        const st = storeTotals.get(storeCode);
        if (!st) return;
        totalVendido = st.vendido; totalTrocas = st.trocas; qtdVendas = st.qtd;
      } else {
        const sl = sellerSalesMap.get(`${sellerId}|${storeCode}`);
        if (!sl) return;
        totalVendido = sl.vendido; totalTrocas = sl.trocas; qtdVendas = sl.qtd;
      }
      const vendidoLiquido = Math.max(0, totalVendido - totalTrocas);
      let percentApplied = 0, comissaoBase = 0, bonusValue = 0;
      let metaAtingida = false;
      let metaValue: number | null = null, bonusPercent: number | null = null;
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
      }
      linhas.push({
        sellerId, storeCode, cargo, calcMode,
        totalVendido, totalTrocas, vendidoLiquido, qtdVendas,
        percentApplied, comissaoBase, metaValue, metaAtingida, bonusPercent, bonusValue,
        total: comissaoBase + bonusValue, semRegra: !rule,
      });
    };

    // Fluxo 1: vendedoras/caixa (on_self) por loja onde venderam
    for (const [key] of sellerSalesMap) {
      const [sellerId, storeCode] = key.split('|');
      const seller = sellersById.get(sellerId);
      const cargo = seller?.cargo || 'VENDEDORA';
      if (cargo !== 'VENDEDORA' && cargo !== 'CAIXA') continue;
      await calcular(sellerId, cargo, storeCode);
    }
    // Fluxo 2: líderes/gerentes pela loja responsável
    for (const seller of allSellersAny.filter((s) => s.active)) {
      const cargo = seller.cargo || 'VENDEDORA';
      if (cargo === 'VENDEDORA' || cargo === 'CAIXA') continue;
      if (!seller.responsibleStoreId) continue;
      const storeCode = storeIdToCode.get(seller.responsibleStoreId);
      if (!storeCode) continue;
      if (lojaFiltro && storeCode !== lojaFiltro) continue;
      await calcular(seller.id, cargo, storeCode);
    }

    // Consolida POR FUNCIONÁRIA (soma as lojas onde vendeu)
    const porFunc = new Map<string, any>();
    for (const l of linhas) {
      const seller = sellersById.get(l.sellerId);
      let f = porFunc.get(l.sellerId);
      if (!f) {
        f = {
          sellerId: l.sellerId,
          nome: seller?.name || '(vendedora removida)',
          cargo: l.cargo,
          ativa: !!seller?.active,
          lojas: [],
          totalVendido: 0, totalTrocas: 0, vendidoLiquido: 0, qtdVendas: 0,
          comissaoBase: 0, bonusValue: 0, total: 0,
          linhas: [], vendas: [], trocas: [],
          semRegra: false,
        };
        porFunc.set(l.sellerId, f);
      }
      if (!f.lojas.includes(l.storeCode)) f.lojas.push(l.storeCode);
      f.totalVendido += l.totalVendido;
      f.totalTrocas += l.totalTrocas;
      f.vendidoLiquido += l.vendidoLiquido;
      f.qtdVendas += l.qtdVendas;
      f.comissaoBase += l.comissaoBase;
      f.bonusValue += l.bonusValue;
      f.total += l.total;
      f.semRegra = f.semRegra || l.semRegra;
      f.linhas.push(l);
    }
    // Cascata: vendas próprias (só faz sentido pra on_self; líder/gerente vê
    // a linha da loja no breakdown `linhas`)
    for (const [sellerId, f] of porFunc) {
      const vendas = vendasPorSeller.get(sellerId) || [];
      const percentDe = (storeCode: string) =>
        f.linhas.find((l: Linha) => l.storeCode === storeCode && l.calcMode !== 'on_responsible_store')?.percentApplied ?? 0;
      f.vendas = vendas.map((v: any) => ({
        id: v.id,
        data: v.finalizedAt,
        loja: v.storeCode,
        cliente: v.customerName || null,
        pagamento: v.paymentMethod || null,
        valor: Number(v.total) || 0,
        percent: percentDe(v.storeCode),
        comissao: Math.round(((Number(v.total) || 0) * percentDe(v.storeCode)) / 100 * 100) / 100,
      }));
      f.trocas = (trocasPorSeller.get(sellerId) || []).map((t: any) => ({
        data: t.createdAt, loja: t.storeCode, valor: Number(t.total) || 0,
      }));
    }

    const funcionarias = Array.from(porFunc.values())
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const round2 = (n: number) => Math.round(n * 100) / 100;
    for (const f of funcionarias) {
      f.totalVendido = round2(f.totalVendido);
      f.totalTrocas = round2(f.totalTrocas);
      f.vendidoLiquido = round2(f.vendidoLiquido);
      f.comissaoBase = round2(f.comissaoBase);
      f.bonusValue = round2(f.bonusValue);
      f.total = round2(f.total);
    }

    return {
      de, ate, loja: lojaFiltro,
      funcionarias,
      totais: {
        funcionarias: funcionarias.length,
        vendidoLiquido: round2(funcionarias.reduce((s, f) => s + f.vendidoLiquido, 0)),
        comissao: round2(funcionarias.reduce((s, f) => s + f.total, 0)),
      },
      semAtribuicao: {
        semVendedoraQtd: Number(semVendedoraAgg[0]?.qtd) || 0,
        semVendedoraValor: round2(Number(semVendedoraAgg[0]?.total) || 0),
        naoCadastradaQtd: skippedSellerIds.size,
        naoCadastradaValor: round2(skippedVendido),
      },
    };
  }

  /**
   * CONFERÊNCIA Flow × Wincred (22/07): o ranking do Wincred lê a CAIXA do
   * Giga, que tem as vendas do Flow (replicadas via outbox) E vendas que só
   * existem lá — principalmente MARCADO fechado na tela do Wincred (a linha
   * vira venda sem nunca passar pelo PDV do Flow) e lançamento manual.
   * Compara vendedora a vendedora pro RH ver EXATAMENTE onde está a diferença.
   *
   * Exige LOJA (query na caixa filtrada por LOJA+DATA — sem full scan).
   * Marcados ativos (MARCADO='SIM') ficam FORA dos dois lados (reserva ≠ venda).
   */
  async relatorioRhConferencia(input: { de: string; ate: string; storeCode: string }): Promise<any> {
    const de = String(input.de || '').slice(0, 10);
    const ate = String(input.ate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
      throw new BadRequestException('Período inválido — use De/Até (YYYY-MM-DD)');
    }
    const loja = String(input.storeCode || '').replace(/\D/g, '').padStart(2, '0');
    if (!loja || loja === '00') {
      throw new BadRequestException('Escolha UMA loja pra conferir com o Wincred');
    }

    // Lado GIGA: caixa por VENDEDOR (mesma base do ranking do Wincred).
    // Teto duro de 20s no app — se o Giga pendurar, responde com erro claro.
    // DATAFEC (data de FECHAMENTO do cupom) — é o que as telas do Wincred
    // usam; filtrar por DATA deixava cupom fechado no dia seguinte de fora.
    const p = this.erp.runReadOnly(
      `SELECT VENDEDOR, COUNT(*) AS qtd, COALESCE(SUM(VALORTOTAL), 0) AS total
         FROM caixa
        WHERE LOJA = '${loja}'
          AND DATAFEC >= '${de}' AND DATAFEC <= '${ate}'
          AND UPPER(COALESCE(MARCADO, '')) <> 'SIM'
        GROUP BY VENDEDOR`,
      { maxRows: 500, timeoutMs: 15000 },
    );
    const giga: any = await Promise.race([
      p.catch((e: any) => ({ __erro: e?.message || 'falha' })),
      new Promise((res) => setTimeout(res, 20000, { __erro: 'Giga não respondeu em 20s' })),
    ]);
    if ((giga as any).__erro) {
      return { ok: false, error: `Wincred indisponível pra conferência: ${(giga as any).__erro}` };
    }

    // Lado FLOW: pdv_sales por vendedora na mesma janela/loja (dia em BRT,
    // sem marcação — mesmos critérios da Folha)
    const { startDate, endDate } = this.brtRange(de, ate);
    const flowRows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT seller_id AS "sellerId", COUNT(*)::int AS qtd, SUM(total)::float AS total
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND status = 'finalized' AND is_training = false AND store_code = $3
          ${CommissionsService.SEM_MARCACAO_SQL}
        GROUP BY seller_id`,
      startDate, endDate, loja,
    );

    const allSellers: any[] = await (this.prisma as any).seller.findMany({});
    const sellersById = new Map(allSellers.map((s) => [s.id, s]));
    const sellersByCodigo = new Map(
      allSellers.filter((s) => s.wincredCodigo).map((s) => [String(Number(s.wincredCodigo)), s]),
    );

    // Consolida por "pessoa": chave = codigo Wincred quando existe, senão nome
    type Comp = { nome: string; codigoWincred: string | null; wincredQtd: number; wincredTotal: number; flowQtd: number; flowTotal: number };
    const porChave = new Map<string, Comp>();
    const chaveDe = (codigo: string | null, nome: string) => codigo ? `cod:${codigo}` : `nome:${nome}`;

    for (const r of (giga.rows || [])) {
      const codigo = r.VENDEDOR != null ? String(Number(r.VENDEDOR)) : '0';
      const seller = sellersByCodigo.get(codigo);
      const nome = seller?.name || (codigo === '0' ? '(sem vendedora no Wincred)' : `VENDEDOR cód ${codigo}`);
      const k = chaveDe(codigo, nome);
      const c = porChave.get(k) || { nome, codigoWincred: codigo, wincredQtd: 0, wincredTotal: 0, flowQtd: 0, flowTotal: 0 };
      c.wincredQtd += Number(r.qtd) || 0;
      c.wincredTotal += Number(r.total) || 0;
      porChave.set(k, c);
    }
    for (const r of flowRows) {
      const seller = r.sellerId ? (sellersById.get(String(r.sellerId).trim()) || sellersByCodigo.get(String(Number(r.sellerId)) || '')) : null;
      const codigo = seller?.wincredCodigo ? String(Number(seller.wincredCodigo)) : null;
      const nome = seller?.name || (r.sellerId ? `seller ${String(r.sellerId).slice(0, 8)}…` : '(sem vendedora no Flow)');
      const k = chaveDe(codigo, nome);
      const c = porChave.get(k) || { nome, codigoWincred: codigo, wincredQtd: 0, wincredTotal: 0, flowQtd: 0, flowTotal: 0 };
      c.flowQtd += Number(r.qtd) || 0;
      c.flowTotal += Number(r.total) || 0;
      porChave.set(k, c);
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const linhas = Array.from(porChave.values())
      .map((c) => ({
        ...c,
        wincredTotal: round2(c.wincredTotal),
        flowTotal: round2(c.flowTotal),
        diferenca: round2(c.wincredTotal - c.flowTotal),
      }))
      .sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca));

    return {
      ok: true,
      de, ate, loja,
      linhas,
      totais: {
        wincred: round2(linhas.reduce((s, l) => s + l.wincredTotal, 0)),
        flow: round2(linhas.reduce((s, l) => s + l.flowTotal, 0)),
        diferenca: round2(linhas.reduce((s, l) => s + l.diferenca, 0)),
      },
      nota: 'Diferença positiva = venda que só existe na caixa do Wincred (marcado fechado por lá, venda manual, ou data divergente — linha de marcado fechado mantém a DATA da marcação).',
    };
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

  // ── Troca de vendedora numa venda (correção estilo Giga) ────────────

  /**
   * Lista as vendas FINALIZADAS num intervalo de datas LIVRE (De/Até),
   * opcionalmente de uma loja — pra admin trocar a vendedora, equivalente à
   * tela "Vendas" do Giga. Sem treino. Ordenado da mais recente pra mais antiga.
   *
   * from/to no formato 'YYYY-MM-DD'. Default = mês corrente (1º dia → hoje).
   */
  async listSalesForReassign(input: {
    from?: string | null;
    to?: string | null;
    storeCode?: string | null;
    sellerId?: string | null;
    q?: string | null;
    limit?: number;
  }) {
    const isDate = (s?: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (input.from && !isDate(input.from)) {
      throw new BadRequestException('from inválido (formato YYYY-MM-DD)');
    }
    if (input.to && !isDate(input.to)) {
      throw new BadRequestException('to inválido (formato YYYY-MM-DD)');
    }
    const now = new Date();
    const mk = (s: string, end: boolean) => {
      const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
      return new Date(y, m - 1, d, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0);
    };
    const startDate = input.from
      ? mk(input.from, false)
      : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    const endDate = input.to
      ? mk(input.to, true)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    if (startDate > endDate) {
      throw new BadRequestException('Data inicial não pode ser maior que a final');
    }

    const where: any = {
      status: 'finalized',
      isTraining: false,
      finalizedAt: { gte: startDate, lte: endDate },
    };
    if (input.storeCode) where.storeCode = input.storeCode;
    if (input.sellerId === 'none') where.sellerId = null;
    else if (input.sellerId) where.sellerId = input.sellerId;
    if (input.q && input.q.trim()) {
      const q = input.q.trim();
      where.OR = [
        { customerName: { contains: q, mode: 'insensitive' } },
        { nfceNumber: { contains: q } },
        { id: { contains: q } },
      ];
    }

    const sales = await (this.prisma as any).pdvSale.findMany({
      where,
      select: {
        id: true,
        finalizedAt: true,
        total: true,
        status: true,
        storeCode: true,
        storeName: true,
        sellerId: true,
        sellerName: true,
        vendedorName: true,
        customerName: true,
        nfceNumber: true,
        paymentMethod: true,
      },
      orderBy: { finalizedAt: 'desc' },
      take: Math.min(input.limit ?? 300, 1000),
    });
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { from: fmt(startDate), to: fmt(endDate), count: sales.length, sales };
  }

  /**
   * Reatribui a vendedora de UMA venda (mesmo já finalizada / período fechado
   * ou pago — admin manda) e recalcula o período afetado com force=true.
   * Grava o Seller.id (o que o motor de comissão usa como chave).
   */
  async reassignSaleSeller(input: {
    saleId: string;
    newSellerId: string;
    userId?: string;
  }) {
    if (!input.newSellerId) throw new BadRequestException('sellerId obrigatório');

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: input.saleId },
      select: {
        id: true,
        finalizedAt: true,
        createdAt: true,
        sellerId: true,
        sellerName: true,
        storeCode: true,
        status: true,
      },
    });
    if (!sale) throw new NotFoundException('Venda não encontrada');

    const seller = await (this.prisma as any).seller.findUnique({
      where: { id: input.newSellerId },
      select: { id: true, name: true, active: true },
    });
    if (!seller) throw new BadRequestException('Vendedora não encontrada');

    const before = { sellerId: sale.sellerId, sellerName: sale.sellerName };

    await (this.prisma as any).pdvSale.update({
      where: { id: input.saleId },
      data: { sellerId: seller.id, sellerName: seller.name },
    });

    // Recalcula o período em que a venda caiu (força — admin pode em qualquer
    // status, inclusive PAID; o paidAt das entries é preservado no upsert).
    const ref: Date = sale.finalizedAt || sale.createdAt || new Date();
    const yearMonth = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;
    let recalc: any = null;
    try {
      const r = await this.calculateForPeriod(yearMonth, { force: true });
      recalc = { yearMonth, entries: r.entries.length, total: r.total };
    } catch (e: any) {
      this.logger.error(
        `[commissions] recalc pós-reassign falhou (${yearMonth}): ${e.message}`,
      );
      recalc = { yearMonth, error: e.message };
    }

    this.logger.log(
      `[commissions] Venda ${input.saleId} reatribuída de "${before.sellerName || '—'}" → "${seller.name}" (por ${input.userId || '?'})`,
    );

    return {
      ok: true,
      saleId: input.saleId,
      before,
      after: { sellerId: seller.id, sellerName: seller.name },
      sellerInactive: !seller.active,
      recalc,
    };
  }
}
