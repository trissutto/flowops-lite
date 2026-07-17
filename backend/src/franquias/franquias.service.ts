import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProductSearchService } from '../product-search/product-search.service';

/**
 * PORTAL DE FRANQUIAS — Fases 1 e 2 (15/07, pedido do dono):
 * "a operadora das franquias tem acesso a todos os números da loja franquia".
 *
 * TUDO aqui é escopado por loja tipo=FILIAL NO BACKEND (o front nunca manda a
 * lista de lojas) e 100% ESPELHO/FLOW — nada toca o Giga ao vivo:
 *   - Faturamento bruto por dia/loja  → giga_caixa_diario (mesma fonte do
 *     financeiro/royalties — cobre vendas do Wincred e do Flow).
 *   - Vendas/peças/ticket/formas      → PdvSale/Items/Payments (Flow),
 *     status finalized, sem treino, sem canceladas.
 *   - Estoque                         → wincred_estoque × wincred_produtos.
 *
 * Decisões conservadoras (15/07, aguardando o dono refinar):
 *   - SEM custo/margem: valor de estoque só a PREÇO DE VENDA.
 *   - Papel 'franquias' (read-only) vê só AGREGADOS de venda — fundo/sangria
 *     ficam no super-painel (master_franquia/admin).
 */
@Injectable()
export class FranquiasService {
  private readonly logger = new Logger(FranquiasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly productSearch: ProductSearchService,
  ) {}

  /** Loja '1'/'01'/'LJ01' → '01' (formatos variam entre Flow e espelhos). */
  private normLoja(raw: any): string {
    return String(raw ?? '').trim().toUpperCase().replace(/^LJ/, '').padStart(2, '0');
  }

  /** Lojas FRANQUIA (tipo=FILIAL) ativas — a cerca de TODO o portal. */
  async lojasFilial(): Promise<Array<{ code: string; name: string }>> {
    const rows = await (this.prisma as any).store.findMany({
      where: { tipo: 'FILIAL', active: true },
      select: { code: true, name: true },
      orderBy: { code: 'asc' },
    });
    return (rows as any[]).map((r) => ({ code: String(r.code), name: String(r.name) }));
  }

  private parseDia(s: string, campo: string): Date {
    const d = new Date(`${String(s || '').trim()}T00:00:00`);
    if (isNaN(d.getTime())) throw new BadRequestException(`Data inválida em "${campo}" (use YYYY-MM-DD)`);
    return d;
  }

