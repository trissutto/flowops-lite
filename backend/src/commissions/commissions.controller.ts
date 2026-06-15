import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CommissionsService } from './commissions.service';

/**
 * Endpoints de Comissão — F4 da migração 30/06.
 *
 * Rotas admin:
 *   GET  /commissions/rules                    — lista regras
 *   POST /commissions/rules                    — cria regra
 *   PUT  /commissions/rules/:id                — atualiza regra
 *   POST /commissions/rules/:id/deactivate     — desativa regra (não deleta — preserva histórico)
 *   GET  /commissions/periods                  — lista períodos
 *   GET  /commissions/periods/:yearMonth       — detalhe + entries
 *   POST /commissions/periods/:yearMonth/calculate — força recálculo
 *   POST /commissions/periods/:yearMonth/close — fecha período (não recalcula mais)
 *   POST /commissions/periods/:yearMonth/pay   — marca como pago
 *   GET  /commissions/periods/:yearMonth/report — relatório agregado por loja
 *
 * Rotas vendedora:
 *   GET  /commissions/my                       — vendedora vê só dela
 *
 * Rotas mistas:
 *   GET  /commissions/by-seller/:sellerId      — admin vê de uma vendedora específica
 */
@Controller('commissions')
@UseGuards(JwtAuthGuard)
export class CommissionsController {
  constructor(private readonly svc: CommissionsService) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Apenas admin/operator');
    }
  }

  // ── Rules ──────────────────────────────────────────────────────────

  @Get('rules')
  listRules(
    @Req() req: any,
    @Query('scope') scope?: string,
    @Query('storeId') storeId?: string,
    @Query('sellerId') sellerId?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.listRules({
      scope,
      storeId,
      sellerId,
      activeOnly: activeOnly === '1' || activeOnly === 'true',
    });
  }

  @Post('rules')
  createRule(
    @Req() req: any,
    @Body()
    body: {
      scope: 'global' | 'store' | 'seller';
      storeId?: string;
      sellerId?: string;
      percentBase: number;
      meta?: number;
      bonusPercent?: number;
      validFrom: string;
      validTo?: string;
      active?: boolean;
      note?: string;
    },
  ) {
    this.requireAdmin(req);
    return this.svc.createRule({
      scope: body.scope,
      storeId: body.storeId,
      sellerId: body.sellerId,
      percentBase: Number(body.percentBase),
      meta: body.meta != null ? Number(body.meta) : null,
      bonusPercent: body.bonusPercent != null ? Number(body.bonusPercent) : null,
      validFrom: new Date(body.validFrom),
      validTo: body.validTo ? new Date(body.validTo) : null,
      active: body.active,
      note: body.note,
      createdBy: req?.user?.userId || req?.user?.sub,
    });
  }

  @Put('rules/:id')
  updateRule(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireAdmin(req);
    const data: any = { ...body };
    if (body.validFrom) data.validFrom = new Date(body.validFrom);
    if (body.validTo) data.validTo = new Date(body.validTo);
    return this.svc.updateRule(id, data);
  }

  @Post('rules/:id/deactivate')
  deactivateRule(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.svc.deactivateRule(id);
  }

  /**
   * POST /commissions/rules/seed-defaults
   * Cria as 5 regras padrão Lurd's (cargos VENDEDORA/LIDER_*/GERENTE_*).
   * Idempotente — pula cargos que já têm regra ativa.
   */
  @Post('rules/seed-defaults')
  seedDefaults(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.seedDefaultCargoRules(req?.user?.userId || req?.user?.sub);
  }

  // ── Periods ────────────────────────────────────────────────────────

  @Get('periods')
  listPeriods(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.listPeriods();
  }

  @Get('periods/:yearMonth')
  getPeriod(@Req() req: any, @Param('yearMonth') yearMonth: string) {
    this.requireAdmin(req);
    return this.svc.getPeriod(yearMonth);
  }

  @Post('periods/:yearMonth/calculate')
  calculate(@Req() req: any, @Param('yearMonth') yearMonth: string) {
    this.requireAdmin(req);
    return this.svc.calculateForPeriod(yearMonth);
  }

  @Post('periods/:yearMonth/close')
  closePeriod(@Req() req: any, @Param('yearMonth') yearMonth: string) {
    this.requireAdmin(req);
    return this.svc.closePeriod(yearMonth, req?.user?.userId || req?.user?.sub);
  }

  @Post('periods/:yearMonth/pay')
  payPeriod(@Req() req: any, @Param('yearMonth') yearMonth: string) {
    this.requireAdmin(req);
    return this.svc.markPeriodPaid(yearMonth, req?.user?.userId || req?.user?.sub);
  }

  @Get('periods/:yearMonth/report')
  reportPeriod(@Req() req: any, @Param('yearMonth') yearMonth: string) {
    this.requireAdmin(req);
    return this.svc.reportPeriod(yearMonth);
  }

  // ── Por vendedora ──────────────────────────────────────────────────

  /**
   * Vendedora vê SÓ a dela (com base no userId/sellerId do JWT).
   * Admin pode usar by-seller pra ver outras.
   */
  @Get('my')
  async getMine(@Req() req: any, @Query('history') history?: string) {
    const sellerId = req?.user?.sellerId;
    if (!sellerId) {
      throw new ForbiddenException('Usuário sem sellerId vinculado');
    }
    return this.svc.getSellerStatement(sellerId, {
      history: history ? parseInt(history, 10) : 6,
    });
  }

  @Get('by-seller/:sellerId')
  bySeller(
    @Req() req: any,
    @Param('sellerId') sellerId: string,
    @Query('history') history?: string,
  ) {
    this.requireAdmin(req);
    return this.svc.getSellerStatement(sellerId, {
      history: history ? parseInt(history, 10) : 6,
    });
  }
}
