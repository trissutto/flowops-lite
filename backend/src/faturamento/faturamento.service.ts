import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

/**
 * FaturamentoService — agrega faturamento da rede toda.
 *
 * Fonte de verdade:
 *   - Lojas físicas: tabela `caixa` do Giga (MySQL)
 *   - Loja SITE: caixa Giga (parte legacy) + Order do flowops (status=completed)
 *
 * Comparação automática com mesmo período do ano anterior.
 *
 * Cache simples em memória (5 min) — evita bater 12x no Giga se vários
 * admins abrirem a tela ao mesmo tempo.
 */
@Injectable()
export class FaturamentoService {
  private readonly logger = new Logger(FaturamentoService.name);
  private cache = new Map<string, { at: number; data: any }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

  /**
   * Lista vendas detalhadas de uma loja num período (drill-down do faturamento).
   * Inclui itens + payments pra mostrar tudo no modal de averiguação.
   *
   * @param storeCode  Código da loja (ex: 'ITANHAEM') ou 'SITE' pra Order do flowops
   * @param from       YYYY-MM-DD inclusivo
   * @param to         YYYY-MM-DD inclusivo
   */
  async getVendasDetalhadas(storeCode: string, from: string, to: string) {
    const dInicio = this.parseDate(from, false);
    const dFimExclusive = this.parseDate(to, true);

    // SITE = pedidos do WC/flowops Order (não PdvSale)
    if (storeCode === 'SITE' || storeCode.toUpperCase() === 'SITE') {
      const orders = await (this.prisma as any).order.findMany({
        where: {
          status: 'completed',
          createdAt: { gte: dInicio, lt: dFimExclusive },
        },
        select: {
          id: true,
          wcOrderId: true,
          status: true,
          totalAmount: true,
          createdAt: true,
          customerCpf: true,
          customerName: true,
          paymentMethod: true,
          items: {
            select: { sku: true, descricao: true, qty: true, unitPrice: true, total: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      return {
        storeCode: 'SITE',
        source: 'flowops_order',
        vendas: orders.map((o: any) => ({
          id: o.id,
          number: `#${o.wcOrderId || o.id.slice(0, 8)}`,
          status: o.status,
          createdAt: o.createdAt,
          total: o.totalAmount,
          customerCpf: o.customerCpf,
          customerName: o.customerName,
          paymentMethod: o.paymentMethod,
          sellerName: null,
          nfceStatus: null,
          nfceNumber: null,
          items: o.items,
          payments: [],
          canEstornar: false,  // pedidos site têm fluxo separado de cancelamento
        })),
      };
    }

    // Lojas físicas — PdvSale
    const sales = await (this.prisma as any).pdvSale.findMany({
      where: {
        storeCode: storeCode.toUpperCase(),
        status: { in: ['finalized', 'cancelled'] },
        finalizedAt: { gte: dInicio, lt: dFimExclusive },
        isTraining: false,
      },
      select: {
        id: true,
        status: true,
        total: true,
        subtotal: true,
        desconto: true,
        finalizedAt: true,
        cancelledAt: true,
        cancelReason: true,
        sellerName: true,
        customerCpf: true,
        customerName: true,
        paymentMethod: true,
        nfceStatus: true,
        nfceNumber: true,
        nfceSerie: true,
        nfceChave: true,
        nfceAutorizadaEm: true,
        stockDecreasedAt: true,
        items: {
          select: { sku: true, descricao: true, qty: true, precoUnit: true, total: true, cor: true, tamanho: true },
        },
        payments: {
          select: { method: true, valor: true, details: true },
        },
      },
      orderBy: { finalizedAt: 'desc' },
      take: 500,
    });

    return {
      storeCode: storeCode.toUpperCase(),
      source: 'pdv_sale',
      vendas: sales.map((s: any) => ({
        id: s.id,
        number: s.nfceNumber ? `NFCe ${s.nfceNumber}` : `#${s.id.slice(0, 8)}`,
        status: s.status,
        createdAt: s.finalizedAt,
        total: s.total,
        subtotal: s.subtotal,
        desconto: s.desconto,
        cancelledAt: s.cancelledAt,
        cancelReason: s.cancelReason,
        sellerName: s.sellerName,
        customerCpf: s.customerCpf,
        customerName: s.customerName,
        paymentMethod: s.paymentMethod,
        nfceStatus: s.nfceStatus,
        nfceNumber: s.nfceNumber,
        nfceSerie: s.nfceSerie,
        nfceChave: s.nfceChave,
        nfceAutorizadaEm: s.nfceAutorizadaEm,
        stockDecreased: !!s.stockDecreasedAt,
        items: s.items,
        payments: s.payments,
        canEstornar: s.status === 'finalized', // só finalizada pode estornar
      })),
    };
  }

  /**
   * Retorna faturamento agregado por loja + total rede + comparação ano
   * anterior + série temporal (pra gráfico).
   *
   * @param from              data início ISO (YYYY-MM-DD), inclusiva
   * @param to                data fim ISO (YYYY-MM-DD), inclusiva
   * @param granularity       'day' | 'week' | 'month' (granularidade do gráfico)
   */
  async getResumo(from: string, to: string, granularity: 'day' | 'week' | 'month' = 'day') {
    const cacheKey = `${from}|${to}|${granularity}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.at < this.CACHE_TTL_MS) {
      return { ...cached.data, cached: true };
    }

    const dInicio = this.parseDate(from, false);
    // Fim é EXCLUSIVO no SQL — somamos +1 dia pra incluir o dia final completo
    const dFimExclusive = this.parseDate(to, true);

    // Mesmo período no ano anterior
    const dInicioAnterior = new Date(dInicio);
    dInicioAnterior.setFullYear(dInicioAnterior.getFullYear() - 1);
    const dFimAnterior = new Date(dFimExclusive);
    dFimAnterior.setFullYear(dFimAnterior.getFullYear() - 1);

    // ── 1) Lojas do flowops (pra ter nomes legíveis na UI) ──
    const lojasDb = await this.prisma.store.findMany({
      where: { active: true },
      select: { code: true, name: true, city: true },
    });
    const nomeLoja = new Map(lojasDb.map((l: any) => [l.code, l.name || l.code]));

    // Detecta o code REAL da loja SITE — não hardcode 'SITE'!
    // Ex: Lurd's tem Store code='13' name='SITE'. Sem isso o código
    // criava DOIS cards (um real + um zerado).
    const siteStore = lojasDb.find(
      (l: any) =>
        (l.name || '').toString().trim().toUpperCase() === 'SITE' ||
        l.code === 'SITE',
    );
    const siteStoreCode = siteStore?.code || 'SITE';

    // ── 2) Giga: faturamento por loja, período atual + ano anterior em paralelo ──
    const [gigaAtual, gigaAnterior, tsAtual, tsAnterior] = await Promise.all([
      this.erp.getFaturamentoPorLoja(dInicio, dFimExclusive),
      this.erp.getFaturamentoPorLoja(dInicioAnterior, dFimAnterior),
      this.erp.getFaturamentoTimeseries(dInicio, dFimExclusive, granularity),
      this.erp.getFaturamentoTimeseries(dInicioAnterior, dFimAnterior, granularity),
    ]);

    // ── 3) Flowops SITE: Order com status=completed no período ──
    const [flowAtual, flowAnterior] = await Promise.all([
      this.getFlowopsSiteFaturamento(dInicio, dFimExclusive),
      this.getFlowopsSiteFaturamento(dInicioAnterior, dFimAnterior),
    ]);

    // Time series Flowops SITE (mesmo formato do Giga)
    const flowTsAtual = await this.getFlowopsTimeseries(dInicio, dFimExclusive, granularity);
    const flowTsAnterior = await this.getFlowopsTimeseries(dInicioAnterior, dFimAnterior, granularity);

    // ── 4) Compõe SITE = Giga SITE + Flowops completed ──
    const lojas = this.combinarLojas(
      gigaAtual,
      gigaAnterior,
      flowAtual,
      flowAnterior,
      nomeLoja,
      siteStoreCode,
    );

    // ── 5) Totais ──
    const totalAtual = lojas.reduce((s, l) => s + l.atual.faturamento, 0);
    const totalAnterior = lojas.reduce((s, l) => s + l.anterior.faturamento, 0);
    const totalCuponsAtual = lojas.reduce((s, l) => s + l.atual.cupons, 0);
    const totalPecasAtual = lojas.reduce((s, l) => s + l.atual.pecas, 0);
    const varTotal = totalAnterior > 0 ? ((totalAtual - totalAnterior) / totalAnterior) * 100 : 0;

    // ── 6) Time series mergeada (Giga + flowops SITE) ──
    const series = this.mergeTimeseries(tsAtual, tsAnterior, flowTsAtual, flowTsAnterior, granularity);

    // Debug: ajuda a identificar gráfico de ano anterior zerado
    this.logger.log(
      `Faturamento timeseries: ${tsAtual.length} pts atual, ${tsAnterior.length} pts anterior, ` +
      `${flowTsAtual.length} flow atual, ${flowTsAnterior.length} flow anterior, ` +
      `${series.length} buckets mergeados, ` +
      `soma anterior=${series.reduce((s, p) => s + p.anterior, 0).toFixed(2)}`,
    );

    const result = {
      from,
      to,
      granularity,
      periodoAnterior: {
        from: this.isoDate(dInicioAnterior),
        to: this.isoDate(new Date(dFimAnterior.getTime() - 86400_000)),
      },
      totalRede: {
        atual: totalAtual,
        anterior: totalAnterior,
        variacaoPct: varTotal,
        cupons: totalCuponsAtual,
        pecas: totalPecasAtual,
        ticketMedio: totalCuponsAtual > 0 ? totalAtual / totalCuponsAtual : 0,
      },
      lojas,
      series,
      cached: false,
    };

    this.cache.set(cacheKey, { at: Date.now(), data: result });
    return result;
  }

  /**
   * Data de corte a partir da qual as vendas do SITE passaram a ser
   * lançadas EXCLUSIVAMENTE no Flowops (WC) e PARARAM de aparecer no Giga
   * SITE. ANTES dessa data, o Giga SITE já tinha as vendas do site — não
   * pode somar Flowops Order pra não DUPLICAR.
   *
   * Default: 2026-05-11 (data que a Lurd's parou de lançar vendas do site
   * no Wincred). Configurável via env FLOWOPS_SITE_CUTOFF_DATE=YYYY-MM-DD.
   *
   * Depois dessa data:
   *   - Giga LOJA='SITE' = só vendas WhatsApp (continua lançando)
   *   - Flowops Order.completed = vendas reais do e-commerce
   *   - SITE total = soma dos dois
   */
  private getFlowopsSiteCutoff(): Date {
    const envCutoff = this.configCutoffEnvOrDefault();
    const [y, m, d] = envCutoff.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  private configCutoffEnvOrDefault(): string {
    // Usa env var se setada, senão default hardcoded.
    const env = process.env.FLOWOPS_SITE_CUTOFF_DATE;
    return env && /^\d{4}-\d{2}-\d{2}$/.test(env) ? env : '2026-05-11';
  }

  /**
   * Status do Order que contam como "VENDIDO" — cliente PAGOU.
   *
   * Critério: pagamento confirmado = venda. Não importa se já postou,
   * está separando, ou ainda nem foi pra loja — pra fins de FATURAMENTO
   * conta a partir do momento que o dinheiro entrou.
   *
   * NÃO entram:
   *   - pending   (cliente não pagou ainda — abandonou checkout)
   *   - cancelled (cancelado antes ou depois de pagar)
   *   - refunded  (estornado — o dinheiro voltou pro cliente)
   */
  private static readonly FATURAMENTO_STATUSES = [
    'processing',
    'routing',
    'awaiting_stock',
    'separating',
    'ready',
    'shipped',
    'delivered',
    'completed',
  ];

  /**
   * Soma totalAmount de Order com status que conta como venda dentro do período.
   * RESPEITA O CUTOFF: só conta vendas a partir de FLOWOPS_SITE_CUTOFF_DATE.
   * Antes do cutoff, as vendas eram lançadas no Giga (já contadas lá).
   */
  private async getFlowopsSiteFaturamento(inicio: Date, fimExclusive: Date) {
    const cutoff = this.getFlowopsSiteCutoff();
    // inicio efetivo = max(inicio do filtro, cutoff)
    const inicioEfetivo = inicio < cutoff ? cutoff : inicio;
    // Período inteiro antes do cutoff → não soma nada do Flowops
    if (inicioEfetivo >= fimExclusive) {
      return { faturamento: 0, cupons: 0, pecas: 0, ticketMedio: 0 };
    }

    const rows = await this.prisma.order.findMany({
      where: {
        status: { in: FaturamentoService.FATURAMENTO_STATUSES },
        wcDateCreated: { gte: inicioEfetivo, lt: fimExclusive },
      },
      select: {
        // Só ITENS — totalAmount inclui frete (sedex/PAC) e a regra é
        // somar APENAS produtos vendidos pra bater com o critério do
        // Wincred ("TOTAL VENDAS R$ não inclui frete").
        items: { select: { quantity: true, unitPrice: true } },
      },
    });
    let faturamento = 0;
    let pecas = 0;
    for (const o of rows) {
      for (const it of o.items) {
        const q = Number(it.quantity) || 0;
        const p = Number(it.unitPrice) || 0;
        pecas += q;
        faturamento += q * p;
      }
    }
    return {
      faturamento,
      cupons: rows.length,
      pecas,
      ticketMedio: rows.length > 0 ? faturamento / rows.length : 0,
    };
  }

  /** Time series do Flowops SITE no formato compatível com a do Giga */
  private async getFlowopsTimeseries(
    inicio: Date,
    fimExclusive: Date,
    granularity: 'day' | 'week' | 'month',
  ) {
    const cutoff = this.getFlowopsSiteCutoff();
    const inicioEfetivo = inicio < cutoff ? cutoff : inicio;
    if (inicioEfetivo >= fimExclusive) {
      return [];
    }

    const orders = await this.prisma.order.findMany({
      where: {
        status: { in: FaturamentoService.FATURAMENTO_STATUSES },
        wcDateCreated: { gte: inicioEfetivo, lt: fimExclusive },
      },
      // Mesmo critério da função acima: SUM(quantity * unitPrice) — sem frete.
      select: {
        wcDateCreated: true,
        items: { select: { quantity: true, unitPrice: true } },
      },
    });
    const buckets = new Map<string, number>();
    for (const o of orders) {
      if (!o.wcDateCreated) continue;
      const b = this.bucketKey(o.wcDateCreated, granularity);
      let valorProdutos = 0;
      for (const it of o.items) {
        valorProdutos += (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0);
      }
      buckets.set(b, (buckets.get(b) || 0) + valorProdutos);
    }
    return Array.from(buckets.entries()).map(([bucket, faturamento]) => ({
      bucket,
      storeCode: 'SITE',
      faturamento,
    }));
  }

  /**
   * Combina lista por loja: Giga + Flowops SITE → uma linha por loja
   * com { atual, anterior } e variação %.
   */
  private combinarLojas(
    gigaAtual: any[],
    gigaAnterior: any[],
    flowAtual: any,
    flowAnterior: any,
    nomeLoja: Map<string, string>,
    siteStoreCode: string,
  ) {
    const codes = new Set<string>();
    for (const r of gigaAtual) codes.add(r.storeCode);
    for (const r of gigaAnterior) codes.add(r.storeCode);
    // SEMPRE inclui a loja SITE — mesmo que Giga não tenha vendas no período,
    // Flowops pode ter. Usa o código REAL da loja (não hardcoded 'SITE').
    codes.add(siteStoreCode);

    const mapAtual = new Map(gigaAtual.map((r) => [r.storeCode, r]));
    const mapAnterior = new Map(gigaAnterior.map((r) => [r.storeCode, r]));

    const lojas = Array.from(codes).map((code) => {
      const ga = mapAtual.get(code) || { faturamento: 0, cupons: 0, pecas: 0, ticketMedio: 0 };
      const gp = mapAnterior.get(code) || { faturamento: 0, cupons: 0, pecas: 0, ticketMedio: 0 };

      const isSite = code === siteStoreCode;

      // Pra SITE, soma Giga + Flowops
      const atual = isSite
        ? {
            faturamento: ga.faturamento + flowAtual.faturamento,
            cupons: ga.cupons + flowAtual.cupons,
            pecas: ga.pecas + flowAtual.pecas,
            ticketMedio:
              ga.cupons + flowAtual.cupons > 0
                ? (ga.faturamento + flowAtual.faturamento) / (ga.cupons + flowAtual.cupons)
                : 0,
            breakdown: {
              giga: { faturamento: ga.faturamento, cupons: ga.cupons },
              flowops: { faturamento: flowAtual.faturamento, cupons: flowAtual.cupons },
            },
          }
        : { ...ga, breakdown: null };

      const anterior = isSite
        ? {
            faturamento: gp.faturamento + flowAnterior.faturamento,
            cupons: gp.cupons + flowAnterior.cupons,
            pecas: gp.pecas + flowAnterior.pecas,
            ticketMedio:
              gp.cupons + flowAnterior.cupons > 0
                ? (gp.faturamento + flowAnterior.faturamento) / (gp.cupons + flowAnterior.cupons)
                : 0,
          }
        : { ...gp };

      const variacaoPct =
        anterior.faturamento > 0
          ? ((atual.faturamento - anterior.faturamento) / anterior.faturamento) * 100
          : atual.faturamento > 0
            ? 100
            : 0;

      return {
        storeCode: code,
        storeName: nomeLoja.get(code) || code,
        atual,
        anterior,
        variacaoPct,
      };
    });
    // Ordenado por faturamento atual desc
    lojas.sort((a, b) => b.atual.faturamento - a.atual.faturamento);
    return lojas;
  }

  /**
   * Merge das séries Giga + Flowops em formato pronto pro Recharts:
   *   [{ bucket: '2026-05-01', atual: 12340, anterior: 10200 }, ...]
   * Soma TODAS as lojas em cada bucket (gráfico mostra rede inteira).
   */
  private mergeTimeseries(
    gigaAtual: any[],
    gigaAnterior: any[],
    flowAtual: any[],
    flowAnterior: any[],
    granularity: 'day' | 'week' | 'month',
  ) {
    const sumByBucket = (rows: any[]) => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.bucket, (m.get(r.bucket) || 0) + (r.faturamento || 0));
      return m;
    };
    const sa = sumByBucket(gigaAtual);
    const sp = sumByBucket(gigaAnterior);
    for (const r of flowAtual) sa.set(r.bucket, (sa.get(r.bucket) || 0) + r.faturamento);
    for (const r of flowAnterior) sp.set(r.bucket, (sp.get(r.bucket) || 0) + r.faturamento);

    // O bucket do anterior precisa ser RE-MAPEADO pro bucket equivalente do atual
    // (ex: 2025-05-15 → 2026-05-15) pro Recharts plottar lado a lado.
    const sa_remap = new Map<string, number>();
    for (const [b, v] of sa.entries()) sa_remap.set(b, v);
    const sp_remap = new Map<string, number>();
    for (const [b, v] of sp.entries()) {
      const remapped = this.advanceBucketOneYear(b, granularity);
      sp_remap.set(remapped, (sp_remap.get(remapped) || 0) + v);
    }

    // União das chaves ordenadas
    const allBuckets = Array.from(new Set([...sa_remap.keys(), ...sp_remap.keys()])).sort();
    return allBuckets.map((bucket) => ({
      bucket,
      atual: sa_remap.get(bucket) || 0,
      anterior: sp_remap.get(bucket) || 0,
    }));
  }

  /** Avança 1 ano em um bucket (string) — pra alinhar série anterior com atual */
  private advanceBucketOneYear(bucket: string, granularity: 'day' | 'week' | 'month'): string {
    if (granularity === 'day') {
      const d = new Date(bucket + 'T00:00:00');
      d.setFullYear(d.getFullYear() + 1);
      return this.isoDate(d);
    }
    if (granularity === 'month') {
      // formato 'YYYY-MM-01'
      const [y, m] = bucket.split('-');
      return `${Number(y) + 1}-${m}-01`;
    }
    // week format '%x-W%v' (ISO)
    const m = bucket.match(/^(\d{4})-W(\d{1,2})$/);
    if (!m) return bucket;
    return `${Number(m[1]) + 1}-W${m[2]}`;
  }

  /** Bucket key consistente com o formato do MySQL DATE_FORMAT no Giga */
  private bucketKey(d: Date, granularity: 'day' | 'week' | 'month'): string {
    if (granularity === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    if (granularity === 'week') {
      // ISO week — aproximação rápida (Recharts não exige precisão perfeita)
      const onejan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
    }
    return this.isoDate(d);
  }

  private isoDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** Parseia YYYY-MM-DD em Date local. Se endExclusive=true, adiciona 1 dia. */
  private parseDate(s: string, endExclusive: boolean): Date {
    const [y, m, d] = s.split('-').map(Number);
    const date = new Date(y, (m || 1) - 1, d || 1);
    if (endExclusive) date.setDate(date.getDate() + 1);
    return date;
  }
}
