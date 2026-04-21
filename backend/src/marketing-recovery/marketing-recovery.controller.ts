import {
  Body, Controller, Delete, ForbiddenException, Get, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { MarketingRecoveryService } from './marketing-recovery.service';

interface AuthUser {
  userId: string;
  email: string;
  role: string;
  storeId: string | null;
}

function assertMatriz(user: AuthUser) {
  if (user.role !== 'admin' && user.role !== 'operator') {
    throw new ForbiddenException('Apenas matriz (admin/operator) acessa marketing');
  }
}

@Controller('marketing/recovery')
@UseGuards(JwtAuthGuard)
export class MarketingRecoveryController {
  constructor(private readonly svc: MarketingRecoveryService) {}

  /** Lista candidatos a abordagem (carrinhos abandonados + estado de recuperação). */
  @Get('candidates')
  candidates(
    @Req() req: any,
    @Query('step') step?: 'all' | 'T1' | 'T2' | 'T3' | 'pending' | 'sent',
    @Query('limit') limit?: string,
  ) {
    assertMatriz(req.user);
    return this.svc.listCandidates({
      stepFilter: step,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** Templates + tempos da campanha (FASE 1: hardcoded, pode evoluir pra config editável). */
  @Get('config')
  config(@Req() req: any) {
    assertMatriz(req.user);
    return { steps: this.svc.getStepsConfig() };
  }

  /** Renderiza preview da mensagem pra um carrinho específico num estágio. */
  @Post('preview')
  preview(
    @Req() req: any,
    @Body()
    body: {
      stepIndex: number;
      name?: string | null;
      product?: string | null;
      amount?: number | null;
      coupon?: string | null;
      link?: string | null;
    },
  ) {
    assertMatriz(req.user);
    return {
      stepIndex: body.stepIndex,
      body: this.svc.renderTemplate(body.stepIndex, body),
    };
  }

  /**
   * Modo MANUAL: operadora abriu WhatsApp Web, enviou a mensagem e confirma aqui.
   * Registra WaMessage status=sent, sendMode=manual.
   */
  @Post('register-sent')
  registerSent(
    @Req() req: any,
    @Body()
    body: {
      sourceType: string;
      sourceId: string;
      stepIndex: number;
      customerPhone: string;
      customerName?: string;
      customerEmail?: string;
      bodyRendered: string;
      amount?: number | null;
      couponCode?: string | null;
      couponPct?: number | null;
    },
  ) {
    const user = req.user as AuthUser;
    assertMatriz(user);
    return this.svc.registerManualSent({ ...body, sentByUserId: user.userId });
  }

  /** KPIs de recuperação (janela em dias, default 30). */
  @Get('stats')
  stats(@Req() req: any, @Query('window') window?: string) {
    assertMatriz(req.user);
    return this.svc.stats(window ? Number(window) : 30);
  }

  /** Histórico de mensagens enviadas (auditoria). */
  @Get('history')
  history(@Req() req: any, @Query('limit') limit?: string) {
    assertMatriz(req.user);
    return this.svc.history(limit ? Number(limit) : 100);
  }

  /** Rodar manualmente o scan de conversão (cruzamento com Orders novos). */
  @Post('scan-conversions')
  scanConversions(@Req() req: any) {
    assertMatriz(req.user);
    return this.svc.scanConversions();
  }

  // ── Opt-out ────────────────────────────────────────────────────────────────

  @Get('opt-outs')
  listOptOuts(@Req() req: any) {
    assertMatriz(req.user);
    return this.svc.listOptOuts();
  }

  @Post('opt-outs')
  addOptOut(@Req() req: any, @Body() body: { phone: string; reason?: string }) {
    assertMatriz(req.user);
    return this.svc.addOptOut(body.phone, body.reason);
  }

  @Delete('opt-outs/:phone')
  removeOptOut(@Req() req: any, @Param('phone') phone: string) {
    assertMatriz(req.user);
    return this.svc.removeOptOut(phone);
  }
}