  /**
   * FATURAMENTO das franquias no período [de..ate], opcionalmente 1 loja.
   * Bruto do espelho (oficial) + vendas/peças/ticket/formas do PDV Flow.
   */
  async faturamento(deStr: string, ateStr: string, lojaFiltro?: string) {
    if (!deStr || !ateStr) throw new BadRequestException('Informe "de" e "ate" (YYYY-MM-DD)');
    const de = this.parseDia(deStr, 'de');
    const ate = this.parseDia(ateStr, 'ate');
    if (ate < de) throw new BadRequestException('"ate" não pode ser anterior a "de"');
    const fimExclusivo = new Date(ate.getTime() + 86_400_000);

    const filiais = await this.lojasFilial();
    const alvo = lojaFiltro
      ? filiais.filter((s) => this.normLoja(s.code) === this.normLoja(lojaFiltro))
      : filiais;
    if (!alvo.length) return { porLoja: [], porDia: [], totais: { brutoCents: 0, vendas: 0, pecas: 0, ticketCents: 0 } };
    const codesNorm = new Set(alvo.map((s) => this.normLoja(s.code)));

    // ── Bruto oficial por loja/dia (espelho giga_caixa_diario) ──
    const cx: any[] = await (this.prisma as any).gigaCaixaDiario
      .findMany({
        where: { data: { gte: de, lt: fimExclusivo } },
        select: { loja: true, data: true, bruto: true },
      })
      .catch(() => []);
    const brutoPorLoja = new Map<string, number>();
    const brutoPorDia = new Map<string, number>();
    for (const r of cx) {
      const loja = this.normLoja(r.loja);
      if (!codesNorm.has(loja)) continue;
      const cents = Math.round(Number(r.bruto || 0) * 100);
      brutoPorLoja.set(loja, (brutoPorLoja.get(loja) || 0) + cents);
      const dia = new Date(r.data).toISOString().slice(0, 10);
      brutoPorDia.set(dia, (brutoPorDia.get(dia) || 0) + cents);
    }

    // ── Vendas do PDV Flow (peças/ticket/formas) ──
    const vendas: any[] = await (this.prisma as any).pdvSale.findMany({
      where: {
        status: 'finalized',
        isTraining: false,
        finalizedAt: { gte: de, lt: fimExclusivo },
      },
      select: {
        storeCode: true,
        total: true,
        items: { select: { qty: true } },
        payments: { select: { method: true, valor: true } },
      },
    });
    type Agg = { vendas: number; pecas: number; totalCents: number; formas: Record<string, number> };
    const flowPorLoja = new Map<string, Agg>();
    for (const v of vendas) {
      const loja = this.normLoja(v.storeCode);
      if (!codesNorm.has(loja)) continue;
      let agg = flowPorLoja.get(loja);
      if (!agg) flowPorLoja.set(loja, (agg = { vendas: 0, pecas: 0, totalCents: 0, formas: {} }));
      agg.vendas += 1;
      agg.totalCents += Math.round(Number(v.total || 0) * 100);
      for (const it of v.items || []) agg.pecas += Number(it.qty || 0);
      for (const p of v.payments || []) {
        const m = String(p.method || 'outros').toLowerCase();
        agg.formas[m] = (agg.formas[m] || 0) + Math.round(Number(p.valor || 0) * 100);
      }
    }

    const porLoja = alvo
      .map((s) => {
        const norm = this.normLoja(s.code);
        const flow = flowPorLoja.get(norm);
        const vendasN = flow?.vendas || 0;
        return {
          storeCode: s.code,
          storeName: s.name,
          brutoCents: brutoPorLoja.get(norm) || 0,
          vendas: vendasN,
          pecas: flow?.pecas || 0,
          ticketCents: vendasN ? Math.round((flow!.totalCents || 0) / vendasN) : 0,
          formas: flow?.formas || {},
        };
      })
      .sort((a, b) => b.brutoCents - a.brutoCents);

    const porDia = Array.from(brutoPorDia.entries())
      .map(([data, brutoCents]) => ({ data, brutoCents }))
      .sort((a, b) => a.data.localeCompare(b.data));

    const totBruto = porLoja.reduce((s, l) => s + l.brutoCents, 0);
    const totVendas = porLoja.reduce((s, l) => s + l.vendas, 0);
    const totPecas = porLoja.reduce((s, l) => s + l.pecas, 0);
    const totFlowCents = Array.from(flowPorLoja.values()).reduce((s, a) => s + a.totalCents, 0);
    return {
      porLoja,
      porDia,
      totais: {
        brutoCents: totBruto,
        vendas: totVendas,
        pecas: totPecas,
        ticketCents: totVendas ? Math.round(totFlowCents / totVendas) : 0,
      },
    };
  }

  /** TOP produtos vendidos nas franquias no período (PDV Flow, por REF). */
  async maisVendidos(deStr: string, ateStr: string, lojaFiltro?: string, limit = 20) {
    if (!deStr || !ateStr) throw new BadRequestException('Informe "de" e "ate" (YYYY-MM-DD)');
    const de = this.parseDia(deStr, 'de');
    const ate = this.parseDia(ateStr, 'ate');
    const fimExclusivo = new Date(ate.getTime() + 86_400_000);
    const filiais = await this.lojasFilial();
    const alvo = lojaFiltro
      ? filiais.filter((s) => this.normLoja(s.code) === this.normLoja(lojaFiltro))
      : filiais;
    if (!alvo.length) return [];
    const codes = alvo.flatMap((s) => [s.code, this.normLoja(s.code)]);

    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COALESCE(NULLIF(TRIM(i.ref), ''), i.sku) AS ref,
              MAX(i.descricao)                          AS descricao,
              SUM(i.qty)::int                           AS pecas,
              ROUND(SUM(i.total)::numeric * 100)::bigint AS "totalCents"
         FROM pdv_sale_items i
         JOIN pdv_sales s ON s.id = i.sale_id
        WHERE s.status = 'finalized'
          AND s.is_training = false
          AND s.finalized_at >= $1 AND s.finalized_at < $2
          AND s.store_code = ANY($3::text[])
        GROUP BY 1
        ORDER BY 3 DESC
        LIMIT ${Math.min(50, Math.max(1, limit))}`,
      de,
      fimExclusivo,
      codes,
    );
    return rows.map((r) => ({
      ref: String(r.ref || ''),
      descricao: String(r.descricao || ''),
      pecas: Number(r.pecas || 0),
      totalCents: Number(r.totalCents || 0),
    }));
  }

  /**
   * ESTOQUE das franquias (espelhos): peças + valor a PREÇO DE VENDA por loja
   * e top grupos. SEM custo (decisão conservadora — margem é dado da rede).
   */
  async estoque() {
    const filiais = await this.lojasFilial();
    if (!filiais.length) return { porLoja: [], grupos: [] };
    const codesNorm = filiais.map((s) => this.normLoja(s.code));

    const porLojaRaw: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT e.loja                                            AS loja,
              SUM(e.estoque)::int                               AS pecas,
              ROUND(SUM(e.estoque * COALESCE(p."vendaUn", 0))::numeric * 100)::bigint AS "valorVendaCents"
         FROM wincred_estoque e
         JOIN wincred_produtos p ON p.codigo = e.codigo
        WHERE e.estoque > 0
          AND LPAD(REPLACE(UPPER(TRIM(e.loja)), 'LJ', ''), 2, '0') = ANY($1::text[])
        GROUP BY e.loja
        ORDER BY 3 DESC`,
      codesNorm,
    );
    const nomePorCode = new Map(filiais.map((s) => [this.normLoja(s.code), s.name]));
    const porLoja = porLojaRaw.map((r) => ({
      storeCode: this.normLoja(r.loja),
      storeName: nomePorCode.get(this.normLoja(r.loja)) || this.normLoja(r.loja),
      pecas: Number(r.pecas || 0),
      valorVendaCents: Number(r.valorVendaCents || 0),
    }));

