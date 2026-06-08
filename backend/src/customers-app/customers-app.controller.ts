import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { CustomersAppService } from './customers-app.service';
import {
  AppLoginDto,
  AppMarkPwaInstalledDto,
  AppRegisterDto,
} from './dto/app-auth.dto';
import { CustomerJwtGuard } from './customer-jwt.guard';
import { CustomerLinkingService } from './customer-linking.service';
import { CustomerPushService } from './customer-push.service';
import { CustomerCashbackService } from './customer-cashback.service';
import { AppInviteService } from './app-invite.service';
import { CustomerPasswordResetService } from './customer-password-reset.service';
import { JwtAuthGuard } from '../auth/jwt.guard';

/**
 * Endpoints públicos pro app cliente final (PWA app.lurds.com.br).
 *
 * Prefixo /customers/app — distingue do /auth do operador e /customers
 * (CRM interno).
 *
 * Públicos (sem auth):
 *   - POST /customers/app/register
 *   - POST /customers/app/login
 *
 * Protegidos (JWT scope='customer'):
 *   - GET  /customers/app/me
 *   - POST /customers/app/pwa-installed
 *   - POST /customers/app/push-opt-in
 */
@Controller('customers/app')
export class CustomersAppController {
  constructor(
    private readonly svc: CustomersAppService,
    private readonly linking: CustomerLinkingService,
    private readonly push: CustomerPushService,
    private readonly cashback: CustomerCashbackService,
    private readonly invite: AppInviteService,
    private readonly pwReset: CustomerPasswordResetService,
  ) {}

  /**
   * GET /customers/app/lookup?cpf=12345678901
   * Público — checa se CPF existe na base (Giga ETL) e retorna dados
   * mascarados pra pré-preencher o cadastro.
   */
  @Get('lookup')
  async lookup(@Query('cpf') cpf?: string) {
    return this.svc.lookupByCpf((cpf || '').replace(/\D/g, ''));
  }

  @Post('register')
  @HttpCode(201)
  async register(@Body() dto: AppRegisterDto & { invite?: string }) {
    const result = await this.svc.register(dto);
    // Se veio com invite de QR PDV, resgata bônus extra
    if (dto.invite && result.customer.id) {
      const redeemed = await this.invite.redeemToken(dto.invite, result.customer.id);
      return { ...result, invite: redeemed };
    }
    return result;
  }

  /* ════════════════ INVITE TOKENS (QR PDV) ════════════════ */

  /** GET /customers/app/invite/lookup?token=XXX — público, pra UI mostrar bônus */
  @Get('invite/lookup')
  async inviteLookup(@Query('token') token?: string) {
    return this.invite.lookupToken(token || '');
  }

  /** POST /customers/app/admin/invite/create — PDV chama pra gerar QR */
  @Post('admin/invite/create')
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  async inviteCreate(
    @Req() req: any,
    @Body() body: {
      sellerName?: string;
      pdvSaleId?: string;
      customerCpf?: string;
      bonusCents?: number;
    },
  ) {
    if (req?.user?.role !== 'admin' && req?.user?.role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
    return this.invite.createInvite({
      storeCode: req.user.storeCode || 'XX',
      sellerName: body.sellerName,
      pdvSaleId: body.pdvSaleId,
      customerCpf: body.customerCpf,
      bonusCents: body.bonusCents,
    });
  }

  /** GET /customers/app/admin/invite/stats — relatório conversão por vendedora */
  @Get('admin/invite/stats')
  @UseGuards(JwtAuthGuard)
  async inviteStats(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
  ) {
    if (req?.user?.role !== 'admin' && req?.user?.role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
    return this.invite.getStats({
      fromDate: from ? new Date(from) : undefined,
      toDate: to ? new Date(to) : undefined,
      storeCode,
    });
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: AppLoginDto) {
    return this.svc.login(dto);
  }

  /* ════════════════ RESET DE SENHA (WhatsApp) ════════════════ */

  /** POST /customers/app/forgot-password — recebe CPF, envia código no WhatsApp */
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() body: { cpf: string }) {
    const cpf = (body.cpf || '').replace(/\D/g, '');
    return this.pwReset.requestReset(cpf);
  }

  /** POST /customers/app/reset-password — valida código e atualiza senha */
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(@Body() body: { cpf: string; code: string; password: string }) {
    const cpf = (body.cpf || '').replace(/\D/g, '');
    return this.pwReset.confirmReset(cpf, body.code, body.password);
  }

  @Get('me')
  @UseGuards(CustomerJwtGuard)
  async me(@Req() req: any) {
    return this.svc.me(req.customer.id);
  }

  @Get('addresses')
  @UseGuards(CustomerJwtGuard)
  async addresses(@Req() req: any) {
    return this.svc.getAddresses(req.customer.id);
  }

  @Get('orders')
  @UseGuards(CustomerJwtGuard)
  async orders(@Req() req: any) {
    return this.svc.getOrders(req.customer.id);
  }

  @Post('pwa-installed')
  @HttpCode(200)
  @UseGuards(CustomerJwtGuard)
  async pwaInstalled(
    @Req() req: any,
    @Body() _dto: AppMarkPwaInstalledDto,
  ) {
    return this.svc.markPwaInstalled(req.customer.id);
  }

  @Post('push-opt-in')
  @HttpCode(200)
  @UseGuards(CustomerJwtGuard)
  async pushOptIn(
    @Req() req: any,
    @Body() body: { optIn: boolean },
  ) {
    return this.svc.setPushOptIn(req.customer.id, !!body.optIn);
  }

  /** POST /customers/app/whatsapp-opt-in — receber promos no WhatsApp */
  @Post('whatsapp-opt-in')
  @HttpCode(200)
  @UseGuards(CustomerJwtGuard)
  async whatsappOptIn(
    @Req() req: any,
    @Body() body: { optIn: boolean },
  ) {
    return this.svc.setWhatsappOptIn(req.customer.id, !!body.optIn);
  }

  /* ════════════════ CASHBACK ════════════════ */

  /** GET /customers/app/cashback — saldo + extrato + próxima expiração */
  @Get('cashback')
  @UseGuards(CustomerJwtGuard)
  async cashbackStatement(@Req() req: any) {
    return this.cashback.getStatement(req.customer.id);
  }

  /** POST /customers/app/admin/cashback/expire-now — força run do job (admin) */
  @Post('admin/cashback/expire-now')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async cashbackExpireNow(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.cashback.expireOldCashback();
  }

  /** POST /customers/app/admin/cashback/warn-now — força run alerta D-7 */
  @Post('admin/cashback/warn-now')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async cashbackWarnNow(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.cashback.warnExpiringSoon();
  }

  /* ════════════════ PUSH NOTIFICATIONS (cliente) ════════════════ */

  /** GET /customers/app/push/public-key — VAPID key pra frontend subscrever */
  @Get('push/public-key')
  pushPublicKey() {
    return { key: this.push.getPublicKey() };
  }

  /** POST /customers/app/push/subscribe — cliente registra device */
  @Post('push/subscribe')
  @HttpCode(200)
  @UseGuards(CustomerJwtGuard)
  async pushSubscribe(
    @Req() req: any,
    @Body() body: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      userAgent?: string;
    },
  ) {
    await this.push.saveSubscription(req.customer.id, body, body.userAgent);
    // Marca opt-in no account
    await this.svc.setPushOptIn(req.customer.id, true);
    return { ok: true };
  }

