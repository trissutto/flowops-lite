import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * CommissionEngine — MOTOR ÚNICO dos indicadores da venda.
 *
 * DECISÃO OFICIAL DE ARQUITETURA (dono, 29/07/2026): uma venda tem TRÊS
 * indicadores INDEPENDENTES que nunca compartilham o mesmo campo:
 *
 *   FATURAMENTO      = valor dos produtos vendidos (vale-troca NUNCA reduz)
 *   RECEBIMENTO      = dinheiro que entrou (total − vale/créditos)
 *   BASE DE COMISSÃO = produtos − descontos − vale − frete − devoluções − cancelamentos
 *
 * Exemplo canônico: produtos 500, vale 300, PIX 200 →
 *   faturamento 500 · recebimento 200 · baseComissao 200.
 *
 * Objeto canônico por linha (vendedora×loja ou loja):
 *   { valorProdutos, valorDesconto, faturamento, valorValeTroca, valorFrete,
 *     valorRecebido, devolucoesDinheiro, valorBaseComissao }
 *   + aplicarRegra(rule, base) → { percentual, valorComissao, ... }
 *
 * É PROIBIDO qualquer tela/módulo recalcular comissão por fora ou usar
 * `total`/bruto/pago como base — só `valorBaseComissao` deste serviço.
 * (Auditoria 29/07 achou 12 cálculos divergentes em 6 arquivos; este serviço
 * substitui todos.)
 */
