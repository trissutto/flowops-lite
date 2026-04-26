import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FinanceiroService } from './financeiro.service';

/**
 * /financeiro — gerencia obrigações intercompany REDE↔FILIAL.
 *
 * TODOS endpoints exigem role=admin. Não tem operador financeiro separado
 * por enquanto (pedido do CEO).
 */
@UseGuards(JwtAuthGuard)
@Controller('financeiro')
export class FinanceiroController {
  constructor(private readonly svc: FinanceiroService) {}

  private requireAdmin(req: any) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
  }

  // ── Obrigações ────────────────────────────────────────────────────────

  @Get('obligations')
  listObligations(
    @Req() req: any,
    @Query('mes') mes: string,
    @Query('status') status?: string,
  ) {
    this.requireAdmin(req);
    if (!mes) throw new BadRequestException('Query param mes obrigatório (YYYY-MM)');
    return this.svc.listObligationsByMonth(mes, status);
  }

  @Patch('obligations/:id/paid')
  markPaid(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ) {
    this.requireAdmin(req);
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.svc.markObligationPaid(id, userId, body?.note);
  }

  @Post('obligations/paid-bulk')
  markPaidBulk(
    @Req() req: any,
    @Body() body: { ids: string[]; note?: string },
  ) {
    this.requireAdmin(req);
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.svc.markObligationsPaidBulk(body?.ids || [], userId, body?.note);
  }

  @Patch('obligations/:id/cancel')
  cancel(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    this.requireAdmin(req);
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.svc.cancelObligation(id, userId, body?.reason || '');
  }

  // ── Royalties + Marketing ─────────────────────────────────────────────

  @Get('royalties')
  royalties(@Req() req: any, @Query('mes') mes: string) {
    this.requireAdmin(req);
    if (!mes) throw new BadRequestException('Query param mes obrigatório (YYYY-MM)');
    return this.svc.getRoyaltiesByMonth(mes);
  }

  // ── Fechamento mensal ─────────────────────────────────────────────────

  @Get('closures')
  listClosures(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.listClosures();
  }

  @Get('closures/:mes')
  getClosure(@Req() req: any, @Param('mes') mes: string) {
    this.requireAdmin(req);
    return this.svc.getClosure(mes);
  }

  @Post('closures/:mes/close')
  closeMonth(
    @Req() req: any,
    @Param('mes') mes: string,
    @Body() body?: { force?: boolean },
  ) {
    this.requireAdmin(req);
    const userId = req?.user?.id || req?.user?.sub || null;
    return this.svc.closeMonth(mes, userId, !!body?.force);
  }
}
