import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { LivePdvService } from './live-pdv.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Controller PÚBLICO (SEM JwtAuthGuard) — página de fechamento da cliente.
 *
 * A apresentadora manda o link /pagar/<cartId> pra cliente. Ela informa o CEP
 * (calcula frete), escolhe PIX (PagBank) ou cartão até 12x sem juros (link
 * Pagar.me) e paga. A confirmação é automática (mesmo cron/webhook da live).
 *
 * Segurança: o cartId é um UUID (não adivinhável) e o único dado sensível
 * exposto é o primeiro nome + itens + total. Nada de CPF/telefone/custo.
 */
@Controller('public/live-pay')
export class LivePayPublicController {
  constructor(
    private readonly svc: LivePdvService,
    private readonly prisma: PrismaService,
  ) {}

  // O :cartId aceita o UUID antigo OU o payCode curto (/p/<code>).
  @Get(':cartId')
  async summary(@Param('cartId') key: string) {
    const cartId = await this.svc.resolvePublicCartId(key);
    return this.svc.publicCheckoutSummary(cartId);
  }

  @Get(':cartId/status')
  async status(@Param('cartId') key: string) {
    const cartId = await this.svc.resolvePublicCartId(key);
    const r: any = await this.svc.checkPayment(cartId);
    return { paid: !!r?.paid };
  }

  @Post(':cartId/frete')
  async frete(@Param('cartId') key: string, @Body() body: { cep?: string }) {
    const digits = String(body?.cep || '').replace(/\D/g, '');
    if (digits.length !== 8) {
      throw new BadRequestException('CEP inválido. Digite os 8 números.');
    }
    const cartId = await this.svc.resolvePublicCartId(key);
    return this.svc.computeFreteFromCep(cartId, digits);
  }

  @Post(':cartId/pix')
  async pix(@Param('cartId') key: string) {
    const cartId = await this.svc.resolvePublicCartId(key);
    await this.guardPayable(cartId);
    return this.svc.startPayment(cartId);
  }

  @Post(':cartId/card')
  async card(@Param('cartId') key: string) {
    const cartId = await this.svc.resolvePublicCartId(key);
    await this.guardPayable(cartId);
    return this.svc.startPaymentLink(cartId);
  }

  /** Só deixa cobrar se: existe, não está pago e já tem CEP (frete calculado). */
  private async guardPayable(cartId: string): Promise<void> {
    const cart = await (this.prisma as any).livePdvCart.findUnique({ where: { id: cartId } });
    if (!cart) throw new NotFoundException('Compra não encontrada');
    if (LivePdvService.PAID_STATES.includes(cart.status)) {
      throw new BadRequestException('Essa compra já foi paga. 💜');
    }
    const cep = String(cart.customerCep || '').replace(/\D/g, '');
    if (cep.length !== 8) {
      throw new BadRequestException('Informe seu CEP pra calcular o frete antes de pagar.');
    }
  }
}
