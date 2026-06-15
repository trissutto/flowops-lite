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
import { CutoverService } from './cutover.service';

@Controller('admin/cutover')
@UseGuards(JwtAuthGuard)
export class CutoverController {
  constructor(private readonly svc: CutoverService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
  }

  /**
   * GET /admin/cutover/compare-day?date=YYYY-MM-DD
   * Compara vendas do dia entre Wincred e Flowops.
   */
  @Get('compare-day')
  compareDay(@Req() req: any, @Query('date') date?: string) {
    this.requireAdmin(req);
    const d = date || new Date().toISOString().slice(0, 10);
    return this.svc.compareDay(d);
  }

  @Get('summary')
  summary(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.dailySummary();
  }

  @Get('history')
  history(@Req() req: any, @Query('days') days?: string) {
    this.requireAdmin(req);
    return this.svc.lastDaysHistory(days ? parseInt(days, 10) : 7);
  }
}