@Injectable()
export class CommissionEngineService {
  private readonly logger = new Logger(CommissionEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Fragmentos canônicos (a ÚNICA definição dos filtros) ────────────

  /** Marcação (provar em casa) NÃO existe financeiramente até virar venda. */
  static readonly SEM_MARCACAO_SQL = `AND (payment_method IS NULL OR payment_method <> 'MARCADO')`;

  /**
   * Vale-troca usado NA venda. O PDV grava 'vale_troca', mas o resto do
   * sistema (caixa/NFC-e) reconhece 'vale' e 'troca' como sinônimos — a
   * comparação exata deixava crédito sem abater (auditoria 29/07).
   */
  static readonly VALE_JOIN_SQL = `
    LEFT JOIN (
      SELECT sale_id, SUM(valor)::float AS vale
        FROM pdv_sale_payments
       WHERE LOWER(TRIM(method)) IN ('vale_troca', 'vale', 'troca')
       GROUP BY sale_id
    ) vt ON vt.sale_id = s.id`;

  /** FRETE é receita da loja mas não comissiona nem é "produto". */
  static readonly FRETE_JOIN_SQL = `
    LEFT JOIN (
      SELECT sale_id, SUM(total)::float AS frete
        FROM pdv_sale_items
       WHERE ref = 'FRETE'
       GROUP BY sale_id
    ) fr ON fr.sale_id = s.id`;

  /** Peças + desconto por item (sem FRETE) — pra abrir valorProdutos/Desconto. */
  static readonly ITENS_JOIN_SQL = `
    LEFT JOIN (
      SELECT sale_id,
             SUM(CASE WHEN COALESCE(ref, '') <> 'FRETE' THEN qty ELSE 0 END)::float AS pecas,
             SUM(CASE WHEN COALESCE(ref, '') <> 'FRETE' THEN COALESCE(desconto, 0) ELSE 0 END)::float AS desc_itens
        FROM pdv_sale_items
       GROUP BY sale_id
    ) it ON it.sale_id = s.id`;

  /**
   * Devolução que abate a base: SÓ dinheiro/pix (troca/crédito viram vale e
   * abatem quando o vale é USADO) e NÃO cancelada (devolução anulada
   * continuava descontando — auditoria 29/07).
   */
  static readonly DEVOLUCAO_ABATE_SQL = `AND modo IN ('dinheiro', 'pix') AND COALESCE(status, '') <> 'cancelled'`;
  /** Mesma regra com alias r. (queries com JOIN). */
  static readonly DEVOLUCAO_ABATE_R_SQL = `AND r.modo IN ('dinheiro', 'pix') AND COALESCE(r.status, '') <> 'cancelled'`;

  private static readonly VENDA_VALIDA_SQL = `
       WHERE finalized_at >= $1 AND finalized_at <= $2
         AND status = 'finalized'
         AND is_training = false
         ${CommissionEngineService.SEM_MARCACAO_SQL}`;

  /** Colunas do objeto canônico (compartilhadas pelas 2 agregações). */
  private static readonly COLUNAS_SQL = `
         COUNT(*)::int AS qtd,
         COALESCE(SUM(it.pecas), 0)::float AS pecas,
         SUM(s.total)::float AS faturamento,
         SUM(COALESCE(s.desconto, 0) + COALESCE(it.desc_itens, 0))::float AS "valorDesconto",
         SUM(s.total - COALESCE(fr.frete, 0) + COALESCE(s.desconto, 0) + COALESCE(it.desc_itens, 0))::float AS "valorProdutos",
         SUM(COALESCE(vt.vale, 0))::float AS "valorValeTroca",
         SUM(COALESCE(fr.frete, 0))::float AS "valorFrete",
         SUM(s.total - COALESCE(vt.vale, 0))::float AS "valorRecebido"`;

  private static readonly JOINS_SQL = `${CommissionEngineService.VALE_JOIN_SQL}
       ${CommissionEngineService.FRETE_JOIN_SQL}
       ${CommissionEngineService.ITENS_JOIN_SQL}`;

  // ── Agregações canônicas ────────────────────────────────────────────

  /**
   * Status de Order que contam como venda. MESMA lista do FaturamentoService —
   * se as duas divergirem, faturamento e comissão param de bater.
   */
  private static readonly ORDER_STATUSES_VENDA = [
    'processing', 'routing', 'awaiting_stock', 'separating',
    'ready', 'shipped', 'delivered', 'completed',
  ];

  /**
   * Fichas de CANAL (decisão do dono, 01/08). A loja 13 mistura três negócios
   * e ele quer os três identificados na folha, não somados nem sumidos:
   *   LIVE → o que vem da tela da live
   *   SITE → o que vem 100% do WooCommerce (cliente comprou sozinha)
   * O terceiro é a venda de WhatsApp (Karine, Manu, Grazi), que já entra como
   * venda normal do PDV na loja 13 e vai pra ficha de cada uma.
   *
   * ⚠️ Estas duas fichas caem na regra global de 2% como qualquer vendedora.
   * Se a intenção for NÃO pagar comissão sobre elas, criar regra de 0% pra
   * cada uma na aba Regras — o motor respeita regra por vendedora.
   */
  static readonly SELLER_LIVE = 'LIVE';
  static readonly SELLER_SITE = 'SITE';

  /**
   * VENDA DO SITE E DA LIVE — vive na tabela `orders`, não em `pdv_sales`
   * (01/08). O motor lia só o PDV, então em julho R$ 104.910,43 de site+live
   * não geravam comissão pra ninguém: 279 pedidos de WooCommerce e 204 da
   * live. Decisão do dono:
   *   - `source='live'`  → tudo vai pra ficha "LIVE"
   *   - `source='site'` COM vendedora atribuída → vai pra ela (é venda de
   *     WhatsApp que a menina lançou pelo site em vez do PDV)
   *   - `source='site'` SEM vendedora → ninguém (é WooCommerce orgânico, a
   *     cliente comprou sozinha; não existe vendedora pra pagar)
   *
   * Valor = SÓ ITENS (quantidade × preço), sem frete — mesmo critério do
   * faturamento e da comissão do PDV, onde frete também não comissiona.
   */
  async porVendedoraOrders(
    start: Date,
    end: Date,
    storeCode?: string | null,
  ): Promise<Array<{ sellerId: string | null; sellerName: string | null; storeCode: string; qtd: number; total: number; origem: string }>> {
    // O site é a loja 13 no cadastro. Se a folha estiver filtrada por outra
    // loja, orders não entra.
    const lojaSite = await this.prisma.store
      .findFirst({ where: { OR: [{ name: 'SITE' }, { code: 'SITE' }] }, select: { code: true } })
      .catch(() => null);
    const code = lojaSite?.code || '13';
    if (storeCode && storeCode !== code) return [];

    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT o.source AS origem,
              o.seller_id AS "sellerId",
              o.seller_name AS "sellerName",
              COUNT(DISTINCT o.id)::int AS qtd,
              COALESCE(SUM(i.quantity * i.unit_price), 0)::float8 AS total
         FROM orders o
         JOIN order_items i ON i.order_id = o.id
        WHERE o.wc_date_created >= $1 AND o.wc_date_created < $2
          AND o.status = ANY($3)
        GROUP BY o.source, o.seller_id, o.seller_name`,
      start, end, CommissionEngineService.ORDER_STATUSES_VENDA,
    );

    return rows.map((r) => {
      const ehLive = String(r.origem) === 'live';
      // Site COM vendedora = venda de WhatsApp lançada pelo site → é dela.
      // Site SEM vendedora = WooCommerce puro → ficha de canal SITE.
      const canal = ehLive
        ? CommissionEngineService.SELLER_LIVE
        : (r.sellerId ? null : CommissionEngineService.SELLER_SITE);
      return {
        sellerId: canal ? null : r.sellerId,
        sellerName: canal || r.sellerName,
        storeCode: code,
        qtd: Number(r.qtd) || 0,
        total: Number(r.total) || 0,
        origem: String(r.origem),
      };
    });
  }

  /**
   * Indicadores por VENDEDORA×LOJA (seller_id cru — resolver no consumidor).
   *
   * `sellerName` vai junto de propósito (01/08): o `seller_id` gravado na venda
   * as vezes e o CODIGO do Wincred, que e numerado POR LOJA — e o codigo 25 de
   * Campinas nao e a mesma pessoa que o 25 de Santos. O nome gravado NA VENDA e
   * o desempate confiavel, porque foi escrito no momento em que a venda saiu.
   * Ver resolveSeller em commissions.service.ts.
   */
  async porVendedora(start: Date, end: Date, storeCode?: string | null): Promise<any[]> {
    const extra = storeCode ? `AND store_code = $3` : '';
    const params: any[] = storeCode ? [start, end, storeCode] : [start, end];
    return this.prisma.$queryRawUnsafe(
      `SELECT seller_id AS "sellerId", store_code AS "storeCode",
              seller_name AS "sellerName",
         ${CommissionEngineService.COLUNAS_SQL}
       FROM pdv_sales s
       ${CommissionEngineService.JOINS_SQL}
       ${CommissionEngineService.VENDA_VALIDA_SQL}
         AND seller_id IS NOT NULL
         ${extra}
       GROUP BY seller_id, store_code, seller_name`,
      ...params,
    );
  }

  /** Indicadores por LOJA (inclui vendas sem vendedora — base de líder/gerente). */
  async porLoja(start: Date, end: Date, storeCode?: string | null): Promise<any[]> {
    const extra = storeCode ? `AND store_code = $3` : '';
    const params: any[] = storeCode ? [start, end, storeCode] : [start, end];
    return this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode",
         ${CommissionEngineService.COLUNAS_SQL}
       FROM pdv_sales s
       ${CommissionEngineService.JOINS_SQL}
       ${CommissionEngineService.VENDA_VALIDA_SQL}
         ${extra}
       GROUP BY store_code`,
      ...params,
    );
  }

