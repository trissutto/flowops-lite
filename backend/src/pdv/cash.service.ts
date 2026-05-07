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
    const session = await this.getCurrentSession(storeCode);
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
        valor: number;          // valor do pagamento (pode ser parcial em split)
        customerName: string | null;
        customerCpf: string | null;
        sellerName: string | null;
        finalizedAt: string | null;
        parcelas?: number;
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

    const pushVenda = (key: string, sale: any, paymentValor: number, parcelas?: number) => {
      totais[key].valor += paymentValor;
      totais[key].qtd += 1;
      totais[key].vendas.push({
        saleId: String(sale.id),
        saleTotal: Number(sale.total) || 0,
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

        if (method === 'dinheiro') pushVenda('DINHEIRO', s, valor);
        else if (method === 'pix') pushVenda('PIX', s, valor);
        else if (method === 'crediario') pushVenda('CREDIARIO', s, valor, parcelas);
        else if (method === 'credito' || method === 'debito') {
          const key = bandeira ? bandeiraMap[bandeira] : null;
          if (key && key in totais) {
            pushVenda(key, s, valor, parcelas);
          } else {
            pushVenda(method === 'credito' ? 'CREDITO_GENERICO' : 'DEBITO_GENERICO', s, valor, parcelas);
          }
        } else {
          pushVenda('OUTROS', s, valor);
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
        valor,
        customerName: b.customerName || null,
        customerCpf: b.customerCpf || null,
        sellerName: b.userName || null,
        finalizedAt: b.paidAt || b.createdAt || null,
      });
    }

    // Movimentações de caixa
    const movements = await (this.prisma as any).pdvCashMovement.findMany({
      where: { sessionId: session.id },
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
      totais.DINHEIRO -
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
