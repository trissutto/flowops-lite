import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CustomersAppService } from './customers-app.service';
import {
  AppLoginDto,
  AppMarkPwaInstalledDto,
  AppRegisterDto,
} from './dto/app-auth.dto';
import { CustomerJwtGuard } from './customer-jwt.guard';

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
  constructor(private readonly svc: CustomersAppService) {}

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
}
