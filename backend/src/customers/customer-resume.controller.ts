import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CashbackConfigService } from './cashback-config.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { findAllCustomersByCpf, aggregatePerson } from './customer-aggregation.helper';

/**
 * /pdv/customer-resume — ficha do cliente pra PDV. Agregado POR PESSOA
 * (todos os Customers com mesmo CPF/personKey). Cashback é da PESSOA.
 */
@Controller('pdv')
@UseGuards(JwtAuthGuard)
export class CustomerResumeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashbackCfg: CashbackConfigService,
  ) {}

  @Get('customer-resume')
  async resume(@Query('cpf') cpf: string, @Req() req: any) {
    if (!cpf) return { found: false, message: 'CPF nao informado' };
    const digits = String(cpf).replace(/\D/g, '');
    if (digits.length !== 11) return { found: false, message: 'CPF invalido' };

    const storeId = req?.user?.storeId || null;
    const customers = await findAllCustomersByCpf(this.prisma, digits);
    const cashbackCfg = await this.cashbackCfg.getConfig();

    if (customers.length === 0) {
      return { found: false, message: 'Cliente nao encontrado no CRM', cashbackConfig: cashbackCfg };
    }

    const agg = aggregatePerson(customers, storeId);
    const c = agg.primary;

    return {
      found: true,
      customer: {
        id: c.id,
        name: c.name,
        cpf: c.cpf,
        whatsapp: c.whatsapp,
        email: c.email,
        vipTier: agg.vipTier,
        ltvCents: agg.ltvCents,
        orderCount: agg.orderCount,
        ticketMedioCents: agg.ticketMedioCents,
        firstOrderAt: agg.firstOrderAt,
        lastOrderAt: agg.lastOrderAt,
        originSource: c.originSource,
        bloqueado: customers.some((x) => x.bloqueadoGiga),
        negativado: customers.some((x) => x.negativadoGiga),
        cashbackBalanceCents: agg.cashbackBalanceCents,
        cashbackExpiraEm: agg.cashbackExpiraEm,
        cadastrosEm: customers.map((x) => x.originStore?.name).filter(Boolean),
        // Origem do cadastro primário — pra tela avisar "cliente do SITE" /
        // "cliente da loja X" e a vendedora NÃO recadastrar. daLojaAtual=true
        // quando a pessoa tem cadastro na loja que está consultando.
        origem: {
          source: c.originSource || null,
          storeCode: c.originStore?.code || null,
          storeName: c.originStore?.name || null,
          daLojaAtual: !!storeId && c.originStoreId === storeId,
        },
      },
      cashbackConfig: cashbackCfg,
    };
  }

  @Post('sales/:saleId/cashback-redeem')
  async redeem(
    @Param('saleId') saleId: string,
    @Body() body: { valueCents: number },
    @Req() req: any,
  ) {
    const cfg = await this.cashbackCfg.getConfig();
    if (!cfg.ativo) throw new BadRequestException('Programa de cashback PAUSADO');

    const valueCents = Math.max(0, Math.floor(Number(body?.valueCents) || 0));
    if (valueCents <= 0) throw new BadRequestException('Valor invalido');

    const sale = await (this.prisma as any).pdvSale.findUnique({
      where: { id: saleId },
      select: { id: true, status: true, total: true, storeCode: true, customerCpf: true },
    });
    if (!sale) throw new NotFoundException('Venda nao encontrada');
    if (sale.status !== 'open') throw new BadRequestException('Venda esta ' + sale.status);
    if (!sale.customerCpf) throw new BadRequestException('Identifique o cliente primeiro');

    const store = await (this.prisma as any).store.findUnique({
      where: { code: sale.storeCode }, select: { id: true },
    });
    const storeId = store?.id || null;

    const customers = await findAllCustomersByCpf(this.prisma, sale.customerCpf);
    if (customers.length === 0) throw new NotFoundException('Cliente nao esta no CRM');

    const agg = aggregatePerson(customers, storeId);
    const saldoTotal = agg.cashbackBalanceCents;
    const minimoCents = Math.round(cfg.minimoUsoReais * 100);

    if (saldoTotal < minimoCents) {
      throw new BadRequestException('Saldo R$ ' + (saldoTotal / 100).toFixed(2) + ' abaixo do minimo R$ ' + cfg.minimoUsoReais);
    }
    if (valueCents > saldoTotal) {
      throw new BadRequestException('Saldo insuficiente. Disponivel: R$ ' + (saldoTotal / 100).toFixed(2));
    }
    const totalCents = Math.round(Number(sale.total || 0) * 100);
    const maxCents = Math.round((totalCents * cfg.usoMaxPct) / 100);
    if (valueCents > maxCents) {
      throw new BadRequestException('Pode usar no maximo R$ ' + (maxCents / 100).toFixed(2) + ' (' + cfg.usoMaxPct + '%)');
    }

    const userId = req?.user?.sub || req?.user?.id || null;

    // Deduz primeiro do primary, depois dos demais ate completar
    let restante = valueCents;
    const deduzir: Array<{ customerId: string; saldoAntes: number; saldoDepois: number; deduzido: number }> = [];
    const ordered = [agg.primary, ...customers.filter((c) => c.id !== agg.primary.id)];
    for (const c of ordered) {
      if (restante <= 0) break;
      const saldoC = c.cashbackBalance?.balanceCents ?? 0;
      if (saldoC <= 0) continue;
      const ded = Math.min(saldoC, restante);
      deduzir.push({ customerId: c.id, saldoAntes: saldoC, saldoDepois: saldoC - ded, deduzido: ded });
      restante -= ded;
    }

    await (this.prisma as any).$transaction(async (tx: any) => {
      for (const d of deduzir) {
        await tx.cashbackTransaction.create({
          data: {
            customerId: d.customerId, type: 'redeem', valueCents: d.deduzido,
            balanceBeforeCents: d.saldoAntes, balanceAfterCents: d.saldoDepois,
            orderId: sale.id, purchaseValueCents: totalCents,
            description: 'Resgate PDV ' + sale.id.slice(0, 8),
            userId,
          },
        });
        await tx.cashbackBalance.update({
          where: { customerId: d.customerId },
          data: { balanceCents: d.saldoDepois, redeemedTotalCents: { increment: d.deduzido } },
        });
      }
      await tx.pdvSalePayment.create({
        data: {
          saleId: sale.id, method: 'cashback', valor: valueCents / 100,
          details: JSON.stringify({ split: deduzir, saldoAggregateAntes: saldoTotal }),
        },
      });
    });

    return {
      ok: true,
      valorAplicado: valueCents / 100,
      saldoRestante: (saldoTotal - valueCents) / 100,
      splitEntreLojas: deduzir.length > 1,
    };
  }
}