  /** Devoluções em dinheiro/pix atribuídas à VENDEDORA da venda original. */
  async devolucoesPorVendedora(start: Date, end: Date, storeCode?: string | null): Promise<any[]> {
    const extra = storeCode ? `AND r.store_code = $3` : '';
    const params: any[] = storeCode ? [start, end, storeCode] : [start, end];
    return this.prisma.$queryRawUnsafe(
      `SELECT s.seller_id AS "sellerId", s.store_code AS "storeCode",
              s.seller_name AS "sellerName",
              SUM(r.valor_total)::float AS total
         FROM pdv_returns r
         JOIN pdv_sales s ON s.id = r.original_sale_id
        WHERE r.created_at >= $1 AND r.created_at <= $2
          AND r.is_training = false
          AND s.seller_id IS NOT NULL
          ${CommissionEngineService.DEVOLUCAO_ABATE_R_SQL}
          ${extra}
        GROUP BY s.seller_id, s.store_code, s.seller_name`,
      ...params,
    );
  }

  /** Devoluções em dinheiro/pix por LOJA (inclui manual sem cupom). */
  async devolucoesPorLoja(start: Date, end: Date, storeCode?: string | null): Promise<any[]> {
    const extra = storeCode ? `AND store_code = $3` : '';
    const params: any[] = storeCode ? [start, end, storeCode] : [start, end];
    return this.prisma.$queryRawUnsafe(
      `SELECT store_code AS "storeCode", SUM(valor_total)::float AS total
         FROM pdv_returns
        WHERE created_at >= $1 AND created_at <= $2
          AND is_training = false
          ${CommissionEngineService.DEVOLUCAO_ABATE_SQL}
          ${extra}
        GROUP BY store_code`,
      ...params,
    );
  }

