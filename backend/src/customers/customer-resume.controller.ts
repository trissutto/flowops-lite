import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CashbackConfigService } from './cashback-config.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

/**
 * /pdv/customer-resume — endpoint LEVE pra PDV consultar ficha do cliente
 * no momento da venda. Retorna nome, tier, LTV, saldo de cashback e
 * configuração ativa (% uso máximo, mínimo, ativo).
 *
 * Usado pelo card "Resumo do cliente" no PDV quando vendedora identifica.
 */
@Controller('pdv')
@UseGuards(JwtAuthGuard)
export class CustomerResumeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashbackCfg: CashbackConfigService,
  ) {}

  @Get('customer-resume')
  async resume(@Query('cpf') cpf: string) {
    if (!cpf) return { found: false, message: 'CPF não informado' };
    const digits = String(cpf).replace(/\D/g, '');
    if (digits.length !== 11) return { found: false, message: 'CPF inválido' };

    const cpfFmt = `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;

    const customer = await (this.prisma as any).customer.findFirst({
      where: { OR: [{ cpf: digits }, { cpf: cpfFmt }] },
      select: {
        id: true,
        name: true,
        cpf: true,
        whatsapp: true,
        email: true,
        vipTier: true,
        ltvCents: true,
        orderCount: true,
        ticketMedioCents: true,
        firstOrderAt: true,
        lastOrderAt: true,
        originSource: true,
        bloqueadoGiga: true,
        negativadoGiga: true,
        cashbackBalance: {
          select: {
            balanceCents: true,
            nextExpirationAt: true,
          },
        },
      },
    });

    const cashbackCfg = await this.cashbackCfg.getConfig();

    if (!customer) {
      return {
        found: false,
        message: 'Cliente não encontrado no CRM',
        cashbackConfig: cashbackCfg,
      };
    }

    return {
      found: true,
      customer: {
        id: customer.id,
        name: customer.name,
        cpf: customer.cpf,
        whatsapp: customer.whatsapp,
        email: customer.email,
        vipTier: customer.vipTier,
        ltvCents: Number(customer.ltvCents ?? 0),
        orderCount: customer.orderCount ?? 0,
        ticketMedioCents: customer.ticketMedioCents ?? 0,
        firstOrderAt: customer.firstOrderAt,
        lastOrderAt: customer.lastOrderAt,
        originSource: customer.originSource,
        bloqueado: !!customer.bloqueadoGiga,
        negativado: !!customer.negativadoGiga,
        cashbackBalanceCents: customer.cashbackBalance?.balanceCents ?? 0,
        cashbackExpiraEm: customer.cashbackBalance?.nextExpirationAt ?? null,
      },
      cashbackConfig: cashbackCfg,
    };
  }
}
