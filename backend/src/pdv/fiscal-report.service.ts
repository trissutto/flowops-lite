import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import * as archiver from 'archiver';
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
    // Relatório fiscal: SEMPRE filtra por status de NFC-e (autorizada,
    // cancelada, rejeitada). Vendas sem NFC-e não aparecem aqui pq não
    // geraram imposto. Se o usuário não passou filtro, default = só autorizada.
    const ptToEn: Record<string, string> = {
      autorizada: 'authorized',
      rejeitada: 'rejected',
      cancelada: 'cancelled',
      pendente: 'pending',
    };
    const requestedStatus =
      input.nfceStatus && input.nfceStatus.length > 0
        ? input.nfceStatus
        : ['autorizada']; // default fiscal
    const statusesEn = requestedStatus
      .filter((s) => s !== 'sem_nfce' && s !== 'pendente')
      .map((s) => ptToEn[s] || s);
    if (statusesEn.length > 0) {
      where.nfceStatus = { in: statusesEn };
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
      // 'skipped' = venda online (paga por fora, sem NFC-e). Tratamos como
      // 'sem_nfce' pra não aparecer no filtro padrão (autorizadas). Quem
      // quiser ver, filtra por 'sem_nfce'.
      if (v === 'skipped') return 'sem_nfce';
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

  /**
   * Streama um ZIP com todos os XMLs (autorizadas + canceladas) do período.
   * Pro contador anexar à apuração fiscal. Pasta-mãe por loja.
   *
   * Tamanho típico: ~5-30 MB pra 1 mês de uma loja (XML autorizado ~25KB cada).
   */
  async streamXmlsZip(
    res: Response,
    input: {
      from: Date;
      to: Date;
      storeCodes?: string[] | null;
      cnpjs?: string[] | null;
    },
  ): Promise<void> {
    const fromStart = new Date(input.from);
    fromStart.setHours(0, 0, 0, 0);
    const toEnd = new Date(input.to);
    toEnd.setHours(23, 59, 59, 999);

    const where: any = {
      status: 'finalized',
      finalizedAt: { gte: fromStart, lte: toEnd },
      // Só pega vendas que TÊM XML — autorizadas ou canceladas (cancelamento gera novo XML)
      nfceStatus: { in: ['authorized', 'cancelled'] },
      nfceXml: { not: null },
    };
    if (input.storeCodes?.length) where.storeCode = { in: input.storeCodes };

    const sales = await (this.prisma as any).pdvSale.findMany({
      where,
      select: {
        id: true,
        storeCode: true,
        storeName: true,
        nfceChave: true,
        nfceStatus: true,
        nfceXml: true,
        nfceCancelamentoXml: true,
        finalizedAt: true,
      },
      orderBy: [{ storeCode: 'asc' }, { finalizedAt: 'asc' }],
      take: 10000, // hard cap pra não explodir memória
    });

    // Filtro por CNPJ é mais complexo (precisa cruzar com NfceConfig)
    let filtered = sales as any[];
    if (input.cnpjs?.length) {
      const cnpjsLimpos = input.cnpjs.map((c) => c.replace(/\D/g, ''));
      const configs = await (this.prisma as any).nfceConfig.findMany({
        select: { storeCode: true, cnpj: true },
      });
      const cnpjByStore = new Map(
        (configs as any[]).map((c) => [c.storeCode, String(c.cnpj || '').replace(/\D/g, '')]),
      );
      filtered = filtered.filter((s) => {
        const cnpj = cnpjByStore.get(s.storeCode);
        return cnpj && cnpjsLimpos.includes(cnpj);
      });
    }

    // Define filename do ZIP com range de datas
    const ymd = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const zipName = `nfces_${ymd(fromStart)}_a_${ymd(toEnd)}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err: any) => {
      this.logger.error(`[fiscal-zip] erro: ${err?.message || err}`);
      try {
        res.status(500).end();
      } catch { /* ignora */ }
    });
    archive.pipe(res);

    // Sanitiza nome de pasta (storeName pode ter acentos/espaços/etc)
    const sanitizeFolder = (s: string): string =>
      String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .toUpperCase()
        .slice(0, 40);

    let qtdXmls = 0;
    for (const sale of filtered) {
      const folder = `LOJA-${sale.storeCode}-${sanitizeFolder(sale.storeName)}`;
      const chave = sale.nfceChave || sale.id;
      if (sale.nfceXml) {
        archive.append(sale.nfceXml, { name: `${folder}/${chave}-nfe.xml` });
        qtdXmls++;
      }
      if (sale.nfceCancelamentoXml) {
        archive.append(sale.nfceCancelamentoXml, {
          name: `${folder}/${chave}-canc.xml`,
        });
        qtdXmls++;
      }
    }

    // Manifest pra contador conferir o que tá no pacote
    const manifest = [
      `LURDS PLUS SIZE - XMLs NFC-e`,
      `Período: ${fromStart.toLocaleDateString('pt-BR')} a ${toEnd.toLocaleDateString('pt-BR')}`,
      `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
      `Total de XMLs: ${qtdXmls}`,
      `Notas no período: ${filtered.length}`,
      `Filtros aplicados:`,
      `  Lojas: ${input.storeCodes?.join(', ') || 'TODAS'}`,
      `  CNPJs: ${input.cnpjs?.join(', ') || 'TODOS'}`,
    ].join('\n');
    archive.append(manifest, { name: '_MANIFEST.txt' });

    this.logger.log(
      `[fiscal-zip] Gerando ZIP: ${qtdXmls} XMLs de ${filtered.length} notas (${fromStart.toISOString()} a ${toEnd.toISOString()})`,
    );

    await archive.finalize();
  }
}