  /** Detalhe venda a venda (cascata da Folha) com os indicadores por venda. */
  async vendasDetalhe(start: Date, end: Date, storeCode?: string | null, limit = 20000): Promise<any[]> {
    const extra = storeCode ? `AND store_code = $3` : '';
    const params: any[] = storeCode ? [start, end, storeCode] : [start, end];
    return this.prisma.$queryRawUnsafe(
      `SELECT id, seller_id AS "sellerId", store_code AS "storeCode",
              seller_name AS "sellerName",
              finalized_at AS "finalizedAt", total::float AS total,
              COALESCE(vt.vale, 0)::float AS vale,
              COALESCE(fr.frete, 0)::float AS frete,
              payment_method AS "paymentMethod", customer_name AS "customerName"
         FROM pdv_sales s
         ${CommissionEngineService.VALE_JOIN_SQL}
         ${CommissionEngineService.FRETE_JOIN_SQL}
       ${CommissionEngineService.VENDA_VALIDA_SQL}
         AND seller_id IS NOT NULL
         ${extra}
        ORDER BY finalized_at
        LIMIT ${Math.max(1, Math.floor(limit))}`,
      ...params,
    );
  }

  /** Detalhe das devoluções que abatem (pra cascata). */
  async devolucoesDetalhe(start: Date, end: Date, storeCode?: string | null, limit = 20000): Promise<any[]> {
    const extra = storeCode ? `AND r.store_code = $3` : '';
    const params: any[] = storeCode ? [start, end, storeCode] : [start, end];
    return this.prisma.$queryRawUnsafe(
      `SELECT s.seller_id AS "sellerId", s.store_code AS "storeCode",
              s.seller_name AS "sellerName",
              r.created_at AS "createdAt", r.valor_total::float AS total
         FROM pdv_returns r
         JOIN pdv_sales s ON s.id = r.original_sale_id
        WHERE r.created_at >= $1 AND r.created_at <= $2
          AND r.is_training = false
          AND s.seller_id IS NOT NULL
          ${CommissionEngineService.DEVOLUCAO_ABATE_R_SQL}
          ${extra}
        ORDER BY r.created_at
        LIMIT ${Math.max(1, Math.floor(limit))}`,
      ...params,
    );
  }

