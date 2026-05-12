import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Caixa diário do PDV — abertura, sangria/suprimento, fechamento.
 *
 * Regras críticas:
 *  - Só pode haver UMA sessão `open` por loja por vez (validado na app).
 *  - PDV se recusa a finalizar venda se não houver caixa aberto na loja.
 *  - Fechamento (Z) calcula tudo, registra snapshot e marca status=closed.
 *  - Relatório X = parcial (sem fechar) — só consulta os mesmos números.
 */
@Injectable()
export class CashService {
  private readonly logger = new Logger(CashService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Retorna a sessão `open` da loja, se houver. Null se não tem.
   */
  async getCurrentSession(storeCode: string) {
    if (!storeCode) return null;
    return (this.prisma as any).pdvCashSession.findFirst({
      where: { storeCode, status: 'open' },
      orderBy: { openedAt: 'desc' },
    });
  }

  /**
   * Busca a sessão e calcula totais ATUAIS (sem fechar).
   * Usado tanto pelo Relatório X (parcial) quanto pelo fechamento Z.
   */
  async computeSessionTotals(sessionId: string) {
    const session = await (this.prisma as any).pdvCashSession.findUnique({
      where: { id: sessionId },
      include: { movements: true },
    });
    if (!session) throw new NotFoundException('Sessão de caixa não encontrada');

    // Vendas finalizadas dessa sessão
    const sales = await (this.prisma as any).pdvSale.findMany({
      where: { cashSessionId: sessionId, status: 'finalized' },
      include: { payments: true },
    });

    let totalVendas = 0;
    const byMethod: Record<string, number> = {
      dinheiro: 0,
      pix: 0,
      credito: 0,
      debito: 0,
      crediario: 0,
      outros: 0,
    };

    for (const s of sales as any[]) {
      totalVendas += Number(s.total) || 0;
      for (const p of s.payments || []) {
        const method = String(p.method || '').toLowerCase();
        const valor = Number(p.valor) || 0;
        if (method in byMethod) {
          byMethod[method] += valor;
        } else {
          byMethod.outros += valor;
        }
      }
    }

    // Movimentações de caixa (sangria/suprimento)
    let totalSangrias = 0;
    let totalSuprimentos = 0;
    for (const m of (session.movements || []) as any[]) {
      const v = Number(m.valor) || 0;
      if (m.tipo === 'sangria') totalSangrias += v;
      else if (m.tipo === 'suprimento') totalSuprimentos += v;
    }

    // Dinheiro esperado em caixa = fundo + dinheiro vendido - sangrias + suprimentos
    const dinheiroEsperado =
      Number(session.fundoTroco || 0) +
      byMethod.dinheiro -
      totalSangrias +
      totalSuprimentos;

    return {
      session,
      totalVendas,
      totalDinheiro: byMethod.dinheiro,
      totalPix: byMethod.pix,
      totalCartaoCredito: byMethod.credito,
      totalCartaoDebito: byMethod.debito,
      totalCrediario: byMethod.crediario,
      totalOutros: byMethod.outros,
      totalSangrias,
      totalSuprimentos,
      dinheiroEsperado,
      qtdVendas: sales.length,
    };
  }

  /**
   * Relatório detalhado com breakdown por BANDEIRA dos cartões.
   * Quebra credito/debito em MASTERCARD, VISANET, CIELO, ELO, AMEX, etc
   * lendo details.bandeira de cada pagamento.
   *
   * Usado pela tela /minha-loja/pdv/fechamento — replica o layout
   * "Movimento Diário de Caixa" do Wincred dentro do flowops.
   */
  async getRelatorioDetalhado(storeCode: string) {
    try {
    this.logger.log(`[getRelatorioDetalhado] storeCode=${storeCode}`);
    const session = await this.getCurrentSession(storeCode);
    this.logger.log(`[getRelatorioDetalhado] session=${session?.id ?? 'null'}`);
    if (!session) {
      throw new BadRequestException('Não há caixa aberto nesta loja.');
    }

    // Vendas finalizadas dessa sessão
    const sales = await (this.prisma as any).pdvSale.findMany({
      where: { cashSessionId: session.id, status: 'finalized' },
      include: { payments: true },
    });

    // Breakdown por forma + bandeira (agora também com QTD e LISTA de vendas)
    type Slot = {
      valor: number;
      qtd: number;
      vendas: Array<{
        saleId: string;
        saleTotal: number;
        paymentId: string;
        method: string;
        bandeira?: string | null;
        valor: number;
        customerName: string | null;
        customerCpf: string | null;
        sellerName: string | null;
        finalizedAt: string | null;
        parcelas?: number;
        // Itens pra recebimentos crediário — lista de parcelas individuais pagas
        items?: Array<{
          parcelaNum: number | null;
          totalParcelas: number | null;
          vencimento: string;
          valorPago: number;
          jurosCalculado: number;
        }>;
      }>;
    };
    const mkSlot = (): Slot => ({ valor: 0, qtd: 0, vendas: [] });
    const totais: Record<string, Slot> = {
      DINHEIRO: mkSlot(),
      PIX: mkSlot(),
      CREDIARIO: mkSlot(),
      MASTERCARD: mkSlot(),
      VISANET: mkSlot(),
      CIELO: mkSlot(),
      ELO: mkSlot(),
      AMEX: mkSlot(),
      HIPERCARD: mkSlot(),
      VISA_ELECTRON: mkSlot(),
      REDE_SHOP: mkSlot(),
      CREDITO_GENERICO: mkSlot(),
      DEBITO_GENERICO: mkSlot(),
      OUTROS: mkSlot(),
    };
    let totalVendas = 0;
    const qtdVendas = sales.length;

    const bandeiraMap: Record<string, string> = {
      'MASTERCARD': 'MASTERCARD', 'VISA': 'VISANET', 'VISANET': 'VISANET',
      'CIELO': 'CIELO', 'ELO': 'ELO', 'AMEX': 'AMEX',
      'AMERICAN EXPRESS': 'AMEX', 'HIPERCARD': 'HIPERCARD',
      'VISA ELECTRON': 'VISA_ELECTRON', 'VISA_ELECTRON': 'VISA_ELECTRON',
      'VISAELECTRON': 'VISA_ELECTRON', 'REDESHOP': 'REDE_SHOP',
      'REDE SHOP': 'REDE_SHOP', 'REDE_SHOP': 'REDE_SHOP',
    };

    const pushVenda = (key: string, sale: any, payment: any, paymentValor: number, parcelas?: number, bandeira?: string | null) => {
      totais[key].valor += paymentValor;
      totais[key].qtd += 1;
      totais[key].vendas.push({
        saleId: String(sale.id),
        saleTotal: Number(sale.total) || 0,
        paymentId: String(payment.id),
        method: String(payment.method || ''),
        bandeira: bandeira || null,
        valor: paymentValor,
        customerName: sale.customerName || null,
        customerCpf: sale.customerCpf || null,
        sellerName: sale.sellerName || sale.vendedorName || null,
        finalizedAt: sale.finalizedAt || sale.createdAt || null,
        parcelas,
      });
    };

    for (const s of sales as any[]) {
      totalVendas += Number(s.total) || 0;
      for (const p of s.payments || []) {
        const method = String(p.method || '').toLowerCase();
        const valor = Number(p.valor) || 0;
        let bandeira: string | null = null;
        let parcelas: number | undefined = undefined;
        if (p.details) {
          try {
            const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
            if (det?.bandeira) bandeira = String(det.bandeira).toUpperCase().trim();
            if (det?.parcelas) parcelas = Number(det.parcelas);
          } catch { /* ignora */ }
        }

        if (method === 'dinheiro') pushVenda('DINHEIRO', s, p, valor);
        else if (method === 'pix') pushVenda('PIX', s, p, valor);
        else if (method === 'crediario') pushVenda('CREDIARIO', s, p, valor, parcelas);
        else if (method === 'credito' || method === 'debito') {
          const key = bandeira ? bandeiraMap[bandeira] : null;
          if (key && key in totais) {
            pushVenda(key, s, p, valor, parcelas, bandeira);
          } else {
            pushVenda(method === 'credito' ? 'CREDITO_GENERICO' : 'DEBITO_GENERICO', s, p, valor, parcelas, bandeira);
          }
        } else {
          pushVenda('OUTROS', s, p, valor);
        }
      }
    }

    // Recebimentos de crediário (baixas) feitos NESTA sessão.
    // IMPORTANTE: parcelas pagas hoje em DINHEIRO/PIX entram no caixa mas
    // NÃO são "venda do dia" — são pagamento de venda antiga. Precisam
    // aparecer separados nos somatórios pra reconciliação correta.
    const baixasCrediario = await (this.prisma as any).crediarioBaixa.findMany({
      where: {
        lojaCode: session.storeCode,
        status: 'paid',
        createdAt: { gte: session.openedAt },
      },
      orderBy: { createdAt: 'asc' },
      include: { items: { orderBy: { vencimento: 'asc' } } },
    });

    const recebimentosDinheiro = mkSlot();
    const recebimentosPix = mkSlot();
    for (const b of baixasCrediario as any[]) {
      const valor = Number(b.totalPago) || 0;
      const forma = String(b.formaPagamento || '').toLowerCase();
      const slot = forma === 'pix' ? recebimentosPix : recebimentosDinheiro;
      slot.valor += valor;
      slot.qtd += 1;
      slot.vendas.push({
        saleId: String(b.id),
        saleTotal: valor,
        paymentId: String(b.id),
        method: forma,
        bandeira: null,
        valor,
        customerName: b.customerName || null,
        customerCpf: b.customerCpf || null,
        sellerName: b.userName || null,
        finalizedAt: b.paidAt || b.createdAt || null,
        items: (b.items || []).map((it: any) => ({
          parcelaNum: it.parcelaNum ?? null,
          totalParcelas: it.totalParcelas ?? null,
          vencimento: it.vencimento || '',
          valorPago: Number(it.valorPago) || 0,
          jurosCalculado: Number(it.jurosCalculado) || 0,
        })),
      });
    }

    // Movimentações de caixa
    const movements = await (this.prisma as any).pdvCashMovement.findMany({
      where: { cashSessionId: session.id },
      orderBy: { createdAt: 'asc' },
    });
    let totalSangrias = 0;
    let totalSuprimentos = 0;
    for (const m of movements as any[]) {
      const v = Number(m.valor) || 0;
      if (m.tipo === 'sangria') totalSangrias += v;
      else if (m.tipo === 'suprimento') totalSuprimentos += v;
    }

    const dinheiroEsperado =
      Number(session.fundoTroco || 0) +
      totais.DINHEIRO.valor -
      totalSangrias +
      totalSuprimentos;

    // Helper pra somar slot (valor + qtd)
    const sumSlots = (...slots: Slot[]) => {
      return slots.reduce(
        (acc, s) => ({ valor: acc.valor + s.valor, qtd: acc.qtd + s.qtd }),
        { valor: 0, qtd: 0 },
      );
    };

    const credito = sumSlots(
      totais.MASTERCARD, totais.VISANET, totais.CIELO, totais.ELO,
      totais.AMEX, totais.HIPERCARD, totais.CREDITO_GENERICO,
    );
    const debito = sumSlots(totais.VISA_ELECTRON, totais.REDE_SHOP, totais.DEBITO_GENERICO);

    // Inclui recebimentos no dinheiroEsperado (entram no caixa físico)
    const dinheiroEsperadoComRecebimentos = dinheiroEsperado + recebimentosDinheiro.valor;

    return {
      session: {
        id: session.id,
        storeCode: session.storeCode,
        storeName: session.storeName,
        openedAt: session.openedAt,
        openedByName: session.openedByName,
        fundoTroco: Number(session.fundoTroco) || 0,
      },
      totais,           // Slots por forma+bandeira (com vendas detalhadas)
      recebimentosCrediario: {
        dinheiro: recebimentosDinheiro,
        pix: recebimentosPix,
        total: recebimentosDinheiro.valor + recebimentosPix.valor,
        qtdTotal: recebimentosDinheiro.qtd + recebimentosPix.qtd,
      },
      resumo: {
        totalVendas,
        totalDinheiro: totais.DINHEIRO.valor,
        totalPix: totais.PIX.valor,
        totalCrediario: totais.CREDIARIO.valor,
        totalCartaoCredito: credito.valor,
        totalCartaoDebito: debito.valor,
        qtdDinheiro: totais.DINHEIRO.qtd,
        qtdPix: totais.PIX.qtd,
        qtdCrediario: totais.CREDIARIO.qtd,
        qtdCartaoCredito: credito.qtd,
        qtdCartaoDebito: debito.qtd,
        totalRecebimentosDinheiro: recebimentosDinheiro.valor,
        totalRecebimentosPix: recebimentosPix.valor,
        qtdRecebimentosDinheiro: recebimentosDinheiro.qtd,
        qtdRecebimentosPix: recebimentosPix.qtd,
        totalSangrias,
        totalSuprimentos,
        dinheiroEsperado: dinheiroEsperadoComRecebimentos,
        dinheiroEsperadoSoVendas: dinheiroEsperado,
        qtdVendas,
      },
      movimentos: movements.map((m: any) => ({
        id: m.id,
        tipo: m.tipo,
        valor: Number(m.valor) || 0,
        observacao: m.observacao,
        createdAt: m.createdAt,
      })),
      generatedAt: new Date(),
    };
    } catch (err: any) {
      const msg = err?.message || String(err);
      const code = err?.code || 'NO_CODE';
      const meta = err?.meta ? JSON.stringify(err.meta) : 'NO_META';
      const stack = err?.stack || 'NO_STACK';
      this.logger.error(`[getRelatorioDetalhado] FAILED message=${msg} code=${code} meta=${meta}`);
      this.logger.error(`[getRelatorioDetalhado] STACK=${stack}`);
      throw err;
    }
  }

  // ── Super Painel da Retaguarda ──────────────────────────────────────
  // Retorna agregado de TODAS as lojas ativas com totais do caixa do dia.
  // Usado pela tela /retaguarda/super-painel-caixas com polling 60s.

  async getSuperPainelCaixas(): Promise<{
    lojas: Array<{
      storeCode: string;
      storeName: string;
      sessionId: string | null;
      aberta: boolean;
      openedAt: string | null;
      openedByName: string | null;
      fundoTroco: number;
      totais: {
        totalVendas: number;
        totalDinheiro: number;
        totalPix: number;
        totalCartaoCredito: number;
        totalCartaoDebito: number;
        totalCrediario: number;
        totalSangrias: number;
        totalSuprimentos: number;
        dinheiroEsperado: number;
        qtdVendas: number;
      };
      vendedoras: Array<{ nome: string; qtd: number; total: number }>;
      // Movimentos (sangria/suprimento) da sessao — pra cascata clicavel
      movimentos: Array<{
        id: string;
        tipo: string;
        valor: number;
        motivo: string;
        userName: string | null;
        createdAt: string;
      }>;
      // Crediarios recebidos hoje na loja — separado por forma (dinheiro/PIX)
      // Pra cascata clicavel mostrando cada baixa individual.
      recebimentosCrediario: {
        totalGeral: number;
        totalDinheiro: number;
        totalPix: number;
        baixas: Array<{
          id: string;
          forma: string;             // 'dinheiro' | 'pix' | 'misto'
          origem: string | null;     // 'presencial' | 'link' | null
          valor: number;
          valorDinheiro: number | null;
          valorPix: number | null;
          customerName: string | null;
          paidAt: string;
        }>;
      };
    }>;
    consolidado: {
      totalVendas: number;
      totalDinheiro: number;
      totalPix: number;
      totalCartaoCredito: number;
      totalCartaoDebito: number;
      totalCrediario: number;
      totalSangrias: number;
      totalSuprimentos: number;
      qtdVendas: number;
      qtdLojasAbertas: number;
      qtdLojasFechadas: number;
    };
    generatedAt: string;
  }> {
    // Lista todas lojas ativas (Postgres)
    const stores = await this.prisma.store.findMany({
      where: { active: true } as any,
      orderBy: { code: 'asc' },
      select: { code: true, name: true } as any,
    });

    const emptyTotais = {
      totalVendas: 0, totalDinheiro: 0, totalPix: 0,
      totalCartaoCredito: 0, totalCartaoDebito: 0, totalCrediario: 0,
      totalSangrias: 0, totalSuprimentos: 0, dinheiroEsperado: 0, qtdVendas: 0,
    };

    // Pra cada loja, busca sessão aberta + RELATORIO DETALHADO (paralelo)
    const lojas = await Promise.all(
      (stores as any[]).map(async (s) => {
        const session = await this.getCurrentSession(s.code);
        if (!session) {
          return {
            storeCode: s.code,
            storeName: s.name,
            sessionId: null,
            aberta: false,
            openedAt: null,
            openedByName: null,
            fundoTroco: 0,
            totais: emptyTotais,
            vendedoras: [],
            movimentos: [],
            recebimentosCrediario: { totalGeral: 0, totalDinheiro: 0, totalPix: 0, baixas: [] },
            detalhado: null as any,
          };
        }
        // Calcula totais da sessão
        const t = await this.computeSessionTotals(session.id);
        // Detalhamento por modalidade + bandeira + vendas (mesmo que /relatorio-detalhado)
        let detalhado: any = null;
        try {
          detalhado = await this.getRelatorioDetalhado(s.code);
        } catch { /* loja sem caixa aberto — segue */ }

        // Ranking de vendedoras (qtd vendas + total) — só vendas finalizadas
        const sales = await (this.prisma as any).pdvSale.findMany({
          where: { cashSessionId: session.id, status: 'finalized' },
          select: { sellerName: true, vendedorName: true, total: true },
        });
        const ranking: Record<string, { nome: string; qtd: number; total: number }> = {};
        for (const sale of sales as any[]) {
          const nome = (sale.sellerName || sale.vendedorName || 'Sem vendedora').trim();
          if (!ranking[nome]) ranking[nome] = { nome, qtd: 0, total: 0 };
          ranking[nome].qtd += 1;
          ranking[nome].total += Number(sale.total) || 0;
        }
        const vendedoras = Object.values(ranking).sort((a, b) => b.total - a.total);

        // Lista de movimentos (sangria/suprimento) — pra cascata clicavel
        const movimentosRaw = await (this.prisma as any).pdvCashMovement.findMany({
          where: { cashSessionId: session.id },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, tipo: true, valor: true, motivo: true,
            userName: true, createdAt: true,
          },
        });
        const movimentos = (movimentosRaw as any[]).map((m) => ({
          id: m.id,
          tipo: m.tipo,
          valor: Number(m.valor) || 0,
          motivo: m.motivo || '',
          userName: m.userName || null,
          createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
        }));

        // Crediarios recebidos hoje nessa loja (baixas pagas no dia)
        // Inclui baixas em DINHEIRO direto + PIX presencial + PIX-link + MISTO (split).
        // Pra MISTO contabiliza o valorDinheiro em dinheiro e valorPix em pix.
        const inicioHoje = new Date(); inicioHoje.setHours(0, 0, 0, 0);
        const recebimentosRaw = await (this.prisma as any).crediarioBaixa.findMany({
          where: {
            lojaCode: s.code,
            status: 'paid',
            paidAt: { gte: inicioHoje },
          },
          orderBy: { paidAt: 'desc' },
          select: {
            id: true,
            formaPagamento: true,
            origem: true,
            totalPago: true,
            valorDinheiro: true,
            valorPix: true,
            customerName: true,
            paidAt: true,
          },
        });
        const recBaixas = (recebimentosRaw as any[]).map((b) => ({
          id: b.id,
          forma: String(b.formaPagamento || ''),
          origem: b.origem || null,
          valor: Number(b.totalPago) || 0,
          valorDinheiro: b.valorDinheiro != null ? Number(b.valorDinheiro) : null,
          valorPix: b.valorPix != null ? Number(b.valorPix) : null,
          customerName: b.customerName || null,
          paidAt: b.paidAt instanceof Date ? b.paidAt.toISOString() : String(b.paidAt),
        }));
        let recTotalDin = 0;
        let recTotalPix = 0;
        for (const b of recBaixas) {
          if (b.forma === 'misto') {
            recTotalDin += b.valorDinheiro || 0;
            recTotalPix += b.valorPix || 0;
          } else if (b.forma === 'dinheiro') {
            recTotalDin += b.valor;
          } else if (b.forma === 'pix') {
            recTotalPix += b.valor;
          }
        }
        const recebimentosCrediario = {
          totalGeral: Math.round((recTotalDin + recTotalPix) * 100) / 100,
          totalDinheiro: Math.round(recTotalDin * 100) / 100,
          totalPix: Math.round(recTotalPix * 100) / 100,
          baixas: recBaixas,
        };

        return {
          storeCode: s.code,
          storeName: s.name,
          sessionId: session.id,
          aberta: true,
          openedAt: session.openedAt,
          openedByName: (session as any).openedByName || null,
          fundoTroco: Number(session.fundoTroco) || 0,
          totais: {
            totalVendas: t.totalVendas,
            totalDinheiro: t.totalDinheiro,
            totalPix: t.totalPix,
            totalCartaoCredito: t.totalCartaoCredito,
            totalCartaoDebito: t.totalCartaoDebito,
            totalCrediario: t.totalCrediario,
            totalSangrias: t.totalSangrias,
            totalSuprimentos: t.totalSuprimentos,
            dinheiroEsperado: t.dinheiroEsperado,
            qtdVendas: t.qtdVendas,
          },
          vendedoras,
          movimentos, // sangria + suprimento — lancamento por lancamento (cascata)
          recebimentosCrediario, // baixas de crediario do dia (dinheiro/PIX) — cascata
          detalhado, // slots por modalidade+bandeira+vendas (igual /relatorio-detalhado)
        };
      }),
    );

    // Consolidado
    const consolidado = {
      totalVendas: 0, totalDinheiro: 0, totalPix: 0,
      totalCartaoCredito: 0, totalCartaoDebito: 0, totalCrediario: 0,
      totalSangrias: 0, totalSuprimentos: 0, qtdVendas: 0,
      qtdLojasAbertas: 0, qtdLojasFechadas: 0,
    };
    for (const l of lojas) {
      if (l.aberta) consolidado.qtdLojasAbertas++; else consolidado.qtdLojasFechadas++;
      consolidado.totalVendas += l.totais.totalVendas;
      consolidado.totalDinheiro += l.totais.totalDinheiro;
      consolidado.totalPix += l.totais.totalPix;
      consolidado.totalCartaoCredito += l.totais.totalCartaoCredito;
      consolidado.totalCartaoDebito += l.totais.totalCartaoDebito;
      consolidado.totalCrediario += l.totais.totalCrediario;
      consolidado.totalSangrias += l.totais.totalSangrias;
      consolidado.totalSuprimentos += l.totais.totalSuprimentos;
      consolidado.qtdVendas += l.totais.qtdVendas;
    }

    return {
      lojas,
      consolidado,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Abertura ────────────────────────────────────────────────────────

  /**
   * Abre uma nova sessão de caixa. Se já tiver uma sessão `open`, recusa.
   */
  async openCash(input: {
    storeCode: string;
    storeName: string;
    fundoTroco: number;
    openedByUserId?: string;
    openedByName?: string;
    observacao?: string;
  }) {
    const { storeCode, storeName, fundoTroco, openedByUserId, openedByName, observacao } = input;

    if (!storeCode || !storeName) {
      throw new BadRequestException('Loja é obrigatória');
    }
    if (fundoTroco == null || isNaN(Number(fundoTroco)) || Number(fundoTroco) < 0) {
      throw new BadRequestException('Fundo de troco inválido');
    }

    // Já tem caixa aberto?
    const existing = await this.getCurrentSession(storeCode);
    if (existing) {
      throw new BadRequestException(
        `Já existe um caixa aberto nesta loja desde ${new Date(existing.openedAt).toLocaleString('pt-BR')}. Feche o caixa atual antes de abrir outro.`,
      );
    }

    const session = await (this.prisma as any).pdvCashSession.create({
      data: {
        storeCode,
        storeName,
        fundoTroco: Number(fundoTroco),
        openedByUserId: openedByUserId || null,
        openedByName: openedByName || null,
        observacao: observacao || null,
        status: 'open',
      },
    });

    this.logger.log(
      `[caixa] aberto: loja=${storeCode} fundo=R$${fundoTroco} por ${openedByName || 'sistema'}`,
    );
    return session;
  }

  // ── Sangria/Suprimento ──────────────────────────────────────────────

  /**
   * Registra movimentação durante a sessão (sangria ou suprimento).
   */
  async addMovement(input: {
    storeCode: string;
    tipo: 'sangria' | 'suprimento';
    valor: number;
    motivo: string;
    userId?: string;
    userName?: string;
  }) {
    const { storeCode, tipo, valor, motivo, userId, userName } = input;

    if (!['sangria', 'suprimento'].includes(tipo)) {
      throw new BadRequestException(`Tipo inválido: ${tipo}`);
    }
    if (!motivo || motivo.trim().length < 3) {
      throw new BadRequestException('Informe o motivo da movimentação');
    }
    if (valor == null || isNaN(Number(valor)) || Number(valor) <= 0) {
      throw new BadRequestException('Valor inválido');
    }

    const session = await this.getCurrentSession(storeCode);
    if (!session) {
      throw new BadRequestException('Não há caixa aberto nesta loja. Abra o caixa antes.');
    }

    const movement = await (this.prisma as any).pdvCashMovement.create({
      data: {
        cashSessionId: session.id,
        tipo,
        valor: Number(valor),
        motivo: motivo.trim(),
        userId: userId || null,
        userName: userName || null,
      },
    });

    this.logger.log(
      `[caixa] ${tipo}: loja=${storeCode} R$${valor} motivo="${motivo}" por ${userName || 'sistema'}`,
    );
    return movement;
  }

  /**
   * Busca 1 movimentação por ID (usado pelo impresso de sangria/suprimento).
   */
  async getMovement(id: string) {
    const m = await (this.prisma as any).pdvCashMovement.findUnique({
      where: { id },
    });
    if (!m) throw new BadRequestException('Movimentação não encontrada');
    const session = await (this.prisma as any).pdvCashSession.findUnique({
      where: { id: m.cashSessionId },
      select: { storeCode: true, storeName: true, openedAt: true },
    });
    return {
      id: m.id,
      tipo: m.tipo,
      valor: m.valor,
      motivo: m.motivo,
      userName: m.userName,
      createdAt: m.createdAt,
      storeCode: session?.storeCode ?? null,
      storeName: session?.storeName ?? null,
    };
  }

  /**
   * Lista todas as movimentações da sessão atual.
   */
  async listMovements(storeCode: string) {
    const session = await this.getCurrentSession(storeCode);
    if (!session) return [];
    return (this.prisma as any).pdvCashMovement.findMany({
      where: { cashSessionId: session.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Relatório X (parcial) ───────────────────────────────────────────

  /**
   * Snapshot SEM fechar — pra vendedora conferir durante o dia.
   */
  async getXReport(storeCode: string) {
    const session = await this.getCurrentSession(storeCode);
    if (!session) {
      throw new BadRequestException('Não há caixa aberto nesta loja.');
    }
    const totals = await this.computeSessionTotals(session.id);
    return {
      ...totals,
      isPartial: true,
      generatedAt: new Date(),
    };
  }

  // ── Fechamento Z ────────────────────────────────────────────────────

  /**
   * Fecha o caixa. Calcula totais, persiste snapshot, marca status=closed.
   * Recebe o dinheiro físico contado pra calcular diferença (sobra/falta).
   */
  async closeCash(input: {
    storeCode: string;
    dinheiroFisico: number;
    closedByName?: string;
    observacao?: string;
  }) {
    const { storeCode, dinheiroFisico, closedByName, observacao } = input;

    const session = await this.getCurrentSession(storeCode);
    if (!session) {
      throw new BadRequestException('Não há caixa aberto nesta loja.');
    }

    // Bloqueia fechamento se houver venda em aberto na sessão
    const openSales = await (this.prisma as any).pdvSale.count({
      where: { cashSessionId: session.id, status: 'open' },
    });
    if (openSales > 0) {
      throw new BadRequestException(
        `Existem ${openSales} venda(s) em aberto. Finalize ou cancele antes de fechar o caixa.`,
      );
    }

    if (dinheiroFisico == null || isNaN(Number(dinheiroFisico)) || Number(dinheiroFisico) < 0) {
      throw new BadRequestException('Informe o dinheiro físico contado');
    }

    const totals = await this.computeSessionTotals(session.id);
    const diferenca = Number(dinheiroFisico) - totals.dinheiroEsperado;

    const closed = await (this.prisma as any).pdvCashSession.update({
      where: { id: session.id },
      data: {
        status: 'closed',
        closedAt: new Date(),
        closedByName: closedByName || null,
        observacao: observacao
          ? (session.observacao ? `${session.observacao}\n---\n${observacao}` : observacao)
          : session.observacao,
        totalVendas: totals.totalVendas,
        totalDinheiro: totals.totalDinheiro,
        totalPix: totals.totalPix,
        totalCartaoCredito: totals.totalCartaoCredito,
        totalCartaoDebito: totals.totalCartaoDebito,
        totalCrediario: totals.totalCrediario,
        totalSangrias: totals.totalSangrias,
        totalSuprimentos: totals.totalSuprimentos,
        dinheiroEsperado: totals.dinheiroEsperado,
        dinheiroFisico: Number(dinheiroFisico),
        diferenca,
      },
    });

    this.logger.log(
      `[caixa] fechado: loja=${storeCode} vendas=R$${totals.totalVendas.toFixed(2)} ` +
        `esperado=R$${totals.dinheiroEsperado.toFixed(2)} físico=R$${dinheiroFisico} ` +
        `diferença=R$${diferenca.toFixed(2)} por ${closedByName || 'sistema'}`,
    );

    return { ...closed, ...totals, diferenca };
  }

  // ── Pendências do caixa ─────────────────────────────────────────────

  /**
   * Lista vendas em aberto da sessão atual da loja.
   * Útil pra mostrar pendências antes de fechar o caixa.
   */
  async listOpenSalesInCurrentSession(storeCode: string) {
    const session = await this.getCurrentSession(storeCode);
    if (!session) {
      throw new BadRequestException('Não há caixa aberto nesta loja.');
    }
    const sales = await (this.prisma as any).pdvSale.findMany({
      where: { cashSessionId: session.id, status: 'open' },
      select: {
        id: true,
        storeCode: true,
        total: true,
        customerName: true,
        sellerName: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { sessionId: session.id, vendas: sales };
  }

  /**
   * Cancela TODAS as vendas em aberto da sessão atual e fecha o caixa.
   * Útil quando há vendas zumbis que não aparecem no PDV mas bloqueiam fechamento.
   *
   * Body: mesmo do closeCash + reason opcional pro cancelamento.
   */
  async forceCloseCash(input: {
    storeCode: string;
    dinheiroFisico: number;
    closedByName?: string;
    observacao?: string;
    reason?: string;
  }) {
    const session = await this.getCurrentSession(input.storeCode);
    if (!session) {
      throw new BadRequestException('Não há caixa aberto nesta loja.');
    }
    // Cancela todas vendas em aberto da sessão
    const cancelResult = await (this.prisma as any).pdvSale.updateMany({
      where: { cashSessionId: session.id, status: 'open' },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: input.reason || 'Cancelamento automático ao forçar fechamento de caixa',
      },
    });
    this.logger.warn(
      `[caixa] forceCloseCash: ${cancelResult.count} venda(s) em aberto canceladas na sessão ${session.id}`,
    );
    // Agora fecha normal
    const closed = await this.closeCash({
      storeCode: input.storeCode,
      dinheiroFisico: input.dinheiroFisico,
      closedByName: input.closedByName,
      observacao: input.observacao
        ? `${input.observacao}
[forceCloseCash: ${cancelResult.count} venda(s) canceladas]`
        : `[forceCloseCash: ${cancelResult.count} venda(s) canceladas]`,
    });
    return { ...closed, vendasCanceladas: cancelResult.count };
  }

  // ── Histórico ───────────────────────────────────────────────────────

  /**
   * Lista sessões antigas da loja (default últimas 30 fechadas).
   */
  async listSessions(storeCode: string, limit = 30) {
    const where: any = {};
    if (storeCode) where.storeCode = storeCode;
    return (this.prisma as any).pdvCashSession.findMany({
      where,
      orderBy: { openedAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    });
  }

  /**
   * Detalhe de uma sessão específica (com movimentações + resumo).
   */
  async getSessionDetail(sessionId: string) {
    const totals = await this.computeSessionTotals(sessionId);
    const movements = await (this.prisma as any).pdvCashMovement.findMany({
      where: { cashSessionId: sessionId },
      orderBy: { createdAt: 'asc' },
    });
    return { ...totals, movements };
  }
}
