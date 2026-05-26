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
    const lojas = this.combinarLojas(gigaAtual, gigaAnterior, flowAtual, flowAnterior, nomeLoja);

    // ── 5) Totais ──
    const totalAtual = lojas.reduce((s, l) => s + l.atual.faturamento, 0);
    const totalAnterior = lojas.reduce((s, l) => s + l.anterior.faturamento, 0);
    const totalCuponsAtual = lojas.reduce((s, l) => s + l.atual.cupons, 0);
    const totalPecasAtual = lojas.reduce((s, l) => s + l.atual.pecas, 0);
    const varTotal = totalAnterior > 0 ? ((totalAtual - totalAnterior) / totalAnterior) * 100 : 0;

    // ── 6) Time series mergeada (Giga + flowops SITE) ──
    const series = this.mergeTimeseries(tsAtual, tsAnterior, flowTsAtual, flowTsAnterior, granularity);

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

  /** Soma totalAmount de Order com status=completed dentro do período */
  private async getFlowopsSiteFaturamento(inicio: Date, fimExclusive: Date) {
    const rows = await this.prisma.order.findMany({
      where: {
        status: 'completed',
        wcDateCreated: { gte: inicio, lt: fimExclusive },
      },
      select: {
        totalAmount: true,
        items: { select: { quantity: true } },
      },
    });
    let faturamento = 0;
    let pecas = 0;
    for (const o of rows) {
      faturamento += Number(o.totalAmount) || 0;
      for (const it of o.items) pecas += Number(it.quantity) || 0;
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
    const orders = await this.prisma.order.findMany({
      where: {
        status: 'completed',
        wcDateCreated: { gte: inicio, lt: fimExclusive },
      },
      select: { totalAmount: true, wcDateCreated: true },
    });
    const buckets = new Map<string, number>();
    for (const o of orders) {
      if (!o.wcDateCreated) continue;
      const b = this.bucketKey(o.wcDateCreated, granularity);
      buckets.set(b, (buckets.get(b) || 0) + (Number(o.totalAmount) || 0));
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
  ) {
    const codes = new Set<string>();
    for (const r of gigaAtual) codes.add(r.storeCode);
    for (const r of gigaAnterior) codes.add(r.storeCode);
    codes.add('SITE'); // sempre inclui SITE (Flowops compõe)

    const mapAtual = new Map(gigaAtual.map((r) => [r.storeCode, r]));
    const mapAnterior = new Map(gigaAnterior.map((r) => [r.storeCode, r]));

    const lojas = Array.from(codes).map((code) => {
      const ga = mapAtual.get(code) || { faturamento: 0, cupons: 0, pecas: 0, ticketMedio: 0 };
      const gp = mapAnterior.get(code) || { faturamento: 0, cupons: 0, pecas: 0, ticketMedio: 0 };

      // Pra SITE, soma Giga + Flowops
      const atual =
        code === 'SITE'
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

      const anterior =
        code === 'SITE'
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