  /** POST /customers/app/push/unsubscribe — cliente desativa um device */
  @Post('push/unsubscribe')
  @HttpCode(200)
  @UseGuards(CustomerJwtGuard)
  async pushUnsubscribe(@Req() req: any, @Body() body: { endpoint: string }) {
    await this.push.unsubscribe(req.customer.id, body.endpoint);
    return { ok: true };
  }

  /* ════════════════ HISTÓRICO DE NOTIFICAÇÕES ════════════════ */

  /** GET /customers/app/notifications — últimas 50 + contagem não lidas */
  @Get('notifications')
  @UseGuards(CustomerJwtGuard)
  async notifications(@Req() req: any) {
    return this.svc.getNotifications(req.customer.id);
  }

  /** GET /customers/app/notifications/unread-count — só o número, pra header da home */
  @Get('notifications/unread-count')
  @UseGuards(CustomerJwtGuard)
  async notificationsUnreadCount(@Req() req: any) {
    return this.svc.getUnreadNotificationsCount(req.customer.id);
  }

  /** POST /customers/app/notifications/read-all — marca tudo como lido */
  @Post('notifications/read-all')
  @HttpCode(200)
  @UseGuards(CustomerJwtGuard)
  async notificationsReadAll(@Req() req: any) {
    return this.svc.markAllNotificationsRead(req.customer.id);
  }

  /**
   * POST /customers/app/admin/backfill-welcome — credita R$20 retroativo
   * pra todas accounts que nunca receberam. Só admin.
   */
  @Post('admin/backfill-welcome')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async adminBackfillWelcome(@Req() req: any) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    return this.svc.backfillWelcomeBonus();
  }

  /**
   * POST /customers/app/admin/push-send — operador dispara push manual.
   * Body: { mode: 'all' | 'segment' | 'account', payload, segment?, accountId? }
   */
  @Post('admin/push-send')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async pushSend(
    @Req() req: any,
    @Body()
    body: {
      mode: 'all' | 'segment' | 'account';
      payload: { title: string; body?: string; url?: string; image?: string; tag?: string };
      segment?: { vipTiers?: string[]; minLtvCents?: number; hasCashback?: boolean; cpfs?: string[] };
      accountId?: string;
    },
  ) {
    if (req?.user?.role !== 'admin' && req?.user?.role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
    if (body.mode === 'all') return this.push.sendToAll(body.payload);
    if (body.mode === 'segment') return this.push.sendSegmented(body.segment || {}, body.payload);
    if (body.mode === 'account' && body.accountId) {
      return this.push.sendToAccount(body.accountId, body.payload);
    }
    return { error: 'modo inválido' };
  }

  /** GET /customers/app/admin/stats — dashboard admin */
  @Get('admin/stats')
  @UseGuards(JwtAuthGuard)
  async adminStats(@Req() req: any) {
    if (req?.user?.role !== 'admin' && req?.user?.role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
    return this.svc.getAdminStats();
  }

  /** GET /customers/app/admin/search?q=XXX — autocomplete clientes */
  @Get('admin/search')
  @UseGuards(JwtAuthGuard)
  async adminSearch(@Req() req: any, @Query('q') q?: string) {
    if (req?.user?.role !== 'admin' && req?.user?.role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
    return { accounts: await this.svc.searchAccounts(q || '') };
  }

  /**
   * POST /customers/app/admin/reconcile-links
   *
   * Endpoint admin pra forçar reconciliação. Útil depois de importar muitos
   * Customers do Giga ETL. Varre todos CustomerAccount e vincula a Customers
   * com mesmo CPF que ainda não estão linkados.
   *
   * Auth: operador/admin (JWT_USER, não cliente).
   */
  @Post('admin/reconcile-links')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async reconcileLinks(@Req() req: any) {
    if (req?.user?.role !== 'admin' && req?.user?.role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
    return this.linking.reconcileAll();
  }
}
