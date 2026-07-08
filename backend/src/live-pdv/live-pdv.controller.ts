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

  // Troca a loja anfitriã da live ABERTA (ex.: abriu com a loja padrão errada)
  @Post('sessions/:id/store')
  changeSessionStore(@Param('id') id: string, @Body() body: { storeCode: string }) {
    return this.svc.changeSessionStore(id, body?.storeCode);
  }

  // ── Busca / grade ──
  @Get('search')
  search(@Query('term') term: string, @Query('sessionId') sessionId?: string) {
    return this.svc.searchGrade(term, sessionId);
  }

  // ── Legenda da Live (atalhos 01, 02... → referência completa) ──
  // A validação de cada linha usa a MESMA rotina da busca acima (o front
  // chama GET /search pra prévia; o POST revalida no servidor antes de salvar).

  @Get('sessions/:id/atalhos')
  listAtalhos(@Param('id') sessionId: string) {
    return this.svc.listAtalhos(sessionId);
  }

  @Post('sessions/:id/atalhos')
  saveAtalho(
    @Param('id') sessionId: string,
    @Body() body: { id?: string | null; atalho: string; refCode: string },
  ) {
    return this.svc.saveAtalho(sessionId, {
      id: body?.id || null,
      atalho: body?.atalho || '',
      refCode: body?.refCode || '',
    });
  }

  @Post('sessions/:id/atalhos/:atalhoId/delete')
  deleteAtalho(@Param('id') sessionId: string, @Param('atalhoId') atalhoId: string) {
    return this.svc.deleteAtalho(sessionId, atalhoId);
  }

  // ── Preço promocional da live ──
  @Get('sessions/:id/promos')
  listPromos(@Param('id') sessionId: string) {
    return this.svc.listPromos(sessionId);
  }

  @Post('sessions/:id/promo')
  setPromo(
    @Req() req: any,
    @Param('id') sessionId: string,
    @Body() body: { refCode: string; priceCents: number },
  ) {
    return this.svc.setPromoPrice(sessionId, body.refCode, body.priceCents, req?.user?.sub || null);
  }

  // ── Cliente ──
  @Post('customers/quick')
  quickCustomer(
    @Body() body: { name: string; phone: string; instagram?: string; cpf?: string; email?: string },
  ) {
    return this.svc.quickCustomer(body);
  }

  // Busca clientes que JÁ participaram de alguma live (por nome/telefone/@)
  @Get('customers/search-live')
  searchLiveCustomers(@Query('term') term: string) {
    return this.svc.searchLiveCustomers(term || '');
  }

  // Autocomplete por @ ao identificar a cliente (cadastradas na live vêm primeiro)
  @Get('customers/search-at')
  searchCustomersByAt(@Query('term') term: string) {
    return this.svc.searchCustomersByAt(term || '');
  }

  // Puxa uma cliente de live anterior pra sessão atual (cria/reusa o carrinho)
  @Post('sessions/:id/add-customer')
  addCustomerToSession(@Param('id') id: string, @Body() body: { customerId: string }) {
    return this.svc.addCustomerToSession(id, body?.customerId);
  }

  // Fila de cadastradas (ManyChat) aguardando: origem 'live', 24h, sem carrinho nesta sessão
  @Get('sessions/:id/pending-registrations')
  pendingRegistrations(@Param('id') id: string) {
    return this.svc.pendingLiveRegistrations(id);
  }

  // Cobrança em massa AUTOMÁTICA via DM (API ManyChat) — carrinhos abertos da sessão
  @Post('sessions/:id/charge-all-dm')
  chargeAllViaDm(@Param('id') id: string) {
    return this.svc.chargeAllViaDm(id);
  }

  // Cobrança INDIVIDUAL automática via DM — funciona mesmo com o Insta fechado
  @Post('carts/:cartId/charge-dm')
  chargeCartViaDm(@Param('cartId') cartId: string) {
    return this.svc.chargeCartViaDm(cartId);
  }

  // Importa vínculos do CSV de Contatos do ManyChat (user_id + @) em lote
  @Post('manychat/import-links')
  importManychatLinks(@Body() body: { links: Array<{ sid: string; ig: string }> }) {
    return this.svc.importManychatLinks(body?.links || []);
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

  @Post('carts/:cartId/customer')
  updateCartCustomer(
    @Param('cartId') cartId: string,
    @Body()
    body: {
      name: string;
      phone?: string;
      instagram?: string;
      cpf?: string;
      email?: string;
      cep?: string;
      endereco?: string;
      numero?: string;
      complemento?: string;
      bairro?: string;
      cidade?: string;
      uf?: string;
    },
  ) {
    return this.svc.updateCartCustomer(cartId, body);
  }

  @Post('carts/:cartId/cancel')
  cancelCart(@Param('cartId') cartId: string, @Body() body: { reason?: string }) {
    return this.svc.cancelCart(cartId, body?.reason);
  }

  // Libera a separação de um carrinho PAGO pras lojas de origem (exige endereço completo)
  @Post('carts/:cartId/release-separation')
  releaseSeparation(@Param('cartId') cartId: string) {
    return this.svc.releaseSeparation(cartId);
  }

  // Bip de conferência da separação (loja bipa o EAN/código; confere e baixa estoque)
  @Post('carts/:cartId/bip')
  bipConference(@Param('cartId') cartId: string, @Body() body: { code: string }) {
    return this.svc.bipConference(cartId, body?.code || '');
  }

  // Recupera carrinhos que expiraram (re-reserva os itens) por N horas (default 24h)
  @Post('sessions/:id/recover-expired')
  recoverExpired(@Param('id') id: string, @Body() body: { ttlHours?: number }) {
    return this.svc.recoverExpiredReservations(id, body?.ttlHours || 24);
  }

  @Post('carts/:cartId/frete')
  setFrete(@Param('cartId') cartId: string, @Body() body: { freteCents: number }) {
    return this.svc.setFrete(cartId, body.freteCents);
  }

  // Calcula o frete automaticamente pelo CEP da cliente (SP=SEDEX 9,99, resto=PAC 19,99).
  // Aceita cep no corpo (digitado na hora) se o carrinho ainda não tiver.
  @Post('carts/:cartId/frete/auto')
  autoFrete(@Param('cartId') cartId: string, @Body() body: { cep?: string }) {
    return this.svc.computeFreteFromCep(cartId, body?.cep);
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

  @Post('carts/:cartId/pay-link')
  startPaymentLink(@Param('cartId') cartId: string) {
    return this.svc.startPaymentLink(cartId);
  }

  // Confirmação manual pra lojas com PIX externo (franquias sem gateway):
  // a cliente pagou por fora e a operadora marca pago → dispara a separação.
  @Post('carts/:cartId/pay-external')
  payExternal(@Param('cartId') cartId: string) {
    return this.svc.confirmExternalPayment(cartId);
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
