import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';
import { startOfDayBR, dayBoundsFromUtcDate } from '../lib/date-br';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

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
      where: { cashSessionId: sessionId, status: 'finalized', isTraining: false },
      include: { payments: true },
    });

    let totalVendas = 0;
    let totalMarcados = 0;
    let qtdMarcados = 0;
    const byMethod: Record<string, number> = {
      dinheiro: 0,
      pix: 0,
      credito: 0,
      debito: 0,
      crediario: 0,
      // 15/07: separados de 'outros' pra conciliação — venda online É dinheiro
      // recebido (entra no Recebido); vale-troca NÃO é (abate do Vendido).
      venda_online: 0,
      vale_troca: 0,
      outros: 0,
    };

    for (const s of sales as any[]) {
      // MARCADO nao e venda — e peca que cliente levou pra provar em casa.
      // Nao entra em totalVendas nem em byMethod. Vai pra totalMarcados.
      const pm = String(s.paymentMethod || '').toUpperCase();
      if (pm === 'MARCADO') {
        totalMarcados += Number(s.total) || 0;
        qtdMarcados += 1;
        continue;
      }
      totalVendas += Number(s.total) || 0;
      for (const p of s.payments || []) {
        const method = String(p.method || '').toLowerCase();
        const valor = Number(p.valor) || 0;
        if (method === 'vale_troca' || method === 'vale' || method === 'troca') {
          byMethod.vale_troca += valor;
        } else if (method === 'venda_online' || method === 'online') {
          byMethod.venda_online += valor;
        } else if (method in byMethod) {
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

    // Crediário recebido EM DINHEIRO na janela desta sessão — entra fisicamente
    // na gaveta, então CONTA no dinheiro esperado (não é "venda do dia", mas é
    // dinheiro no caixa). PIX recebido NÃO entra; misto entra só a parte em
    // dinheiro. Escopo = mesma loja, pagas entre abertura e fechamento da sessão
    // (aberta: sem teto). Espelha o cálculo do relatório detalhado.
    const baixasCrediario = await (this.prisma as any).crediarioBaixa.findMany({
      where: {
        lojaCode: session.storeCode,
        status: 'paid',
        createdAt: {
          gte: session.openedAt,
          ...(session.closedAt ? { lte: session.closedAt } : {}),
        },
      },
      select: { formaPagamento: true, totalPago: true, valorDinheiro: true, valorPix: true },
    });
    let recebimentosDinheiro = 0;
    for (const b of baixasCrediario as any[]) {
      const forma = String(b.formaPagamento || '').toLowerCase();
      if (forma === 'misto') {
        const vDin = Number(b.valorDinheiro) || 0;
        const vPix = Number(b.valorPix) || 0;
        // misto antigo sem split preenchido → assume tudo dinheiro (fallback do detalhado)
        recebimentosDinheiro += vDin <= 0 && vPix <= 0 ? Number(b.totalPago) || 0 : vDin;
      } else if (forma !== 'pix') {
        recebimentosDinheiro += Number(b.totalPago) || 0;
      }
    }

    // Dinheiro esperado em caixa = fundo + dinheiro vendido + crediário recebido
    //   em dinheiro + suprimentos - sangrias
    const dinheiroEsperado =
      Number(session.fundoTroco || 0) +
      byMethod.dinheiro +
      recebimentosDinheiro -
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
      totalVendaOnline: byMethod.venda_online,
      totalValeTroca: byMethod.vale_troca,
      totalOutros: byMethod.outros,
      totalMarcados,
      qtdMarcados,
      totalSangrias,
      totalSuprimentos,
      // Crediário recebido em dinheiro que já ESTÁ somado no dinheiroEsperado —
      // exposto pra tela poder mostrar a linha no detalhamento do esperado.
      totalRecebimentosDinheiro: recebimentosDinheiro,
      dinheiroEsperado,
      qtdVendas: sales.length - qtdMarcados,
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
      where: { cashSessionId: session.id, status: 'finalized', isTraining: false },
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
      ELO_DEBITO: mkSlot(),                    // ELO no debito (separa do ELO credito)
      CREDITO_GENERICO: mkSlot(),
      DEBITO_GENERICO: mkSlot(),
      VALE_TROCA: mkSlot(),
      // VENDA ONLINE — WhatsApp/Instagram. NÃO conta no dinheiro físico
      // (já chegou direto na conta). Aparece numa seção separada do fechamento.
      VENDA_ONLINE: mkSlot(),
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
        else if (method === 'venda_online') pushVenda('VENDA_ONLINE', s, p, valor);
        else if (method === 'credito' || method === 'debito') {
          let key = bandeira ? bandeiraMap[bandeira] : null;
          // Quando method=debito + bandeira=ELO, vai pro slot proprio ELO_DEBITO
          if (key === 'ELO' && method === 'debito') key = 'ELO_DEBITO';
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
    //
    // Pagamentos MISTOS (split PIX+Dinheiro) entram em AMBOS os slots:
    // valorDinheiro vai pra recebimentosDinheiro, valorPix vai pra
    // recebimentosPix. Sem esse split, o total inteiro caía em dinheiro e
    // bagunçava o fechamento.
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
      const valorTotal = Number(b.totalPago) || 0;
      const forma = String(b.formaPagamento || '').toLowerCase();
      const baseItems = (b.items || []).map((it: any) => ({
        parcelaNum: it.parcelaNum ?? null,
        totalParcelas: it.totalParcelas ?? null,
        vencimento: it.vencimento || '',
        valorPago: Number(it.valorPago) || 0,
        jurosCalculado: Number(it.jurosCalculado) || 0,
      }));
      const baseVenda = {
        saleId: String(b.id),
        paymentId: String(b.id),
        bandeira: null,
        customerName: b.customerName || null,
        customerCpf: b.customerCpf || null,
        sellerName: b.userName || null,
        finalizedAt: b.paidAt || b.createdAt || null,
        items: baseItems,
      };

      if (forma === 'misto') {
        const vDin = Number(b.valorDinheiro) || 0;
        const vPix = Number(b.valorPix) || 0;
        if (vDin > 0) {
          recebimentosDinheiro.valor += vDin;
          recebimentosDinheiro.qtd += 1;
          recebimentosDinheiro.vendas.push({
            ...baseVenda,
            saleTotal: vDin,
            method: 'misto-dinheiro',
            valor: vDin,
          });
        }
        if (vPix > 0) {
          recebimentosPix.valor += vPix;
          recebimentosPix.qtd += 1;
          recebimentosPix.vendas.push({
            ...baseVenda,
            saleTotal: vPix,
            method: 'misto-pix',
            valor: vPix,
          });
        }
        // Fallback paranoico: baixa misto antiga sem valorDinheiro/Pix
        // preenchido — joga total em dinheiro mas marca pra alertar.
        if (vDin <= 0 && vPix <= 0) {
          recebimentosDinheiro.valor += valorTotal;
          recebimentosDinheiro.qtd += 1;
          recebimentosDinheiro.vendas.push({
            ...baseVenda,
            saleTotal: valorTotal,
            method: 'misto-sem-split',
            valor: valorTotal,
          });
        }
      } else {
        const slot = forma === 'pix' ? recebimentosPix : recebimentosDinheiro;
        slot.valor += valorTotal;
        slot.qtd += 1;
        slot.vendas.push({
          ...baseVenda,
          saleTotal: valorTotal,
          method: forma,
          valor: valorTotal,
        });
      }
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
    const debito = sumSlots(totais.VISA_ELECTRON, totais.REDE_SHOP, totais.ELO_DEBITO, totais.DEBITO_GENERICO);

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

  // `storeCodes` restringe o painel a um CONJUNTO de lojas (ex: master da
  // franquia só vê as lojas tipo=FILIAL). undefined = todas.
  async getSuperPainelCaixas(storeCodes?: string[]): Promise<{
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
      where: {
        active: true,
        ...(storeCodes?.length ? { code: { in: storeCodes } } : {}),
      } as any,
      orderBy: { code: 'asc' },
      select: { code: true, name: true } as any,
    });

    const emptyTotais = {
      totalVendas: 0, totalDinheiro: 0, totalPix: 0,
      totalCartaoCredito: 0, totalCartaoDebito: 0, totalCrediario: 0,
      totalVendaOnline: 0, totalValeTroca: 0,
      totalSangrias: 0, totalSuprimentos: 0, dinheiroEsperado: 0, qtdVendas: 0,
    };

    // Pra cada loja, busca sessão aberta + RELATORIO DETALHADO (paralelo)
    const lojas = await Promise.all(
      (stores as any[]).map(async (s) => {
        const rawSession = await this.getCurrentSession(s.code);
        // Sessão só conta como "atual" se foi aberta HOJE (após 00:00 local).
        // Se for de ontem (esqueceram de fechar), trata como SEM sessão e marca
        // sessaoPendente=true pro frontend exibir alerta.
        const today00 = startOfDayBR();
        const sessionFromToday =
          rawSession && rawSession.openedAt && new Date(rawSession.openedAt) >= today00;
        const session: any = sessionFromToday ? rawSession : null;
        const sessaoPendente = !!(rawSession && !sessionFromToday);
        const sessaoPendenteAbertaEm = sessaoPendente
          ? (rawSession?.openedAt instanceof Date
              ? rawSession.openedAt.toISOString()
              : (rawSession?.openedAt as any))
          : null;

        if (!session) {
          return {
            storeCode: s.code,
            storeName: s.name,
            sessionId: rawSession?.id || null,
            aberta: false,
            sessaoPendente,
            sessaoPendenteAbertaEm,
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
          where: { cashSessionId: session.id, status: 'finalized', isTraining: false },
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
        const inicioHoje = startOfDayBR();
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
            totalVendaOnline: t.totalVendaOnline,
            totalValeTroca: t.totalValeTroca,
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
    const consolidado: any = {
      totalVendas: 0, totalDinheiro: 0, totalPix: 0,
      totalCartaoCredito: 0, totalCartaoDebito: 0, totalCrediario: 0,
      totalVendaOnline: 0, totalValeTroca: 0,
      totalMarcados: 0, qtdMarcados: 0,
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
      consolidado.totalVendaOnline += (l.totais as any).totalVendaOnline || 0;
      consolidado.totalValeTroca += (l.totais as any).totalValeTroca || 0;
      consolidado.totalMarcados += (l.totais as any).totalMarcados || 0;
      consolidado.qtdMarcados += (l.totais as any).qtdMarcados || 0;
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

  // ── Historico por DATA / PERIODO ─────────────────────────────────────

  /**
   * Super-painel agregado por DATA. Diferente do `getSuperPainelCaixas`
   * (que mostra a sessao atual aberta), esse agrega tudo que ocorreu no
   * range [from, to] independente de sessao — pra ver dias passados.
   *
   * Estrutura compativel com o painel ao vivo pra reutilizar componentes
   * do frontend, mas sem detalhamento por sessao (aberta=false sempre).
   */
  async getSuperPainelHistorico(from: Date, to: Date, storeCodes?: string[]): Promise<any> {
    // Normaliza range: from=00:00:00, to=23:59:59 do dia
    // Limites no fuso BR. `from`/`to` chegam como meia-noite UTC da data
    // escolhida (controller: new Date('YYYY-MM-DD'+'T00:00:00')) → lê o YMD.
    const fromStart = dayBoundsFromUtcDate(from).start;
    const toEnd = dayBoundsFromUtcDate(to).end;

    const stores = await this.prisma.store.findMany({
      where: {
        active: true,
        ...(storeCodes?.length ? { code: { in: storeCodes } } : {}),
      } as any,
      orderBy: { code: 'asc' },
      select: { code: true, name: true } as any,
    });

    const lojas = await Promise.all(
      (stores as any[]).map(async (s) => {
        // 1) Vendas finalizadas no range
        // Carrega vendas COM dados completos pra cascata (id, cliente, vendedor, payments com details)
        const sales = await (this.prisma as any).pdvSale.findMany({
          where: {
            storeCode: s.code,
            status: 'finalized',
            isTraining: false,
            finalizedAt: { gte: fromStart, lte: toEnd },
          },
          select: {
            id: true, total: true, paymentMethod: true,
            sellerName: true, vendedorName: true,
            customerName: true, customerCpf: true,
            finalizedAt: true, createdAt: true,
            payments: { select: { id: true, method: true, valor: true, details: true } },
          },
          orderBy: { finalizedAt: 'desc' },
        });

        // Detalhado por bandeira + lista de vendas (igual modo ao vivo, pra cascata)
        type Slot = { valor: number; qtd: number; vendas: any[] };
        const mkSlot = (): Slot => ({ valor: 0, qtd: 0, vendas: [] });
        const totaisDet: Record<string, Slot> = {
          DINHEIRO: mkSlot(), PIX: mkSlot(), CREDIARIO: mkSlot(),
          MASTERCARD: mkSlot(), VISANET: mkSlot(), CIELO: mkSlot(), ELO: mkSlot(),
          AMEX: mkSlot(), HIPERCARD: mkSlot(), VISA_ELECTRON: mkSlot(),
          REDE_SHOP: mkSlot(),
          ELO_DEBITO: mkSlot(),                // ELO no debito (slot proprio)
          CREDITO_GENERICO: mkSlot(), DEBITO_GENERICO: mkSlot(),
          VALE_TROCA: mkSlot(),
          VENDA_ONLINE: mkSlot(),
          OUTROS: mkSlot(),
        };
        const bandeiraMap: Record<string, string> = {
          'MASTERCARD': 'MASTERCARD', 'VISA': 'VISANET', 'VISANET': 'VISANET',
          'CIELO': 'CIELO', 'ELO': 'ELO', 'AMEX': 'AMEX',
          'AMERICAN EXPRESS': 'AMEX', 'HIPERCARD': 'HIPERCARD',
          'VISA ELECTRON': 'VISA_ELECTRON', 'VISA_ELECTRON': 'VISA_ELECTRON',
          'VISAELECTRON': 'VISA_ELECTRON', 'REDESHOP': 'REDE_SHOP',
          'REDE SHOP': 'REDE_SHOP', 'REDE_SHOP': 'REDE_SHOP',
        };
        const pushVenda = (key: string, sale: any, payment: any, valor: number, parcelas?: number, bandeira?: string | null) => {
          totaisDet[key].valor += valor;
          totaisDet[key].qtd += 1;
          totaisDet[key].vendas.push({
            saleId: String(sale.id),
            saleTotal: Number(sale.total) || 0,
            paymentId: String(payment.id),
            method: String(payment.method || ''),
            bandeira: bandeira || null,
            valor,
            customerName: sale.customerName || null,
            customerCpf: sale.customerCpf || null,
            sellerName: sale.sellerName || sale.vendedorName || null,
            finalizedAt: sale.finalizedAt instanceof Date ? sale.finalizedAt.toISOString() : (sale.finalizedAt || sale.createdAt || null),
            parcelas,
          });
        };

        let totalVendas = 0;
        let totalMarcados = 0;
        let qtdMarcados = 0;
        let qtdVendasReais = 0;
        let totalDinheiro = 0, totalPix = 0, totalCartaoCredito = 0, totalCartaoDebito = 0, totalCrediario = 0, totalValeTroca = 0, totalVendaOnline = 0;
        const ranking: Record<string, { nome: string; qtd: number; total: number }> = {};

        for (const sale of sales as any[]) {
          // MARCADO nao conta como venda — separa em totalMarcados
          const pm = String(sale.paymentMethod || '').toUpperCase();
          if (pm === 'MARCADO') {
            totalMarcados += Number(sale.total) || 0;
            qtdMarcados += 1;
            continue;
          }
          totalVendas += Number(sale.total) || 0;
          qtdVendasReais += 1;
          const nome = String(sale.sellerName || sale.vendedorName || 'Sem vendedora').trim();
          if (!ranking[nome]) ranking[nome] = { nome, qtd: 0, total: 0 };
          ranking[nome].qtd += 1;
          ranking[nome].total += Number(sale.total) || 0;

          for (const p of (sale.payments as any[]) || []) {
            const v = Number(p.valor) || 0;
            const m = String(p.method || '').toLowerCase();
            let bandeira: string | null = null;
            let parcelas: number | undefined = undefined;
            if (p.details) {
              try {
                const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
                if (det?.bandeira) bandeira = String(det.bandeira).toUpperCase().trim();
                if (det?.parcelas) parcelas = Number(det.parcelas);
              } catch { /* ignora */ }
            }
            if (m === 'dinheiro') { totalDinheiro += v; pushVenda('DINHEIRO', sale, p, v); }
            else if (m === 'pix') { totalPix += v; pushVenda('PIX', sale, p, v); }
            else if (m === 'crediario') { totalCrediario += v; pushVenda('CREDIARIO', sale, p, v, parcelas); }
            else if (m === 'vale_troca' || m === 'vale' || m === 'troca') {
              totalValeTroca += v;
              pushVenda('VALE_TROCA' as any, sale, p, v);
            }
            else if (m === 'venda_online' || m === 'online') {
              totalVendaOnline += v;
              pushVenda('VENDA_ONLINE' as any, sale, p, v);
            }
            else if (m === 'credito' || m === 'credit') {
              totalCartaoCredito += v;
              const key = bandeira ? bandeiraMap[bandeira] : null;
              if (key && key in totaisDet) pushVenda(key, sale, p, v, parcelas, bandeira);
              else pushVenda('CREDITO_GENERICO', sale, p, v, parcelas, bandeira);
            } else if (m === 'debito' || m === 'debit') {
              totalCartaoDebito += v;
              // Quando bandeira eh ELO no DEBITO, vai pro slot proprio
              // (ELO_DEBITO) — evita misturar com ELO_CREDITO.
              const keyBandeira = bandeira ? bandeiraMap[bandeira] : null;
              const key = keyBandeira === 'ELO' ? 'ELO_DEBITO' : keyBandeira;
              if (key && key in totaisDet) pushVenda(key, sale, p, v, parcelas, bandeira);
              else pushVenda('DEBITO_GENERICO', sale, p, v, parcelas, bandeira);
            } else {
              pushVenda('OUTROS', sale, p, v);
            }
          }
        }
        const vendedoras = Object.values(ranking).sort((a, b) => b.total - a.total);

        // 2) Recebimentos de crediario no range
        const baixas = await (this.prisma as any).crediarioBaixa.findMany({
          where: { lojaCode: s.code, status: 'paid', paidAt: { gte: fromStart, lte: toEnd } },
          select: {
            id: true, formaPagamento: true, origem: true, totalPago: true,
            valorDinheiro: true, valorPix: true, customerName: true, paidAt: true,
          },
          orderBy: { paidAt: 'desc' },
        });
        let recTotal = 0, recDinheiro = 0, recPix = 0;
        const recBaixas: any[] = [];
        for (const b of baixas as any[]) {
          const total = Number(b.totalPago) || 0;
          const vd = Number(b.valorDinheiro) || 0;
          const vp = Number(b.valorPix) || 0;
          recTotal += total;
          // BUG FIX (02/07): valorDinheiro/valorPix SÓ existem em baixa MISTA.
          // Baixa normal (dinheiro OU pix) tem os dois nulos — somar só eles
          // zerava os subtotais e a CASCATA sumia no modo histórico (o
          // cabeçalho mostrava "3 baixas · R$ 635" mas expandia vazio).
          // Mesma regra do modo ao vivo: decide pela FORMA.
          const forma = String(b.formaPagamento || '').toLowerCase();
          if (forma === 'misto') {
            recDinheiro += vd;
            recPix += vp;
          } else if (forma === 'dinheiro') {
            recDinheiro += total;
          } else if (forma === 'pix') {
            recPix += total;
          }
          recBaixas.push({
            id: b.id,
            forma: String(b.formaPagamento || '').toLowerCase(),
            origem: b.origem || null,
            valor: total,
            valorDinheiro: vd || null,
            valorPix: vp || null,
            customerName: b.customerName || null,
            paidAt: b.paidAt instanceof Date ? b.paidAt.toISOString() : String(b.paidAt),
          });
        }

        // 3) Sangrias/suprimentos via cashSessions abertas no range
        // Também pega fundoTroco da sessão + checkedAt/checkedByName.
        const sessions = await (this.prisma as any).pdvCashSession.findMany({
          where: { storeCode: s.code, openedAt: { gte: fromStart, lte: toEnd } },
          select: {
            id: true,
            fundoTroco: true,
            openedAt: true,
            closedAt: true,
            checkedAt: true,
            checkedByName: true,
            checkedNote: true,
          } as any,
          orderBy: { openedAt: 'asc' },
        });
        let totalSangrias = 0, totalSuprimentos = 0;
        const movimentos: any[] = [];
        // FUNDO DO DIA = fundo da PRIMEIRA sessão (fix 02/07). Antes SOMAVA
        // os fundos de todas as sessões — mas reabertura de caixa carrega o
        // MESMO dinheiro físico da gaveta: somar contava o fundo 2-3× (loja
        // com 3 aberturas de ~R$ 637 mostrava R$ 1.911 de "abertura") e
        // inflava o "dinheiro fim de dia" da conferência. Dinheiro colocado
        // na gaveta DURANTE o dia é SUPRIMENTO, não fundo.
        const fundoTrocoDoDia = Number((sessions as any[])[0]?.fundoTroco) || 0;
        // Última sessão do dia conferida (pra mostrar "Conferido por X em Y")
        const ultimoCheck = (sessions as any[])
          .filter((x) => x.checkedAt)
          .sort((a, b) => new Date(b.checkedAt).getTime() - new Date(a.checkedAt).getTime())[0];
        if (sessions.length > 0) {
          const movs = await (this.prisma as any).pdvCashMovement.findMany({
            where: { cashSessionId: { in: sessions.map((x: any) => x.id) } },
            orderBy: { createdAt: 'desc' },
            select: { id: true, tipo: true, valor: true, motivo: true, userName: true, createdAt: true },
          });
          for (const m of movs as any[]) {
            const v = Number(m.valor) || 0;
            if (m.tipo === 'sangria') totalSangrias += v;
            else if (m.tipo === 'suprimento') totalSuprimentos += v;
            movimentos.push({
              id: m.id, tipo: m.tipo, valor: v, motivo: m.motivo || '',
              userName: m.userName || null,
              createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : String(m.createdAt),
            });
          }
        }

        // Dinheiro esperado fim de dia = fundo + vendas dinheiro + suprimentos
        //   + crediarios recebidos em dinheiro - sangrias.
        // Esse é o valor que deveria estar fisicamente no caixa ao fechar
        // (e que vira fundo do dia seguinte se a operadora deixou tudo no caixa).
        const dinheiroEsperadoFimDia = Math.round(
          (fundoTrocoDoDia + totalDinheiro + totalSuprimentos + recDinheiro - totalSangrias) * 100,
        ) / 100;

        // Pega primeira sessão pra referência (sessionId pra check, openedBy, etc)
        const primeiraSessao = (sessions as any[])[0];

        return {
          storeCode: s.code,
          storeName: s.name,
          sessionId: primeiraSessao?.id || null,
          aberta: false,
          openedAt: primeiraSessao?.openedAt
            ? (primeiraSessao.openedAt instanceof Date ? primeiraSessao.openedAt.toISOString() : String(primeiraSessao.openedAt))
            : null,
          openedByName: null,
          fundoTroco: fundoTrocoDoDia,
          checkedAt: ultimoCheck?.checkedAt
            ? (ultimoCheck.checkedAt instanceof Date
                ? ultimoCheck.checkedAt.toISOString()
                : String(ultimoCheck.checkedAt))
            : null,
          checkedByName: ultimoCheck?.checkedByName || null,
          checkedNote: ultimoCheck?.checkedNote || null,
          // sessionsDoDia: lista de IDs pra ter o que marcar quando user clica "Conferir"
          sessionsDoDia: (sessions as any[]).map((x) => x.id),
          totais: {
            totalVendas,
            totalDinheiro,
            totalPix,
            totalCartaoCredito,
            totalCartaoDebito,
            totalCrediario,
            totalValeTroca,
            totalVendaOnline,
            totalMarcados,
            qtdMarcados,
            totalSangrias,
            totalSuprimentos,
            dinheiroEsperado: dinheiroEsperadoFimDia,
            qtdVendas: qtdVendasReais,
          },
          vendedoras,
          movimentos,
          recebimentosCrediario: {
            totalGeral: recTotal,
            totalDinheiro: recDinheiro,
            totalPix: recPix,
            baixas: recBaixas,
          },
          detalhado: { totais: totaisDet },
        };
      }),
    );

    // Consolidado
    const consolidado = {
      totalVendas: 0, totalDinheiro: 0, totalPix: 0,
      totalCartaoCredito: 0, totalCartaoDebito: 0, totalCrediario: 0,
      totalValeTroca: 0, totalVendaOnline: 0,
      totalMarcados: 0, qtdMarcados: 0,
      totalSangrias: 0, totalSuprimentos: 0, qtdVendas: 0,
      qtdLojasAbertas: 0, qtdLojasFechadas: lojas.length,
    };
    for (const l of lojas) {
      consolidado.totalVendas += l.totais.totalVendas;
      consolidado.totalDinheiro += l.totais.totalDinheiro;
      consolidado.totalPix += l.totais.totalPix;
      consolidado.totalCartaoCredito += l.totais.totalCartaoCredito;
      consolidado.totalCartaoDebito += l.totais.totalCartaoDebito;
      consolidado.totalCrediario += l.totais.totalCrediario;
      consolidado.totalValeTroca += (l.totais as any).totalValeTroca || 0;
      consolidado.totalVendaOnline += (l.totais as any).totalVendaOnline || 0;
      consolidado.totalMarcados += l.totais.totalMarcados;
      consolidado.qtdMarcados += l.totais.qtdMarcados;
      consolidado.totalSangrias += l.totais.totalSangrias;
      consolidado.totalSuprimentos += l.totais.totalSuprimentos;
      consolidado.qtdVendas += l.totais.qtdVendas;
    }

    return {
      lojas,
      consolidado,
      range: { from: fromStart.toISOString(), to: toEnd.toISOString() },
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

    // Ja tem caixa aberto?
    const existing = await this.getCurrentSession(storeCode);
    let autoClosedInfo: any = null;
    if (existing) {
      // Se a sessao aberta eh de um DIA ANTERIOR (vendedora esqueceu de
      // fechar ontem), faz AUTO-CLOSE com os totais calculados — pra ter
      // o demonstrativo do dia salvo e abrir um caixa novo limpo HOJE.
      // Mesma logica do Wincred: ao abrir caixa, ele gera "retirada final"
      // do dia anterior automaticamente.
      const inicioHoje = startOfDayBR();
      const openedAt = new Date(existing.openedAt);
      const ehDeOntemOuAntes = openedAt < inicioHoje;
      if (ehDeOntemOuAntes) {
        // Calcula totais da sessao antiga
        const totals = await this.computeSessionTotals(existing.id);
        // ── REGRA: dinheiroFisico = fundoTroco informado pela vendedora HOJE ──
        // Lógica: quem fecha de noite só zera, quem abre de manhã conta o
        // dinheiro do caixa. Esse valor contado é o "dinheiro físico" real
        // que ficou ontem (e vira fundo de troco de hoje). Evita contar 2x.
        // Diferença = físico - esperado → mostra furo/sobra real do caixa.
        const fisicoContado = Number(fundoTroco);
        const diferenca = Math.round((fisicoContado - totals.dinheiroEsperado) * 100) / 100;
        try {
          await (this.prisma as any).pdvCashSession.update({
            where: { id: existing.id },
            data: {
              status: 'closed',
              closedAt: new Date(),
              closedByName: openedByName
                ? `${openedByName} (contagem na abertura do dia seguinte)`
                : 'SISTEMA (auto-close ao abrir novo)',
              observacao: existing.observacao
                ? `${existing.observacao}\n---\nFechada em ${new Date().toLocaleString('pt-BR')} com contagem da abertura do dia seguinte. Físico R$ ${fisicoContado.toFixed(2)} | Esperado R$ ${totals.dinheiroEsperado.toFixed(2)} | Diferença R$ ${diferenca.toFixed(2)}.`
                : `Fechada em ${new Date().toLocaleString('pt-BR')} com contagem da abertura do dia seguinte. Físico R$ ${fisicoContado.toFixed(2)} | Esperado R$ ${totals.dinheiroEsperado.toFixed(2)} | Diferença R$ ${diferenca.toFixed(2)}.`,
              totalVendas: totals.totalVendas,
              totalDinheiro: totals.totalDinheiro,
              totalPix: totals.totalPix,
              totalCartaoCredito: totals.totalCartaoCredito,
              totalCartaoDebito: totals.totalCartaoDebito,
              totalCrediario: totals.totalCrediario,
              totalSangrias: totals.totalSangrias,
              totalSuprimentos: totals.totalSuprimentos,
              dinheiroEsperado: totals.dinheiroEsperado,
              dinheiroFisico: fisicoContado,
              diferenca,
            },
          });
          autoClosedInfo = {
            sessionId: existing.id,
            openedAt: existing.openedAt,
            totalVendas: totals.totalVendas,
            dinheiroEsperado: totals.dinheiroEsperado,
            dinheiroFisico: fisicoContado,
            diferenca,
          };
          this.logger.log(
            `[caixa] FECHA-COM-CONTAGEM: loja=${storeCode} sessao=${existing.id} ` +
            `aberta em ${new Date(existing.openedAt).toLocaleString('pt-BR')} ` +
            `vendas=R$${totals.totalVendas.toFixed(2)} esperado=R$${totals.dinheiroEsperado.toFixed(2)} ` +
            `fisico=R$${fisicoContado.toFixed(2)} diff=R$${diferenca.toFixed(2)} ` +
            `por ${openedByName || 'SISTEMA'} (contagem na abertura)`,
          );
        } catch (e: any) {
          this.logger.error(`[caixa] auto-close FALHOU: ${e?.message || e}`);
          throw new BadRequestException(
            `Falha ao auto-fechar caixa do dia anterior: ${e?.message || e}. Feche manual em /pdv/fechamento.`,
          );
        }
      } else {
        // Mesmo dia — fluxo antigo: nao deixa abrir outro caixa
        throw new BadRequestException(
          `Ja existe um caixa aberto nesta loja desde ${openedAt.toLocaleString('pt-BR')}. Feche o caixa atual antes de abrir outro.`,
        );
      }
    }

    // Se NÃO houve auto-close (sessão antiga já estava fechada), tenta
    // atualizar a última sessão fechada SEM contagem física com o fundoTroco
    // informado. Cenário: caixa foi fechado ontem (manual ou auto-close cron)
    // sem ninguém contar dinheiro → hoje a vendedora conta na abertura e
    // esse valor vira o dinheiroFisico retroativo do dia anterior.
    let contagemRetroativa: any = null;
    if (!autoClosedInfo) {
      const ultimaFechada = await (this.prisma as any).pdvCashSession.findFirst({
        where: {
          storeCode,
          status: 'closed',
          dinheiroFisico: null, // só atualiza se ainda não tem contagem
        },
        orderBy: { closedAt: 'desc' },
      });
      if (ultimaFechada) {
        const fisicoContado = Number(fundoTroco);
        const esperado = Number(ultimaFechada.dinheiroEsperado || 0);
        const diferenca = Math.round((fisicoContado - esperado) * 100) / 100;
        try {
          await (this.prisma as any).pdvCashSession.update({
            where: { id: ultimaFechada.id },
            data: {
              dinheiroFisico: fisicoContado,
              diferenca,
              observacao: ultimaFechada.observacao
                ? `${ultimaFechada.observacao}\n---\nContagem registrada na abertura do dia seguinte em ${new Date().toLocaleString('pt-BR')} por ${openedByName || 'sistema'}: Físico R$ ${fisicoContado.toFixed(2)} | Esperado R$ ${esperado.toFixed(2)} | Diferença R$ ${diferenca.toFixed(2)}.`
                : `Contagem registrada na abertura do dia seguinte em ${new Date().toLocaleString('pt-BR')} por ${openedByName || 'sistema'}: Físico R$ ${fisicoContado.toFixed(2)} | Esperado R$ ${esperado.toFixed(2)} | Diferença R$ ${diferenca.toFixed(2)}.`,
            },
          });
          contagemRetroativa = {
            sessionId: ultimaFechada.id,
            closedAt: ultimaFechada.closedAt,
            dinheiroEsperado: esperado,
            dinheiroFisico: fisicoContado,
            diferenca,
          };
          this.logger.log(
            `[caixa] CONTAGEM-RETROATIVA: loja=${storeCode} sessao=${ultimaFechada.id} ` +
            `esperado=R$${esperado.toFixed(2)} fisico=R$${fisicoContado.toFixed(2)} diff=R$${diferenca.toFixed(2)} ` +
            `por ${openedByName || 'sistema'} (na abertura do caixa novo)`,
          );
        } catch (e: any) {
          // Não bloqueia abertura se o update retroativo falhar — só loga
          this.logger.warn(
            `[caixa] falha ao atualizar contagem retroativa do dia anterior (sessao=${ultimaFechada.id}): ${e?.message || e}`,
          );
        }
      }
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
      `[caixa] aberto: loja=${storeCode} fundo=R$${fundoTroco} por ${openedByName || 'sistema'}` +
      (autoClosedInfo ? ` (apos auto-close da sessao ${autoClosedInfo.sessionId})` : '') +
      (contagemRetroativa ? ` (contagem retroativa registrada na sessao ${contagemRetroativa.sessionId})` : ''),
    );
    return { ...session, autoClosed: autoClosedInfo, contagemRetroativa };
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
    /** MODO TREINAMENTO — não conta no caixa real, mesma sessão mas filtrado */
    isTraining?: boolean;
  }) {
    const { storeCode, tipo, valor, motivo, userId, userName, isTraining } = input;

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
        isTraining: !!isTraining,
      },
    });

    this.logger.log(
      `[caixa] ${tipo}: loja=${storeCode} R$${valor} motivo="${motivo}" por ${userName || 'sistema'}`,
    );
    return movement;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AUDIT MASTER — grava toda alteracao master em MasterAudit (imutavel)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Registra 1 entrada de auditoria. Nunca lanca — se falhar, so loga warn.
   * userName eh esperado no formato "[LEVEL] nome" (vem do controller).
   */
  private async recordAudit(input: {
    action: string;
    entityType: string;
    entityId: string;
    storeCode?: string | null;
    storeName?: string | null;
    userName?: string | null;
    oldValue?: any;
    newValue?: any;
    motivo: string;
  }) {
    try {
      const userNameStr = String(input.userName || 'unknown');
      // Extrai level do prefixo "[LEVEL] nome"
      const levelMatch = userNameStr.match(/^\[(\w+)\]/);
      const level = levelMatch ? levelMatch[1] : 'UNKNOWN';
      const cleanUserName = userNameStr.replace(/^\[\w+\]\s*/, '');

      await (this.prisma as any).masterAudit.create({
        data: {
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          storeCode: input.storeCode || null,
          storeName: input.storeName || null,
          level,
          userName: cleanUserName,
          oldValue: input.oldValue != null ? JSON.stringify(input.oldValue) : null,
          newValue: input.newValue != null ? JSON.stringify(input.newValue) : null,
          motivo: input.motivo,
        },
      });
    } catch (e: any) {
      this.logger.warn(`audit grava falhou (nao bloqueia): ${e?.message}`);
    }
  }

  /**
   * Lista entradas de auditoria com filtros. Paginado por page+size.
   */
  async listMasterAudit(filters: {
    storeCode?: string;
    action?: string;
    fromDate?: string;
    toDate?: string;
    userName?: string;
    page?: number;
    size?: number;
  }) {
    const page = Math.max(1, Number(filters.page || 1));
    const size = Math.min(200, Math.max(10, Number(filters.size || 50)));
    const where: any = {};
    if (filters.storeCode) where.storeCode = filters.storeCode;
    if (filters.action) where.action = filters.action;
    if (filters.userName) where.userName = { contains: filters.userName };
    if (filters.fromDate || filters.toDate) {
      where.createdAt = {};
      if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate + 'T00:00:00');
      if (filters.toDate) where.createdAt.lte = new Date(filters.toDate + 'T23:59:59');
    }
    const [total, items] = await Promise.all([
      (this.prisma as any).masterAudit.count({ where }),
      (this.prisma as any).masterAudit.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * size,
        take: size,
      }),
    ]);
    return {
      total,
      page,
      size,
      items: items.map((it: any) => ({
        ...it,
        oldValue: it.oldValue ? this._safeParse(it.oldValue) : null,
        newValue: it.newValue ? this._safeParse(it.newValue) : null,
      })),
    };
  }

  private _safeParse(s: string) {
    try { return JSON.parse(s); } catch { return s; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AJUSTES MASTER (admin com senha) — fundo de caixa + sangria/suprimento
  // Permite mexer em sessoes abertas OU na ultima fechada do dia (correcoes).
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolve a sessao "ajustavel" da loja: aberta atual, ou a ultima fechada
   * do dia corrente. Lanca se nao tiver nada.
   */
  private async getLatestAdjustableSession(storeCode: string) {
    if (!storeCode) throw new BadRequestException('Loja obrigatoria');
    const open = await this.getCurrentSession(storeCode);
    if (open) return open;
    // Tenta ultima fechada do dia
    const inicioHoje = startOfDayBR();
    const closed = await (this.prisma as any).pdvCashSession.findFirst({
      where: {
        storeCode,
        status: 'closed',
        OR: [
          { closedAt: { gte: inicioHoje } },
          { openedAt: { gte: inicioHoje } },
        ],
      },
      orderBy: { closedAt: 'desc' },
    });
    if (!closed) {
      throw new BadRequestException('Nenhuma sessao de caixa do dia para ajustar');
    }
    return closed;
  }

  /**
   * Sobrescreve o fundo de caixa (fundoTroco) da sessao atual/ultima do dia.
   * Audit logado. Recalcula totais se a sessao ja estiver fechada.
   */
  async masterAdjustFundo(input: {
    storeCode: string;
    valor: number;
    motivo: string;
    userName?: string | null;
    /** YYYY-MM-DD (opcional): ajusta o fundo da PRIMEIRA sessão DESSE dia.
     *  É o que o super painel HISTÓRICO mostra como "Fundo do caixa
     *  (abertura)" — sem a data, o ajuste ia pra última sessão e o valor
     *  do painel não mudava ("não consigo arrumar"). */
    date?: string | null;
  }) {
    const { storeCode, valor, motivo, userName } = input;
    if (valor == null || isNaN(Number(valor)) || Number(valor) < 0) {
      throw new BadRequestException('Fundo invalido');
    }
    if (!motivo || motivo.trim().length < 3) {
      throw new BadRequestException('Informe o motivo do ajuste (>=3 chars)');
    }
    let session: any;
    if (input.date && /^\d{4}-\d{2}-\d{2}$/.test(String(input.date).trim())) {
      const bounds = dayBoundsFromUtcDate(new Date(`${String(input.date).trim()}T00:00:00`));
      session = await (this.prisma as any).pdvCashSession.findFirst({
        where: { storeCode, openedAt: { gte: bounds.start, lte: bounds.end } },
        orderBy: { openedAt: 'asc' },
      });
      if (!session) {
        throw new BadRequestException(
          `Nenhuma sessão de caixa da loja ${storeCode} em ${input.date}`,
        );
      }
    } else {
      session = await this.getLatestAdjustableSession(storeCode);
    }
    const old = Number(session.fundoTroco || 0);
    const novo = Number(valor);

    await (this.prisma as any).pdvCashSession.update({
      where: { id: session.id },
      data: { fundoTroco: novo },
    });

    // Se sessao ja fechou, recalcula dinheiroEsperado e diferenca
    if (session.status === 'closed') {
      const totals = await this.computeSessionTotals(session.id);
      const fisico = Number(session.dinheiroFisico ?? 0);
      const novaDiff = fisico - totals.dinheiroEsperado;
      await (this.prisma as any).pdvCashSession.update({
        where: { id: session.id },
        data: {
          dinheiroEsperado: totals.dinheiroEsperado,
          diferenca: novaDiff,
        },
      });
    }

    this.logger.warn(
      `[MASTER] FUNDO ajustado: loja=${storeCode} session=${session.id} ${old} -> ${novo} motivo="${motivo}" por ${userName || 'admin'}`,
    );
    await this.recordAudit({
      action: 'fundo',
      entityType: 'session',
      entityId: session.id,
      storeCode,
      storeName: session.storeName,
      userName,
      oldValue: { fundoTroco: old },
      newValue: { fundoTroco: novo },
      motivo: motivo.trim(),
    });
    return { ok: true, sessionId: session.id, fundoAnterior: old, fundoNovo: novo };
  }

  /**
   * Cria sangria/suprimento via senha master. Aceita sessao aberta OU
   * fechada do dia (correcoes pos-fechamento).
   */
  async masterAddMovement(input: {
    storeCode: string;
    tipo: 'sangria' | 'suprimento';
    valor: number;
    motivo: string;
    userName?: string | null;
    /** YYYY-MM-DD (opcional): grava o movimento na sessão DESSE dia — a que o
     *  super painel HISTÓRICO exibe. Sem a data (ao vivo com caixa aberto), o
     *  movimento ia pra última sessão de HOJE e o painel do dia filtrado não
     *  mudava ("não grava"). Mesmo fix que já foi feito no masterAdjustFundo. */
    date?: string | null;
  }) {
    const { storeCode, tipo, valor, motivo, userName } = input;
    if (!['sangria', 'suprimento'].includes(tipo)) {
      throw new BadRequestException(`Tipo invalido: ${tipo}`);
    }
    if (valor == null || isNaN(Number(valor)) || Number(valor) <= 0) {
      throw new BadRequestException('Valor invalido');
    }
    if (!motivo || motivo.trim().length < 3) {
      throw new BadRequestException('Informe o motivo (>=3 chars)');
    }
    let session: any;
    if (input.date && /^\d{4}-\d{2}-\d{2}$/.test(String(input.date).trim())) {
      const bounds = dayBoundsFromUtcDate(new Date(`${String(input.date).trim()}T00:00:00`));
      // 1ª sessão do dia (mesma referência que o painel histórico usa pro fundo).
      // O histórico soma os movimentos de TODAS as sessões do dia, então anexar
      // à primeira já faz o lançamento aparecer no total do dia filtrado.
      session = await (this.prisma as any).pdvCashSession.findFirst({
        where: { storeCode, openedAt: { gte: bounds.start, lte: bounds.end } },
        orderBy: { openedAt: 'asc' },
      });
      if (!session) {
        throw new BadRequestException(
          `Nenhuma sessão de caixa da loja ${storeCode} em ${input.date}`,
        );
      }
    } else {
      session = await this.getLatestAdjustableSession(storeCode);
    }

    const movement = await (this.prisma as any).pdvCashMovement.create({
      data: {
        cashSessionId: session.id,
        tipo,
        valor: Number(valor),
        motivo: `[MASTER] ${motivo.trim()}`,
        userId: null,
        userName: `MASTER (${userName || 'admin'})`,
      },
    });

    // Recalcula totais da sessao fechada se for o caso
    if (session.status === 'closed') {
      const totals = await this.computeSessionTotals(session.id);
      const fisico = Number(session.dinheiroFisico ?? 0);
      const novaDiff = fisico - totals.dinheiroEsperado;
      await (this.prisma as any).pdvCashSession.update({
        where: { id: session.id },
        data: {
          totalSangrias: totals.totalSangrias,
          totalSuprimentos: totals.totalSuprimentos,
          dinheiroEsperado: totals.dinheiroEsperado,
          diferenca: novaDiff,
        },
      });
    }

    this.logger.warn(
      `[MASTER] ${tipo.toUpperCase()}: loja=${storeCode} session=${session.id} R$${valor} motivo="${motivo}" por ${userName || 'admin'}`,
    );
    await this.recordAudit({
      action: 'movement_create',
      entityType: 'movement',
      entityId: movement.id,
      storeCode,
      storeName: session.storeName,
      userName,
      oldValue: null,
      newValue: { tipo, valor: Number(valor) },
      motivo: motivo.trim(),
    });
    return { ok: true, movement };
  }

  /**
   * Estorna (deleta) uma sangria/suprimento via senha master.
   */
  async masterDeleteMovement(input: {
    movementId: string;
    userName?: string | null;
  }) {
    const { movementId, userName } = input;
    const m = await (this.prisma as any).pdvCashMovement.findUnique({
      where: { id: movementId },
    });
    if (!m) throw new NotFoundException('Movimentacao nao encontrada');

    const session = await (this.prisma as any).pdvCashSession.findUnique({
      where: { id: m.cashSessionId },
    });

    await (this.prisma as any).pdvCashMovement.delete({ where: { id: movementId } });

    if (session && session.status === 'closed') {
      const totals = await this.computeSessionTotals(session.id);
      const fisico = Number(session.dinheiroFisico ?? 0);
      const novaDiff = fisico - totals.dinheiroEsperado;
      await (this.prisma as any).pdvCashSession.update({
        where: { id: session.id },
        data: {
          totalSangrias: totals.totalSangrias,
          totalSuprimentos: totals.totalSuprimentos,
          dinheiroEsperado: totals.dinheiroEsperado,
          diferenca: novaDiff,
        },
      });
    }

    this.logger.warn(
      `[MASTER] DELETE movement=${movementId} tipo=${m.tipo} R$${m.valor} por ${userName || 'admin'}`,
    );
    await this.recordAudit({
      action: 'movement_delete',
      entityType: 'movement',
      entityId: movementId,
      storeCode: session?.storeCode,
      storeName: session?.storeName,
      userName,
      oldValue: { tipo: m.tipo, valor: Number(m.valor), motivo: m.motivo },
      newValue: null,
      motivo: 'Estorno via master',
    });
    return { ok: true };
  }

  /**
   * MASTER: edita valor e/ou motivo de uma sangria/suprimento existente.
   * Recalcula os totais da sessão se ela já fechou (mesma lógica de add/delete).
   * Audit imutável em MasterAudit com o antes/depois.
   */
  async masterUpdateMovement(input: {
    movementId: string;
    valor?: number;
    motivo?: string;
    userName?: string | null;
  }) {
    const { movementId, userName } = input;
    const m = await (this.prisma as any).pdvCashMovement.findUnique({
      where: { id: movementId },
    });
    if (!m) throw new NotFoundException('Movimentacao nao encontrada');

    const data: any = {};
    if (input.valor != null) {
      const v = Number(input.valor);
      if (isNaN(v) || v <= 0) throw new BadRequestException('Valor invalido');
      data.valor = v;
    }
    if (input.motivo != null) {
      const mt = String(input.motivo).trim();
      if (mt.length < 3) throw new BadRequestException('Informe o motivo (>=3 chars)');
      data.motivo = mt;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nada pra atualizar (informe valor e/ou motivo)');
    }

    const updated = await (this.prisma as any).pdvCashMovement.update({
      where: { id: movementId },
      data,
    });

    const session = await (this.prisma as any).pdvCashSession.findUnique({
      where: { id: m.cashSessionId },
    });
    if (session && session.status === 'closed') {
      const totals = await this.computeSessionTotals(session.id);
      const fisico = Number(session.dinheiroFisico ?? 0);
      const novaDiff = fisico - totals.dinheiroEsperado;
      await (this.prisma as any).pdvCashSession.update({
        where: { id: session.id },
        data: {
          totalSangrias: totals.totalSangrias,
          totalSuprimentos: totals.totalSuprimentos,
          dinheiroEsperado: totals.dinheiroEsperado,
          diferenca: novaDiff,
        },
      });
    }

    this.logger.warn(
      `[MASTER] UPDATE movement=${movementId} tipo=${m.tipo} R$${m.valor}->R$${updated.valor} por ${userName || 'admin'}`,
    );
    await this.recordAudit({
      action: 'movement_update',
      entityType: 'movement',
      entityId: movementId,
      storeCode: session?.storeCode,
      storeName: session?.storeName,
      userName,
      oldValue: { tipo: m.tipo, valor: Number(m.valor), motivo: m.motivo },
      newValue: { tipo: m.tipo, valor: Number(updated.valor), motivo: updated.motivo },
      motivo: (input.motivo || '').trim() || 'Edicao via master',
    });
    return { ok: true, movement: updated };
  }

  /**
   * MASTER: edita um pagamento de venda — troca method, valor e/ou bandeira.
   * Usado pra correcoes pos-fato (caixa marcou dinheiro mas era PIX, etc).
   * Audit em PdvPaymentAudit. Re-validacao da sessao se ja fechou.
   */
  async masterEditPayment(input: {
    paymentId: string;
    novoMethod?: string;
    novoValor?: number;
    novaBandeira?: string;
    motivo: string;
    userName?: string | null;
  }) {
    const { paymentId, novoMethod, novoValor, novaBandeira, motivo, userName } = input;
    if (!paymentId) throw new BadRequestException('paymentId obrigatorio');
    if (!motivo || motivo.trim().length < 3) {
      throw new BadRequestException('Informe o motivo da alteracao');
    }

    const METHODS_VALIDOS = new Set(['dinheiro', 'pix', 'credito', 'debito', 'crediario']);
    if (novoMethod && !METHODS_VALIDOS.has(novoMethod)) {
      throw new BadRequestException(`Metodo invalido: ${novoMethod}`);
    }
    if (novoValor != null && (isNaN(Number(novoValor)) || Number(novoValor) <= 0)) {
      throw new BadRequestException('Valor invalido');
    }
    if (novaBandeira && !this.BANDEIRAS_VALIDAS.has(String(novaBandeira).toUpperCase())) {
      throw new BadRequestException(`Bandeira invalida: ${novaBandeira}`);
    }

    const payment = await (this.prisma as any).pdvSalePayment.findUnique({
      where: { id: paymentId },
      include: { sale: { select: { id: true, storeCode: true, cashSessionId: true } } },
    });
    if (!payment) throw new NotFoundException('Pagamento nao encontrado');

    let details: any = {};
    try { details = payment.details ? JSON.parse(payment.details) : {}; } catch { details = {}; }

    const oldMethod = payment.method;
    const oldValor = Number(payment.valor || 0);
    const oldBandeira = String(details?.bandeira || '').trim().toUpperCase();

    const finalMethod = novoMethod || oldMethod;
    const finalValor = novoValor != null ? Number(novoValor) : oldValor;
    const finalBandeira = novaBandeira != null ? String(novaBandeira).toUpperCase() : oldBandeira;

    // Sem mudanca real? Aborta
    if (finalMethod === oldMethod && finalValor === oldValor && finalBandeira === oldBandeira) {
      return { ok: true, noChange: true };
    }

    const newDetails = { ...details };
    if (novaBandeira != null) newDetails.bandeira = finalBandeira;
    const newDetailsJson = JSON.stringify(newDetails);

    // Audit
    try {
      await (this.prisma as any).pdvPaymentAudit.create({
        data: {
          paymentId: payment.id,
          saleId: payment.saleId,
          oldMethod,
          oldValor,
          oldDetails: payment.details || null,
          newMethod: finalMethod,
          newValor: finalValor,
          newDetails: newDetailsJson,
          changedByUserId: null,
          changedByUserName: userName || 'MASTER',
          changedByRole: 'master',
          reason: `[MASTER] ${motivo.trim()}`,
        },
      });
    } catch (e: any) {
      this.logger.warn(`audit falhou (nao bloqueia): ${e?.message}`);
    }

    await (this.prisma as any).pdvSalePayment.update({
      where: { id: paymentId },
      data: {
        method: finalMethod,
        valor: finalValor,
        details: newDetailsJson,
      },
    });

    // Se a sessao ja fechou, recalcula totais
    if (payment.sale?.cashSessionId) {
      const session = await (this.prisma as any).pdvCashSession.findUnique({
        where: { id: payment.sale.cashSessionId },
      });
      if (session && session.status === 'closed') {
        const totals: any = await this.computeSessionTotals(session.id);
        const fisico = Number(session.dinheiroFisico ?? 0);
        const bm = totals.byMethod || {};
        await (this.prisma as any).pdvCashSession.update({
          where: { id: session.id },
          data: {
            totalDinheiro: bm.dinheiro,
            totalPix: bm.pix,
            totalCartaoCredito: bm.credito,
            totalCartaoDebito: bm.debito,
            totalCrediario: bm.crediario,
            dinheiroEsperado: totals.dinheiroEsperado,
            diferenca: fisico - totals.dinheiroEsperado,
          },
        });
      }
    }

    // Best-effort Wincred update se bandeira mudou
    let wincredResult: any = null;
    if (novaBandeira != null && oldBandeira !== finalBandeira) {
      try {
        wincredResult = await this.erp.atualizarBandeiraFechamento({
          saleId: payment.saleId,
          storeCode: payment.sale?.storeCode || '',
          oldBandeira,
          newBandeira: finalBandeira,
          valor: finalValor,
        });
      } catch (e: any) {
        this.logger.error(`Wincred update falhou: ${e?.message}`);
        wincredResult = { ok: false, error: e?.message };
      }
    }

    this.logger.warn(
      `[MASTER] EDIT payment=${paymentId} method:${oldMethod}->${finalMethod} valor:${oldValor}->${finalValor} bandeira:${oldBandeira}->${finalBandeira} por ${userName || 'admin'} motivo="${motivo}"`,
    );

    await this.recordAudit({
      action: 'payment_edit',
      entityType: 'payment',
      entityId: paymentId,
      storeCode: payment.sale?.storeCode,
      userName,
      oldValue: { method: oldMethod, valor: oldValor, bandeira: oldBandeira },
      newValue: { method: finalMethod, valor: finalValor, bandeira: finalBandeira },
      motivo: motivo.trim(),
    });

    return {
      ok: true,
      paymentId,
      saleId: payment.saleId,
      old: { method: oldMethod, valor: oldValor, bandeira: oldBandeira },
      new: { method: finalMethod, valor: finalValor, bandeira: finalBandeira },
      wincred: wincredResult,
    };
  }

  /**
   * MASTER: troca a vendedora de uma venda inteira (PdvSale.sellerName).
   * Por padrao limpa o override de items (item.sellerName = null), exceto se applyToItemsToo=false.
   */
  async masterUpdateSaleSeller(input: {
    saleId: string;
    novoSellerName: string;
    motivo: string;
    keepItemOverrides?: boolean;
    userName?: string | null;
  }) {
    const { saleId, novoSellerName, motivo, keepItemOverrides, userName } = input;
    if (!saleId) throw new BadRequestException('saleId obrigatorio');
    const novo = String(novoSellerName || '').trim();
    if (!novo || novo.length < 2) {
      throw new BadRequestException('Nome de vendedora invalido');
    }
    if (!motivo || motivo.trim().length < 3) {
      throw new BadRequestException('Informe o motivo (>=3 chars)');
    }

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      select: { id: true, sellerName: true, vendedorName: true, storeCode: true },
    });
    if (!sale) throw new NotFoundException('Venda nao encontrada');

    const old = sale.sellerName || sale.vendedorName || '';

    await (this.prisma as any).pdvSale.update({
      where: { id: saleId },
      data: { sellerName: novo, vendedorName: novo },
    });

    // Por padrao limpa overrides nos itens — assim a venda toda volta a ter
    // sellerName unificado. Se keepItemOverrides=true, mantem o que ja foi
    // ajustado por item.
    if (!keepItemOverrides) {
      await (this.prisma as any).pdvSaleItem.updateMany({
        where: { saleId },
        data: { sellerName: null },
      });
    }

    this.logger.warn(
      `[MASTER] SELLER (sale) saleId=${saleId} "${old}" -> "${novo}" por ${userName || 'admin'} motivo="${motivo}"`,
    );
    await this.recordAudit({
      action: 'sale_seller',
      entityType: 'sale',
      entityId: saleId,
      storeCode: sale.storeCode,
      userName,
      oldValue: { sellerName: old },
      newValue: { sellerName: novo },
      motivo: motivo.trim(),
    });
    return { ok: true, saleId, old, new: novo };
  }

  /**
   * MASTER: troca a vendedora de UM item especifico (PdvSaleItem.sellerName).
   * Usado quando 2 vendedoras atendem na mesma compra.
   * NUll = remove override (volta a usar a vendedora da venda).
   */
  async masterUpdateItemSeller(input: {
    itemId: string;
    novoSellerName: string | null;
    motivo: string;
    userName?: string | null;
  }) {
    const { itemId, novoSellerName, motivo, userName } = input;
    if (!itemId) throw new BadRequestException('itemId obrigatorio');
    if (!motivo || motivo.trim().length < 3) {
      throw new BadRequestException('Informe o motivo (>=3 chars)');
    }
    const novo = novoSellerName == null ? null : String(novoSellerName).trim();
    if (novo != null && novo.length < 2) {
      throw new BadRequestException('Nome de vendedora invalido');
    }

    const item = await (this.prisma as any).pdvSaleItem.findUnique({
      where: { id: itemId },
      select: { id: true, saleId: true, sellerName: true, descricao: true, ref: true },
    });
    if (!item) throw new NotFoundException('Item nao encontrado');

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: item.saleId },
      select: { sellerName: true, vendedorName: true },
    });
    const old = item.sellerName || sale?.sellerName || sale?.vendedorName || '';

    await (this.prisma as any).pdvSaleItem.update({
      where: { id: itemId },
      data: { sellerName: novo },
    });

    this.logger.warn(
      `[MASTER] SELLER (item) itemId=${itemId} ref=${item.ref || '-'} "${old}" -> "${novo || '(limpo)'}" por ${userName || 'admin'} motivo="${motivo}"`,
    );
    await this.recordAudit({
      action: 'item_seller',
      entityType: 'sale_item',
      entityId: itemId,
      userName,
      oldValue: { sellerName: old, ref: item.ref },
      newValue: { sellerName: novo },
      motivo: motivo.trim(),
    });
    return { ok: true, itemId, old, new: novo };
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
  /**
   * Fecha automaticamente TODAS as sessões de caixa que estão abertas desde
   * um DIA ANTERIOR ao atual. Salva os totais calculados (igual fechamento
   * normal) sem exigir conferência de dinheiro físico.
   *
   * Usos:
   *  - Endpoint admin manual (`POST /pdv/cash/admin/auto-close-expired`)
   *  - Cron diário ~23:55 (não implementado ainda, mas o método tá pronto)
   *
   * Marca closedByName='SISTEMA (auto-close ao final do dia)' pra rastrear.
   *
   * Retorna { closed: N, details: [...] }.
   */
  /**
   * Marca uma ou mais sessões como CONFERIDAS — admin/CEO bateu o caixa contra
   * o Wincred no dia seguinte e confirma que tá tudo OK (ou anota a diferença).
   * Idempotente: se chamar 2x, atualiza a data/usuário pro mais recente.
   *
   * @param sessionIds — IDs de PdvCashSession (geralmente 1 dia de uma loja)
   * @param userId — ID do admin que conferiu
   * @param userName — Nome pra mostrar no painel
   * @param note — Observação opcional (ex: "Diferença R$ 2,00 — sangria não anotada")
   */
  async markSessionsAsChecked(input: {
    sessionIds: string[];
    userId: string | null;
    userName: string;
    note?: string;
  }): Promise<{ updated: number }> {
    const { sessionIds, userId, userName, note } = input;
    if (!sessionIds?.length) {
      throw new BadRequestException('Nenhuma sessão informada');
    }
    if (!userName?.trim()) {
      throw new BadRequestException('Nome do conferente é obrigatório');
    }
    const result = await (this.prisma as any).pdvCashSession.updateMany({
      where: { id: { in: sessionIds } },
      data: {
        checkedAt: new Date(),
        checkedByUserId: userId,
        checkedByName: userName.trim(),
        checkedNote: note?.trim() || null,
      },
    });
    this.logger.log(
      `[caixa] CONFERIDO: ${result.count} sessao(oes) por ${userName} (sessions=${sessionIds.join(',')})`,
    );
    return { updated: result.count };
  }

  /**
   * Desfaz a conferência (caso o admin tenha marcado por engano).
   */
  async unmarkSessionsAsChecked(input: {
    sessionIds: string[];
  }): Promise<{ updated: number }> {
    if (!input.sessionIds?.length) {
      throw new BadRequestException('Nenhuma sessão informada');
    }
    const result = await (this.prisma as any).pdvCashSession.updateMany({
      where: { id: { in: input.sessionIds } },
      data: {
        checkedAt: null,
        checkedByUserId: null,
        checkedByName: null,
        checkedNote: null,
      },
    });
    return { updated: result.count };
  }

  async autoCloseExpiredSessions(): Promise<{ closed: number; details: any[] }> {
    const inicioHoje = startOfDayBR();

    const expired = await (this.prisma as any).pdvCashSession.findMany({
      where: {
        status: 'open',
        openedAt: { lt: inicioHoje },
      } as any,
      select: { id: true, storeCode: true, storeName: true, openedAt: true } as any,
    });

    const details: any[] = [];
    for (const s of expired as any[]) {
      try {
        const totals = await this.computeSessionTotals(s.id);
        await (this.prisma as any).pdvCashSession.update({
          where: { id: s.id },
          data: {
            status: 'closed',
            closedAt: new Date(),
            closedByName: 'SISTEMA (auto-close fim do dia)',
            observacao: `Sessão de ${new Date(s.openedAt).toLocaleDateString('pt-BR')} fechada automaticamente em ${new Date().toLocaleString('pt-BR')}.`,
            totalVendas: totals.totalVendas,
            totalDinheiro: totals.totalDinheiro,
            totalPix: totals.totalPix,
            totalCartaoCredito: totals.totalCartaoCredito,
            totalCartaoDebito: totals.totalCartaoDebito,
            totalCrediario: totals.totalCrediario,
            totalSangrias: totals.totalSangrias,
            totalSuprimentos: totals.totalSuprimentos,
            dinheiroEsperado: totals.dinheiroEsperado,
            dinheiroFisico: totals.dinheiroEsperado,
            diferenca: 0,
          },
        });
        details.push({
          sessionId: s.id,
          storeCode: s.storeCode,
          storeName: s.storeName,
          openedAt: s.openedAt,
          totalVendas: totals.totalVendas,
          ok: true,
        });
        this.logger.log(`[auto-close-expired] ${s.storeCode} ${s.storeName} → R$${totals.totalVendas.toFixed(2)}`);
      } catch (e: any) {
        details.push({
          sessionId: s.id,
          storeCode: s.storeCode,
          storeName: s.storeName,
          ok: false,
          error: e?.message || String(e),
        });
        this.logger.error(`[auto-close-expired] FALHA ${s.storeCode}: ${e?.message}`);
      }
    }
    return { closed: details.filter((d) => d.ok).length, details };
  }

  async closeCash(input: {
    storeCode: string;
    dinheiroFisico?: number | null;
    closedByName?: string;
    observacao?: string;
  }) {
    const { storeCode, dinheiroFisico, closedByName, observacao } = input;

    const session = await this.getCurrentSession(storeCode);
    if (!session) {
      throw new BadRequestException('Não há caixa aberto nesta loja.');
    }

    // Venda em aberto NÃO bloqueia mais o fechamento (dono 21/07 — o erro
    // "Existem N venda(s) em aberto" atrapalhava todo fim de dia). Vendas
    // abertas nessa hora são zumbis (carrinho não finalizado): cancela
    // automaticamente, registra na observação e segue o fechamento — mesmo
    // comportamento do antigo botão "Cancelar pendências e fechar caixa".
    // Venda finalizada NUNCA é tocada aqui.
    const zumbis = await (this.prisma as any).pdvSale.updateMany({
      where: { cashSessionId: session.id, status: 'open' },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: 'Cancelamento automático no fechamento do caixa (venda não finalizada)',
      },
    });
    let obsZumbis = '';
    if (zumbis.count > 0) {
      obsZumbis = `[fechamento: ${zumbis.count} venda(s) em aberto cancelada(s) automaticamente]`;
      this.logger.warn(
        `[caixa] closeCash ${storeCode}: ${zumbis.count} venda(s) zumbi canceladas na sessão ${session.id}`,
      );
    }

    // dinheiroFisico agora é OPCIONAL — a contagem é feita pela vendedora ao
    // ABRIR o caixa do dia seguinte (vira dinheiroFisico retroativo dessa sessão).
    // Se foi informado mesmo assim (cenário legado), usa o valor; senão deixa null.
    const fisicoInformado =
      dinheiroFisico != null && !isNaN(Number(dinheiroFisico)) && Number(dinheiroFisico) >= 0
        ? Number(dinheiroFisico)
        : null;

    const totals = await this.computeSessionTotals(session.id);
    const diferenca =
      fisicoInformado != null ? fisicoInformado - totals.dinheiroEsperado : null;

    const closed = await (this.prisma as any).pdvCashSession.update({
      where: { id: session.id },
      data: {
        status: 'closed',
        closedAt: new Date(),
        closedByName: closedByName || null,
        observacao: (() => {
          const partes = [session.observacao, observacao, obsZumbis].filter(Boolean);
          return partes.length ? partes.join('\n---\n') : null;
        })(),
        totalVendas: totals.totalVendas,
        totalDinheiro: totals.totalDinheiro,
        totalPix: totals.totalPix,
        totalCartaoCredito: totals.totalCartaoCredito,
        totalCartaoDebito: totals.totalCartaoDebito,
        totalCrediario: totals.totalCrediario,
        totalSangrias: totals.totalSangrias,
        totalSuprimentos: totals.totalSuprimentos,
        dinheiroEsperado: totals.dinheiroEsperado,
        dinheiroFisico: fisicoInformado,
        diferenca,
      },
    });

    this.logger.log(
      `[caixa] fechado: loja=${storeCode} vendas=R$${totals.totalVendas.toFixed(2)} ` +
        `esperado=R$${totals.dinheiroEsperado.toFixed(2)} ` +
        (fisicoInformado != null
          ? `físico=R$${fisicoInformado.toFixed(2)} diferença=R$${(diferenca ?? 0).toFixed(2)}`
          : `físico=PENDENTE (será contado na abertura do dia seguinte)`) +
        ` por ${closedByName || 'sistema'}`,
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
    dinheiroFisico?: number | null;
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

  // ─────────────────────────────────────────────────────────────────────
  //  Edição de bandeira de pagamento (admin only)
  // ─────────────────────────────────────────────────────────────────────

  private readonly BANDEIRAS_VALIDAS = new Set([
    'MASTERCARD', 'VISANET', 'CIELO', 'ELO', 'AMEX', 'HIPERCARD',
    'VISA_ELECTRON', 'REDE_SHOP',
    'CREDITO_GENERICO', 'DEBITO_GENERICO', 'OUTROS',
  ]);

  /**
   * Admin troca bandeira de um pagamento (ex: operadora errou MASTERCARD em vez de VISANET).
   * Atualiza Postgres + audit + Wincred (fechamento) — Wincred é best effort.
   */
  async updatePaymentBandeira(
    paymentId: string,
    novaBandeira: string,
    reason: string | undefined,
    user: { id?: string; sub?: string; name?: string; role?: string } | undefined,
  ) {
    if (!paymentId) throw new BadRequestException('paymentId obrigatório');
    if (user?.role !== 'admin') throw new ForbiddenException('Apenas admin pode editar bandeira');

    const nova = String(novaBandeira || '').trim().toUpperCase();
    if (!this.BANDEIRAS_VALIDAS.has(nova)) {
      throw new BadRequestException(`Bandeira inválida: "${nova}"`);
    }

    const payment = await (this.prisma as any).pdvSalePayment.findUnique({
      where: { id: paymentId },
      include: { sale: { select: { id: true, storeCode: true, total: true } } },
    });
    if (!payment) throw new NotFoundException('Pagamento não encontrado');

    let details: any = {};
    try { details = payment.details ? JSON.parse(payment.details) : {}; } catch { details = {}; }
    const bandeiraAntiga = String(details?.bandeira || '').trim().toUpperCase();
    if (bandeiraAntiga === nova) {
      return { ok: true, alreadyApplied: true, message: 'Bandeira já está correta' };
    }
    const newDetails = { ...details, bandeira: nova };
    const newDetailsJson = JSON.stringify(newDetails);

    try {
      await (this.prisma as any).pdvPaymentAudit.create({
        data: {
          paymentId: payment.id,
          saleId: payment.saleId,
          oldMethod: payment.method,
          oldValor: payment.valor,
          oldDetails: payment.details || null,
          newMethod: payment.method,
          newValor: payment.valor,
          newDetails: newDetailsJson,
          changedByUserId: user?.id || user?.sub || null,
          changedByUserName: user?.name || null,
          changedByRole: user?.role || null,
          reason: reason || `Troca de bandeira: ${bandeiraAntiga || '(vazio)'} → ${nova}`,
        },
      });
    } catch (e: any) {
      this.logger.warn(`audit falhou (não bloqueia): ${e?.message}`);
    }

    await (this.prisma as any).pdvSalePayment.update({
      where: { id: paymentId },
      data: { details: newDetailsJson },
    });

    let wincredResult: any = { ok: false, skipped: true };
    try {
      wincredResult = await this.erp.atualizarBandeiraFechamento({
        saleId: payment.saleId,
        storeCode: payment.sale?.storeCode || '',
        oldBandeira: bandeiraAntiga,
        newBandeira: nova,
        valor: Number(payment.valor) || 0,
      });
    } catch (e: any) {
      this.logger.error(`Wincred update falhou: ${e?.message}`);
      wincredResult = { ok: false, error: e?.message };
    }

    return {
      ok: true,
      paymentId,
      saleId: payment.saleId,
      oldBandeira: bandeiraAntiga,
      newBandeira: nova,
      wincred: wincredResult,
    };
  }
}
