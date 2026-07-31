import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ADIANTAMENTO DE FUNCIONÁRIA — dinheiro adiantado via sangria do caixa que
 * vira débito no extrato da funcionária e é abatido no PRÓXIMO pagamento dela
 * (vale/salário — o que vier primeiro). Sem senha pra liberar (registra quem
 * lançou).
 */
@Injectable()
export class AdiantamentosService {
  private readonly logger = new Logger(AdiantamentosService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Lista funcionárias ativas pro seletor da sangria (id, nome, cpf). */
  async funcionariasOptions(q?: string) {
    const term = String(q || '').trim();
    return (this.prisma as any).seller.findMany({
      where: { active: true, ...(term ? { name: { contains: term, mode: 'insensitive' } } : {}) },
      select: { id: true, name: true, cpf: true },
      orderBy: { name: 'asc' },
      take: 20,
    });
  }

  /** Cria o adiantamento (chamado logo após a sangria tirar o dinheiro do caixa). */
  async criar(input: {
    sellerId?: string | null;
    sellerNome: string;
    sellerCpf?: string | null;
    storeCode: string;
    valorCents: number;
    cashMovementId?: string | null;
    motivo?: string | null;
    userId?: string | null;
    userName?: string | null;
  }) {
    return (this.prisma as any).adiantamentoFuncionaria.create({
      data: {
        sellerId: input.sellerId || null,
        sellerNome: input.sellerNome,
        sellerCpf: input.sellerCpf || null,
        storeCode: input.storeCode,
        valorCents: Math.round(input.valorCents),
        cashMovementId: input.cashMovementId || null,
        status: 'pendente',
        motivo: input.motivo || null,
        userId: input.userId || null,
        userName: input.userName || null,
      },
    });
  }

  private whereSeller(sellerId?: string | null, sellerNome?: string | null, status?: string): any | null {
    const base: any = status ? { status } : {};
    if (sellerId) return { ...base, sellerId };
    if (sellerNome) return { ...base, sellerNome };
    return null;
  }

  /** Saldo devedor (adiantamentos pendentes) de uma funcionária, em centavos. */
  async saldoPendenteCents(sellerId?: string | null, sellerNome?: string | null): Promise<number> {
    const where = this.whereSeller(sellerId, sellerNome, 'pendente');
    if (!where) return 0;
    const agg = await (this.prisma as any).adiantamentoFuncionaria.aggregate({ _sum: { valorCents: true }, where });
    return Number(agg?._sum?.valorCents || 0);
  }

  /** Lista os adiantamentos de uma funcionária (extrato). */
  async listBySeller(sellerId?: string | null, sellerNome?: string | null) {
    const where = this.whereSeller(sellerId, sellerNome);
    if (!where) return [];
    return (this.prisma as any).adiantamentoFuncionaria.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  /** Saldos pendentes agrupados por funcionária (pra aba Funcionárias). */
  async saldosPendentes(): Promise<Array<{ sellerId: string | null; sellerNome: string; cents: number }>> {
    const grouped: any[] = await (this.prisma as any).adiantamentoFuncionaria.groupBy({
      by: ['sellerId', 'sellerNome'],
      where: { status: 'pendente' },
      _sum: { valorCents: true },
    });
    return grouped.map((g) => ({ sellerId: g.sellerId, sellerNome: g.sellerNome, cents: Number(g._sum?.valorCents || 0) }));
  }

  /**
   * Abate adiantamentos pendentes de uma funcionária até `maxCents` (o valor do
   * pagamento). Marca os que couberem como 'abatido' (linkados na conta); se um
   * adiantamento é maior que o restante, quebra em (abatido) + (resto pendente).
   * Devolve o total abatido em centavos.
   */
  async abaterParaConta(input: {
    sellerId?: string | null;
    sellerNome?: string | null;
    contaId: string;
    maxCents: number;
  }): Promise<number> {
    const where = this.whereSeller(input.sellerId, input.sellerNome, 'pendente');
    if (!where || input.maxCents <= 0) return 0;
    const pendentes: any[] = await (this.prisma as any).adiantamentoFuncionaria.findMany({
      where,
      orderBy: { createdAt: 'asc' }, // mais antigo primeiro
    });
    let restante = Math.round(input.maxCents);
    let abatido = 0;
    for (const a of pendentes) {
      if (restante <= 0) break;
      if (a.valorCents <= restante) {
        await (this.prisma as any).adiantamentoFuncionaria.update({
          where: { id: a.id },
          data: { status: 'abatido', abatidoEmContaId: input.contaId, abatidoAt: new Date() },
        });
        restante -= a.valorCents;
        abatido += a.valorCents;
      } else {
        // Abate parcial: este registro vira o pedaço abatido; o resto vira novo pendente.
        const resto = a.valorCents - restante;
        await (this.prisma as any).adiantamentoFuncionaria.update({
          where: { id: a.id },
          data: { valorCents: restante, status: 'abatido', abatidoEmContaId: input.contaId, abatidoAt: new Date() },
        });
        await (this.prisma as any).adiantamentoFuncionaria.create({
          data: {
            sellerId: a.sellerId, sellerNome: a.sellerNome, sellerCpf: a.sellerCpf,
            storeCode: a.storeCode, valorCents: resto, status: 'pendente',
            cashMovementId: a.cashMovementId,
            motivo: 'Resto de adiantamento parcialmente abatido',
          },
        });
        abatido += restante;
        restante = 0;
      }
    }
    if (abatido > 0) {
      this.logger.log(`[adiantamento] abatido ${abatido}c da funcionária ${input.sellerId || input.sellerNome} na conta ${input.contaId}`);
    }
    return abatido;
  }
}
