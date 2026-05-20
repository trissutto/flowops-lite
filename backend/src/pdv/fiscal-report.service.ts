import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Relatório fiscal — auditoria de NFC-e emitidas com filtros pra contador
 * e detecção de inconsistências de CNPJ vs loja esperada.
 *
 * Gera 3 categorias de resultados:
 *   1. Vendas COM NFC-e autorizada — análise por CNPJ/série/loja
 *   2. Vendas SEM NFC-e (pendente, rejeitada, ou nunca emitida) — buracos fiscais
 *   3. Inconsistências (NFC-e emitida por CNPJ diferente do esperado pra loja)
 */
@Injectable()
export class FiscalReportService {
  private readonly logger = new Logger(FiscalReportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Filtra vendas + agrega indicadores fiscais.
   *
   * @param from data inicial (YYYY-MM-DD)
   * @param to data final (YYYY-MM-DD)
   * @param filters opcionais — todos string|null, multi-valor separado por vírgula
   */
  async query(input: {
    from: Date;
    to: Date;
    storeCodes?: string[] | null;
    cnpjs?: string[] | null;
    series?: string[] | null;
    nfceStatus?: string[] | null; // 'autorizada' | 'cancelada' | 'rejeitada' | 'pendente' | 'sem_nfce'
    paymentMethods?: string[] | null;
    sellers?: string[] | null;
    customerCpf?: string | null;
    customerName?: string | null;
    chave?: string | null;
    minValor?: number | null;
    maxValor?: number | null;
    onlyInconsistent?: boolean;
  }) {
    const fromStart = new Date(input.from);
    fromStart.setHours(0, 0, 0, 0);
    const toEnd = new Date(input.to);
    toEnd.setHours(23, 59, 59, 999);

    // Mapa loja → CNPJ esperado (pra detectar inconsistência)
    const stores = await this.prisma.store.findMany({
      select: { code: true, name: true, expectedCnpj: true, expectedRazaoSocial: true } as any,
    });
    const storeMap = new Map(
      (stores as any[]).map((s) => [
        s.code,
        {
          name: s.name,
          expectedCnpj: s.expectedCnpj ? String(s.expectedCnpj).replace(/\D/g, '') : null,
          expectedRazaoSocial: s.expectedRazaoSocial || null,
        },
      ]),
    );

    // Where clause base — só vendas finalizadas no período
    const where: any = {
      status: 'finalized',
      finalizedAt: { gte: fromStart, lte: toEnd },
    };
    if (input.storeCodes?.length) where.storeCode = { in: input.storeCodes };
    if (input.customerCpf) where.customerCpf = { contains: input.customerCpf.replace(/\D/g, '') };
    if (input.customerName) where.customerName = { contains: input.customerName, mode: 'insensitive' };
    if (input.chave) where.nfceChave = input.chave.trim();
    if (input.minValor != null) where.total = { ...(where.total || {}), gte: input.minValor };
    if (input.maxValor != null) where.total = { ...(where.total || {}), lte: input.maxValor };
    if (input.paymentMethods?.length) where.paymentMethod = { in: input.paymentMethods };
    if (input.sellers?.length) {
      where.OR = [
        { sellerName: { in: input.sellers } },
        { vendedorName: { in: input.sellers } },
      ];
    }
    if (input.nfceStatus?.length) {
      // Traduz status PT (UI) → EN (banco) pra filtrar correto.
      // 'sem_nfce' = vendas com nfceStatus null.
      const ptToEn: Record<string, string> = {
        autorizada: 'authorized',
        rejeitada: 'rejected',
        cancelada: 'cancelled',
        pendente: 'pending',
      };
      const statusesEn = input.nfceStatus
        .filter((s) => s !== 'sem_nfce')
        .map((s) => ptToEn[s] || s); // se já vier em inglês, mantém
      const semNfce = input.nfceStatus.includes('sem_nfce');
      const orStatus: any[] = [];
      if (statusesEn.length) orStatus.push({ nfceStatus: { in: statusesEn } });
      if (semNfce) orStatus.push({ nfceStatus: null });
      if (orStatus.length === 1) {
        Object.assign(where, orStatus[0]);
      } else if (orStatus.length > 1) {
        where.AND = (where.AND || []).concat([{ OR: orStatus }]);
      }
    }

    const sales = await (this.prisma as any).pdvSale.findMany({
      where,
      select: {
        id: true,
        storeCode: true,
        storeName: true,
        total: true,
        desconto: true,
        paymentMethod: true,
        sellerName: true,
        vendedorName: true,
        customerName: true,
        customerCpf: true,
        nfceStatus: true,
        nfceNumber: true,
        nfceSerie: true,
        nfceChave: true,
        nfceProtocolo: true,
        nfceMotivo: true,
        nfceAutorizadaEm: true,
        nfceCanceladaEm: true,
        finalizedAt: true,
        createdAt: true,
      },
      orderBy: { finalizedAt: 'desc' },
      take: 5000, // hard cap pra não derrubar memória
    });

    // Pra extrair CNPJ emitente, parseia o XML guardado é caro — usamos o
    // expectedCnpj como referência e cruzamos com NfceConfig. Pra simplificar,
    // assumimos que toda venda autorizada usou a config NFC-e da loja vigente.
    // Carrega todas configs pra fazer o mapa loja → cnpj atual.
    const configs = await (this.prisma as any).nfceConfig.findMany({
      select: { storeCode: true, cnpj: true, razaoSocial: true, serie: true } as any,
    });
    const cfgMap = new Map(
      (configs as any[]).map((c) => [
        c.storeCode,
        {
          cnpj: c.cnpj ? String(c.cnpj).replace(/\D/g, '') : null,
          razaoSocial: c.razaoSocial || null,
          serie: c.serie || null,
        },
      ]),
    );

    // Normaliza status do banco (inglês) pra português usado nos filtros/UI.
    // Banco grava: 'authorized' | 'rejected' | 'cancelled' | 'pending' | null
    // UI usa: 'autorizada' | 'rejeitada' | 'cancelada' | 'pendente' | 'sem_nfce'
    const normalizeStatus = (s: string | null | undefined): string => {
      const v = String(s || '').toLowerCase().trim();
      if (!v) return 'sem_nfce';
      if (v === 'authorized' || v === 'autorizada') return 'autorizada';
      if (v === 'rejected' || v === 'rejeitada') return 'rejeitada';
      if (v === 'cancelled' || v === 'canceled' || v === 'cancelada') return 'cancelada';
      if (v === 'pending' || v === 'pendente') return 'pendente';
      return v; // valor desconhecido — mantém pra debug
    };

    // Enriquece + detecta inconsistência
    const rows = (sales as any[]).map((s) => {
      const store = storeMap.get(s.storeCode);
      const cfg = cfgMap.get(s.storeCode);
      const statusNorm = normalizeStatus(s.nfceStatus);
      const isAuthorized = statusNorm === 'autorizada';
      const expectedCnpj = store?.expectedCnpj || null;
      // CNPJ emitido SÓ tem valor quando NFC-e foi autorizada de fato.
      // Pra vendas sem NFC-e/canceladas/rejeitadas, fica null (não conta nas
      // estatísticas de "Por CNPJ emitente" — ia inflar com vendas que NÃO
      // geraram imposto).
      const emittedCnpj = isAuthorized ? cfg?.cnpj || null : null;
      const emittedRazaoSocial = isAuthorized ? cfg?.razaoSocial || null : null;
      const inconsistent =
        isAuthorized &&
        expectedCnpj &&
        emittedCnpj &&
        expectedCnpj !== emittedCnpj;
      return {
        ...s,
        nfceStatus: statusNorm, // sobrescreve com versão normalizada
        expectedCnpj,
        expectedRazaoSocial: store?.expectedRazaoSocial || null,
        emittedCnpj,
        emittedRazaoSocial,
        inconsistent: !!inconsistent,
      };
    });

    // Aplica filtros que dependem do enriquecimento (cnpj, série, inconsistência)
    let filtered = rows;
    if (input.cnpjs?.length) {
      const digitsOnly = input.cnpjs.map((c) => c.replace(/\D/g, ''));
      filtered = filtered.filter((r) => r.emittedCnpj && digitsOnly.includes(r.emittedCnpj));
    }
    if (input.series?.length) {
      filtered = filtered.filter((r) => r.nfceSerie && input.series!.includes(String(r.nfceSerie)));
    }
    if (input.onlyInconsistent) {
      filtered = filtered.filter((r) => r.inconsistent);
    }

    // ── Agregações pro topo do relatório ──
    const totalGeral = filtered.reduce((acc, r) => acc + Number(r.total || 0), 0);
    const qtdGeral = filtered.length;

    // Por status
    const byStatus: Record<string, { qtd: number; total: number }> = {};
    for (const r of filtered) {
      const key = r.nfceStatus || 'sem_nfce';
      if (!byStatus[key]) byStatus[key] = { qtd: 0, total: 0 };
      byStatus[key].qtd++;
      byStatus[key].total += Number(r.total || 0);
    }

    // Por loja
    const byStore: Record<string, { qtd: number; total: number; storeName: string }> = {};
    for (const r of filtered) {
      if (!byStore[r.storeCode]) {
        byStore[r.storeCode] = { qtd: 0, total: 0, storeName: r.storeName };
      }
      byStore[r.storeCode].qtd++;
      byStore[r.storeCode].total += Number(r.total || 0);
    }

    // Por CNPJ emitente
    const byCnpj: Record<string, { qtd: number; total: number; razaoSocial: string | null }> = {};
    for (const r of filtered) {
      const key = r.emittedCnpj || 'SEM_CNPJ';
      if (!byCnpj[key]) byCnpj[key] = { qtd: 0, total: 0, razaoSocial: r.emittedRazaoSocial };
      byCnpj[key].qtd++;
      byCnpj[key].total += Number(r.total || 0);
    }

    // Por série
    const bySerie: Record<string, { qtd: number; total: number }> = {};
    for (const r of filtered) {
      const key = r.nfceSerie ? String(r.nfceSerie) : 'SEM_SERIE';
      if (!bySerie[key]) bySerie[key] = { qtd: 0, total: 0 };
      bySerie[key].qtd++;
      bySerie[key].total += Number(r.total || 0);
    }

    // Última nNF emitida por série (pra ver número atual e detectar buracos)
    const ultimoNumeroPorSerie: Record<string, number> = {};
    for (const r of filtered) {
      if (r.nfceSerie && r.nfceNumber) {
        const k = String(r.nfceSerie);
        const n = parseInt(String(r.nfceNumber), 10) || 0;
        if (!ultimoNumeroPorSerie[k] || n > ultimoNumeroPorSerie[k]) {
          ultimoNumeroPorSerie[k] = n;
        }
      }
    }

    // Contadores chave (usando nfceStatus JÁ normalizado em português)
    const qtdInconsistente = filtered.filter((r) => r.inconsistent).length;
    const qtdAutorizada = filtered.filter((r) => r.nfceStatus === 'autorizada').length;
    const totalAutorizado = filtered
      .filter((r) => r.nfceStatus === 'autorizada')
      .reduce((acc, r) => acc + Number(r.total || 0), 0);
    const qtdSemNfce = filtered.filter(
      (r) => r.nfceStatus === 'sem_nfce' || r.nfceStatus === 'pendente',
    ).length;
    const qtdCancelada = filtered.filter((r) => r.nfceStatus === 'cancelada').length;
    const qtdRejeitada = filtered.filter((r) => r.nfceStatus === 'rejeitada').length;

    return {
      filtros: input,
      range: { from: fromStart.toISOString(), to: toEnd.toISOString() },
      totals: {
        totalGeral: Math.round(totalGeral * 100) / 100,
        qtdGeral,
        qtdAutorizada,
        totalAutorizado: Math.round(totalAutorizado * 100) / 100,
        qtdInconsistente,
        qtdSemNfce,
        qtdCancelada,
        qtdRejeitada,
      },
      byStatus,
      byStore,
      byCnpj,
      bySerie,
      ultimoNumeroPorSerie,
      rows: filtered,
      generatedAt: new Date().toISOString(),
    };
  }
}
