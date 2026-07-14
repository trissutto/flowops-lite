import { Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { ProductNativeService } from './product-native.service';

/**
 * Admin do PRODUTO NATIVO: primeira carga, re-sync e status da migração.
 * GET  /product-native/status          — contagens + flags ativas
 * POST /product-native/sync/full       — carga cheia espelho→nativo (segundos)
 * POST /product-native/sync/incremental — só linhas recentes (DATAALT 3 dias)
 */
@Controller('product-native')
@UseGuards(JwtAuthGuard)
export class ProductNativeController {
  constructor(private readonly svc: ProductNativeService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  @Get('status')
  status(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.status();
  }

  @Post('sync/full')
  syncFull(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.syncFull();
  }

  @Post('sync/incremental')
  syncIncremental(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.syncIncremental();
  }
}