    const gruposRaw: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT COALESCE(NULLIF(TRIM(p."nomeGrupo"), ''), 'SEM GRUPO') AS grupo,
              SUM(e.estoque)::int                                    AS pecas,
              ROUND(SUM(e.estoque * COALESCE(p."vendaUn", 0))::numeric * 100)::bigint AS "valorVendaCents"
         FROM wincred_estoque e
         JOIN wincred_produtos p ON p.codigo = e.codigo
        WHERE e.estoque > 0
          AND LPAD(REPLACE(UPPER(TRIM(e.loja)), 'LJ', ''), 2, '0') = ANY($1::text[])
        GROUP BY 1
        ORDER BY 3 DESC
        LIMIT 15`,
      codesNorm,
    );
    const grupos = gruposRaw.map((r) => ({
      grupo: String(r.grupo || ''),
      pecas: Number(r.pecas || 0),
      valorVendaCents: Number(r.valorVendaCents || 0),
    }));

    return { porLoja, grupos };
  }

  /** Busca de produto com o estoque POR LOJA FRANQUIA (espelhos, busca única). */
  async estoqueBusca(term: string) {
    const q = String(term || '').trim();
    if (q.length < 2) throw new BadRequestException('Digite ao menos 2 caracteres');
    const filiais = await this.lojasFilial();
    if (!filiais.length) return { lojas: [], rows: [] };
    const codesNorm = new Set(filiais.map((s) => this.normLoja(s.code)));

    const rows = await this.productSearch.resolveRows(q, { fallbackTake: 300 });
    const codigos = Array.from(
      new Set(rows.map((r) => String(r.codigo || '').trim()).filter(Boolean)),
    ).slice(0, 300);
    if (!codigos.length) return { lojas: filiais, rows: [] };

    const est: any[] = await (this.prisma as any).wincredEstoque
      .findMany({
        where: { codigo: { in: codigos }, estoque: { gt: 0 } },
        select: { codigo: true, loja: true, estoque: true },
      })
      .catch(() => []);
    const estPorCodigo = new Map<string, Record<string, number>>();
    for (const e of est) {
      const loja = this.normLoja(e.loja);
      if (!codesNorm.has(loja)) continue;
      const cod = String(e.codigo).trim();
      const m = estPorCodigo.get(cod) || {};
      m[loja] = (m[loja] || 0) + Number(e.estoque || 0);
      estPorCodigo.set(cod, m);
    }

    const out = rows
      .map((r) => {
        const porLoja = estPorCodigo.get(String(r.codigo).trim()) || {};
        const total = Object.values(porLoja).reduce((s, n) => s + n, 0);
        return {
          codigo: String(r.codigo),
          ref: r.ref || null,
          descricao: r.descricao || '',
          cor: r.cor || null,
          tamanho: r.tamanho || null,
          precoCents: r['vendaUn'] != null ? Math.round(Number((r as any).vendaUn) * 100) : null,
          porLoja,
          total,
        };
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 100);

    return { lojas: filiais, rows: out };
  }
}