  /** Vendas SEM vendedora (ficam fora da folha; RH precisa enxergar). */
  async semVendedora(start: Date, end: Date, storeCode?: string | null): Promise<{ qtd: number; total: number }> {
    const extra = storeCode ? `AND store_code = $3` : '';
    const params: any[] = storeCode ? [start, end, storeCode] : [start, end];
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS qtd, COALESCE(SUM(total), 0)::float AS total
         FROM pdv_sales
        WHERE finalized_at >= $1 AND finalized_at <= $2
          AND seller_id IS NULL AND status = 'finalized' AND is_training = false
          ${CommissionEngineService.SEM_MARCACAO_SQL} ${extra}`,
      ...params,
    );
    return { qtd: Number(rows[0]?.qtd) || 0, total: Number(rows[0]?.total) || 0 };
  }

  // ── Regras e percentual ─────────────────────────────────────────────

  /**
   * Resolve qual regra aplicar pra uma vendedora numa loja.
   * Hierarquia: seller > cargo > store > global (movido do CommissionsService
   * — o motor é o único dono do percentual).
   */
  async resolveRuleFor(sellerId: string, storeId: string, cargo: string, refDate: Date): Promise<any | null> {
    const where = (extra: any) => ({
      active: true,
      validFrom: { lte: refDate },
      OR: [{ validTo: null }, { validTo: { gte: refDate } }],
      ...extra,
    });
    let r = await (this.prisma as any).commissionRule.findFirst({
      where: where({ scope: 'seller', sellerId }),
      orderBy: { validFrom: 'desc' },
    });
    if (r) return r;
    r = await (this.prisma as any).commissionRule.findFirst({
      where: where({ scope: 'cargo', cargo }),
      orderBy: { validFrom: 'desc' },
    });
    if (r) return r;
    r = await (this.prisma as any).commissionRule.findFirst({
      where: where({ scope: 'store', storeId }),
      orderBy: { validFrom: 'desc' },
    });
    if (r) return r;
    return (this.prisma as any).commissionRule.findFirst({
      where: where({ scope: 'global' }),
      orderBy: { validFrom: 'desc' },
    });
  }

  /**
   * A ÚNICA fórmula de comissão do sistema:
   *   comissaoBase = base × percentBase; bônus se base >= meta.
   */
  aplicarRegra(rule: any | null, valorBaseComissao: number): {
    percentual: number;
    comissaoBase: number;
    metaValue: number | null;
    metaAtingida: boolean;
    bonusPercent: number | null;
    bonusValue: number;
    valorComissao: number;
  } {
    let percentual = 0;
    let comissaoBase = 0;
    let metaValue: number | null = null;
    let metaAtingida = false;
    let bonusPercent: number | null = null;
    let bonusValue = 0;
    if (rule) {
      percentual = Number(rule.percentBase) || 0;
      comissaoBase = (valorBaseComissao * percentual) / 100;
      if (rule.meta != null && rule.bonusPercent != null) {
        metaValue = Number(rule.meta);
        bonusPercent = Number(rule.bonusPercent);
        if (valorBaseComissao >= metaValue) {
          metaAtingida = true;
          bonusValue = (valorBaseComissao * bonusPercent) / 100;
        }
      }
    }
    return {
      percentual,
      comissaoBase,
      metaValue,
      metaAtingida,
      bonusPercent,
      bonusValue,
      valorComissao: comissaoBase + bonusValue,
    };
  }

  // ── Ranking pra dashboards (substitui o 2% hardcoded da inteligência) ──

  /**
   * Ranking de vendedoras pelos indicadores OFICIAIS (fonte PdvSale, não o
   * caixa do Giga): `valor` = FATURAMENTO (vale não reduz — decisão 29/07) e
   * `comissao` = valorBaseComissao × regra REAL da vendedora.
   * Shape compatível com o antigo erp.getTopVendedoras ({codigo, nome, pecas,
   * valor, vendas, ticketMedio, comissao}).
   */
  async rankingVendedoras(input: { inicio: Date; fim: Date; storeCode?: string | null; limit?: number }): Promise<any[]> {
    const limit = input.limit || 10;
    // PdvSale.storeCode pode guardar o code ('06') ou o nome ('SOROCABA') —
    // resolve os dois pelo cadastro e filtra em JS (volume por período é baixo).
    let aliases: Set<string> | null = null;
    if (input.storeCode) {
      const q = String(input.storeCode).trim().toUpperCase();
      const stores = await this.prisma.store.findMany({ select: { code: true, name: true } });
      const hit = stores.find(
        (s: any) => String(s.code).trim().toUpperCase() === q || String(s.name || '').trim().toUpperCase() === q,
      );
      aliases = new Set([q]);
      if (hit) {
        aliases.add(String(hit.code).trim().toUpperCase());
        if (hit.name) aliases.add(String(hit.name).trim().toUpperCase());
      }
    }

    const [rows, devs] = await Promise.all([
      this.porVendedora(input.inicio, input.fim),
      this.devolucoesPorVendedora(input.inicio, input.fim),
    ]);
    const filtra = (r: any) => !aliases || aliases.has(String(r.storeCode || '').trim().toUpperCase());

    // Resolve seller_id cru → Seller real (mesma lógica do fechamento)
    const allSellers: any[] = await (this.prisma as any).seller.findMany({});
    const byId = new Map(allSellers.map((s) => [s.id, s]));
    const byCodigo = new Map(
      allSellers.filter((s) => s.wincredCodigo).map((s) => [String(s.wincredCodigo).trim(), s]),
    );
    const resolve = (raw: any) => byId.get(String(raw ?? '').trim()) || byCodigo.get(String(raw ?? '').trim()) || null;

    const stores = await this.prisma.store.findMany({ select: { id: true, code: true } });
    const storeCodeToId = new Map(stores.map((s: any) => [s.code, s.id]));

    type Acc = {
      seller: any | null; nome: string; pecas: number; valor: number; vendas: number;
      base: number; storeCode: string;
    };
    const acc = new Map<string, Acc>();
    for (const r of rows.filter(filtra)) {
      const seller = resolve(r.sellerId);
      const key = seller ? seller.id : `raw:${r.sellerId}`;
      const cur = acc.get(key) || {
        seller, nome: seller?.name || `#${r.sellerId}`, pecas: 0, valor: 0, vendas: 0, base: 0,
        storeCode: r.storeCode,
      };
      cur.pecas += Number(r.pecas) || 0;
      cur.valor += Number(r.faturamento) || 0;
      cur.vendas += Number(r.qtd) || 0;
      cur.base += Math.max(0, (Number(r.valorRecebido) || 0) - (Number(r.valorFrete) || 0));
      acc.set(key, cur);
    }
    for (const d of devs.filter(filtra)) {
      const seller = resolve(d.sellerId);
      const key = seller ? seller.id : `raw:${d.sellerId}`;
      const cur = acc.get(key);
      if (cur) cur.base = Math.max(0, cur.base - (Number(d.total) || 0));
    }

    const out: any[] = [];
    for (const a of acc.values()) {
      let comissao: number | null = null;
      let percentual: number | null = null;
      if (a.seller) {
        const storeId = storeCodeToId.get(a.storeCode);
        const rule = await this.resolveRuleFor(
          a.seller.id, storeId || '', a.seller.cargo || 'VENDEDORA', input.fim,
        );
        // Ranking mostra comissão sobre as PRÓPRIAS vendas; regra de loja
        // (líder/gerente) não se aplica a esse recorte.
        if (rule && rule.calcMode !== 'on_responsible_store') {
          const c = this.aplicarRegra(rule, a.base);
          comissao = Math.round(c.valorComissao * 100) / 100;
          percentual = c.percentual;
        }
      }
      out.push({
        codigo: a.seller?.id || a.nome,
        nome: a.nome,
        pecas: a.pecas,
        valor: Math.round(a.valor * 100) / 100,
        vendas: a.vendas,
        ticketMedio: a.vendas > 0 ? a.valor / a.vendas : 0,
        base: Math.round(a.base * 100) / 100,
        percentual,
        comissao,
      });
    }
    out.sort((x, y) => y.valor - x.valor);
    return out.slice(0, limit);
  }
}
