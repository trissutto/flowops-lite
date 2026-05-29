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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FinanceiroService } from './financeiro.service';
import { FechamentoPdfService } from './pdf.service';

/**
 * /financeiro — gerencia obrigações intercompany REDE↔FILIAL.
 *
 * TODOS endpoints exigem role=admin. Não tem operador financeiro separado
 * por enquanto (pedido do CEO).
 */
@UseGuards(JwtAuthGuard)
@Controller('financeiro')
export class FinanceiroController {
  constructor(
    private readonly svc: FinanceiroService,
    private readonly pdf: FechamentoPdfService,
  ) {}

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

  /**
   * POST /financeiro/obligations/recalc?mes=YYYY-MM
   * Rebusca preco_venda no Giga e atualiza obrigacoes pendentes do mes.
   * Util quando o backend pulled preco da coluna errada e gerou valores baixos.
   */
  @Post('obligations/recalc')
  async recalcObligations(
    @Req() req: any,
    @Query('mes') mes: string,
  ) {
    this.requireAdmin(req);
    if (!mes) throw new BadRequestException('Query param mes obrigatório (YYYY-MM)');
    return this.svc.recalcObligationsPrices(mes);
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

  /**
   * GET /financeiro/closures/:mes/pdf?filial=LJ05
   *
   * Gera PDF do comprovante mensal de UMA filial específica.
   * Stream direto pra response (não salva no disco).
   */
  @Get('closures/:mes/pdf')
  async closurePdf(
    @Req() req: any,
    @Res() res: Response,
    @Param('mes') mes: string,
    @Query('filial') filial: string,
  ) {
    this.requireAdmin(req);
    if (!filial) {
      throw new BadRequestException('Query param filial obrigatório (ex: ?filial=LJ05)');
    }
    const { buffer, filename } = await this.pdf.generateForFilial(mes, filial);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.send(buffer);
  }
}
