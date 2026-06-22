import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PrismaService } from '../prisma/prisma.service';
import { LivePdvService } from './live-pdv.service';

/**
 * /api/live-pdv — Console de Live Commerce operado pela apresentadora +
 * painel da loja de origem + dashboard em tempo real.
 */
@UseGuards(JwtAuthGuard)
@Controller('live-pdv')
export class LivePdvController {
  constructor(
    private readonly svc: LivePdvService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Sessões ──
  @Post('sessions')
  createSession(
    @Req() req: any,
    @Body() body: { title?: string; liveStoreCode?: string; reservationTtlMin?: number },
  ) {
    return this.svc.createSession({ ...body, userId: req?.user?.sub || null });
  }

  @Get('sessions')
  listSessions() {
    return this.svc.listSessions();
  }

  @Get('sessions/:id')
  getSession(@Param('id') id: string) {
    return this.svc.getSession(id);
  }

  @Post('sessions/:id/end')
  endSession(@Param('id') id: string) {
    return this.svc.endSession(id);
  }

  // ── Busca / grade ──
  @Get('search')
  search(@Query('term') term: string) {
    return this.svc.searchGrade(term);
  }

  // ── Cliente ──
  @Post('customers/quick')
  quickCustomer(
    @Body() body: { name: string; phone: string; instagram?: string; cpf?: string; email?: string },
  ) {
    return this.svc.quickCustomer(body);
  }

  // ── Carrinho / itens ──
  @Post('sessions/:id/items')
  addItem(
    @Param('id') sessionId: string,
    @Body()
    body: {
      cartId?: string;
      customer?: {
        id?: string | null;
        name: string;
        phone: string;
        instagram?: string | null;
        cpf?: string | null;
        email?: string | null;
        cep?: string | null;
      };
      refCode: string;
      cor?: string | null;
      tamanho?: string | null;
      qty?: number;
    },
  ) {
    return this.svc.addItem({ sessionId, ...body });
  }

  @Get('sessions/:id/carts')
  listCarts(@Param('id') sessionId: string) {
    return this.svc.listCarts(sessionId);
  }

  @Get('carts/:cartId')
  getCart(@Param('cartId') cartId: string) {
    return this.svc.getCart(cartId);
  }

  @Post('carts/:cartId/frete')
  setFrete(@Param('cartId') cartId: string, @Body() body: { freteCents: number }) {
    return this.svc.setFrete(cartId, body.freteCents);
  }

  @Post('items/:itemId/cancel')
  cancelItem(@Param('itemId') itemId: string, @Body() body: { reason?: string }) {
    return this.svc.cancelItem(itemId, body?.reason);
  }

  @Post('items/:itemId/origin')
  changeOrigin(@Param('itemId') itemId: string, @Body() body: { storeCode: string }) {
    return this.svc.changeItemOrigin(itemId, body.storeCode);
  }

  // ── Pagamento ──
  @Post('carts/:cartId/pay')
  startPayment(@Param('cartId') cartId: string) {
    return this.svc.startPayment(cartId);
  }

  @Get('carts/:cartId/payment-status')
  checkPayment(@Param('cartId') cartId: string) {
    return this.svc.checkPayment(cartId);
  }

  // ── Painel da loja de origem ──
  @Get('store-queue')
  async storeQueue(@Req() req: any, @Query('storeCode') storeCode?: string) {
    const code = storeCode || (await this.resolveStoreCode(req));
    return this.svc.storeQueue(code);
  }

  @Post('items/:itemId/separated')
  markSeparated(@Param('itemId') itemId: string) {
    return this.svc.markSeparated(itemId);
  }

  @Post('items/:itemId/shipped')
  markShipped(
    @Req() req: any,
    @Param('itemId') itemId: string,
    @Body() body: { trackingCode?: string },
  ) {
    return this.svc.markShipped({ itemId, trackingCode: body?.trackingCode, userId: req?.user?.sub || null });
  }

  @Post('items/:itemId/delivered')
  markDelivered(@Param('itemId') itemId: string) {
    return this.svc.markDelivered(itemId);
  }

  // ── Dashboard ──
  @Get('sessions/:id/dashboard')
  dashboard(@Param('id') sessionId: string) {
    return this.svc.dashboard(sessionId);
  }

  /** Resolve o storeCode do usuário logado (role=store carrega storeId no JWT). */
  private async resolveStoreCode(req: any): Promise<string> {
    const storeId = req?.user?.storeId;
    if (!storeId) return '';
    const store = await (this.prisma as any).store.findUnique({ where: { id: storeId } });
    return store?.code || '';
  }
}
