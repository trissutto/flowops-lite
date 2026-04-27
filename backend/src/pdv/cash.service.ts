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
