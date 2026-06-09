import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import {
  ProgressiveDiscountService,
  ProgressiveDiscountConfig,
  CartItem,
} from './progressive-discount.service';

/* ─────── ADMIN (/retaguarda) ─────── */

@Controller('admin/progressive-discount')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
export class ProgressiveDiscountAdminController {
  constructor(private readonly svc: ProgressiveDiscountService) {}

  @Get()
  async getConfig() {
    return this.svc.getConfig();
  }

  @Post()
  async setConfig(@Body() body: Partial<ProgressiveDiscountConfig>) {
    return this.svc.setConfig(body || {});
  }
}

/* ─────── PÚBLICO (app cliente) ─────── */

@Controller('app/progressive-discount')
export class ProgressiveDiscountPublicController {
  constructor(private readonly svc: ProgressiveDiscountService) {}

  /** GET /app/progressive-discount — config visível pro cliente */
  @Get()
  async getPublicConfig() {
    return this.svc.getPublicConfig();
  }

  /** POST /app/progressive-discount/calculate — calcula desconto pro carrinho */
  @Post('calculate')
  async calculate(@Body() body: { items: CartItem[] }) {
    return this.svc.calculate(body?.items || []);
  }
}
