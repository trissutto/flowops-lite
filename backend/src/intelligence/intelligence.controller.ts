import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { IntelligenceService } from './intelligence.service';

/**
 * /intelligence — admin-only. Endpoints pra dashboard de inteligência de
 * estoque (/retaguarda/inteligencia-estoque).
 *
 * Todos endpoints aceitam ?from=YYYY-MM-DD&to=YYYY-MM-DD&plusSize=true.
 * Se omitido, default = últimos 30 dias.
 */
@UseGuards(JwtAuthGuard)
@Controller('intelligence')
export class IntelligenceController {
  constructor(private readonly svc: IntelligenceService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
  }

  private parseBool(v?: string): boolean {
    return v === 'true' || v === '1';
  }

  @Get('overview')
  overview(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('plusSize') plusSize?: string,
    @Query('year') year?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getStoresOverview({
      from,
      to,
      plusSize: this.parseBool(plusSize),
      year: year || undefined,
    });
  }

  @Get('top-sellers')
  topSellers(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
    @Query('plusSize') plusSize?: string,
    @Query('orderBy') orderBy?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getTopSellers({
      from,
      to,
      storeCode: storeCode || null,
      plusSize: this.parseBool(plusSize),
      orderBy: orderBy === 'valor' ? 'valor' : 'pecas',
      limit: limit ? Number(limit) : 10,
    });
  }

  @Get('rupturas')
  rupturas(
    @Req() req: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('storeCode') storeCode?: string,
    @Query('plusSize') plusSize?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getRupturas({
      from,
      to,
      storeCode: storeCode || null,
      plusSize: this.parseBool(plusSize),
      limit: limit ? Number(limit) : 10,
    });
  }

  @Get('parados')
  parados(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('days') days?: string,
    @Query('minStock') minStock?: string,
    @Query('plusSize') plusSize?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getParados({
      storeCode: storeCode || null,
      daysSemVenda: days ? Number(days) : 30,
      minStock: minStock ? Number(minStock) : 5,
      plusSize: this.parseBool(plusSize),
      limit: limit ? Number(limit) : 10,
    });
  }

  @Get('heatmap')
  heatmap(
    @Req() req: any,
    @Query('plusSize') plusSize?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getHeatmap({
      plusSize: this.parseBool(plusSize),
      limit: limit ? Number(limit) : 20,
    });
  }

  @Get('store/:code')
  storeDetail(
    @Req() req: any,
    @Param('code') code: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('plusSize') plusSize?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getStoreDetail({
      storeCode: code,
      from,
      to,
      plusSize: this.parseBool(plusSize),
    });
  }
}
