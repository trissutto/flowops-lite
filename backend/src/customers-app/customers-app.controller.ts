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
  async register(@Body() dto: AppRegisterDto) {
    return this.svc.register(dto);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: AppLoginDto) {
    return this.svc.login(dto);
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
