/**
 * /crediarios/baixa — endpoints da tela RECEBIMENTOS no PDV.
 *
 * Acesso: vendedora (role=store) opera a própria loja (storeCode do JWT).
 * Admin pode passar storeCode explícito via query.
 */

import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { CrediarioBaixaService } from './crediario-baixa.service';

@UseGuards(JwtAuthGuard)
@Controller('crediarios/baixa')
export class CrediarioBaixaController {
  constructor(private readonly svc: CrediarioBaixaService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  private resolveStore(req: any, override?: string): { code: string; name: string } {
    const role = req?.user?.role;
    if (role === 'admin') {
      const code = override || req?.user?.storeCode || '';
      const name = req?.user?.storeName || code;
      if (!code) throw new BadRequestException('storeCode obrigatório pra admin');
      return { code, name };
    }
    const code = req?.user?.storeCode;
    const name = req?.user?.storeName || code || '';
    if (!code) throw new BadRequestException('Usuário sem loja vinculada');
    return { code, name };
  }

  // ── Config (admin) ────────────────────────────────────────────────

  @Get('config')
  async getConfig(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getConfig();
  }

  @Post('config')
  async setConfig(
    @Req() req: any,
    @Body() body: { diasCarencia?: number; taxaMensalPercent?: number; enabled?: boolean },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setConfig(body);
  }

  // ── Busca cliente + parcelas em aberto ────────────────────────────

  @Get('cliente')
  async listOpenInstallments(
    @Req() req: any,
    @Query('busca') busca: string,
    @Query('storeCode') storeCodeOverride?: string,
    @Query('todasLojas') todasLojas?: string,
  ) {
    this.requireRole(req);
    const role = req?.user?.role;
    let storeCode: string | undefined;
    if (todasLojas !== '1') {
      // Vendedora SEMPRE filtra pela própria loja. Admin pode escolher.
      if (role === 'admin') {
        storeCode = storeCodeOverride || undefined;
      } else {
        storeCode = req?.user?.storeCode;
      }
    }
    return this.svc.listOpenInstallmentsByCustomer({ busca, storeCode });
  }

  // ── Preview ──────────────────────────────────────────────────────

  @Post('preview')
  async preview(
    @Req() req: any,
    @Body() body: { parcelas: Array<{ registro: string; controle: string }> },
  ) {
    this.requireRole(req);
    return this.svc.previewBaixa({ parcelas: body?.parcelas || [] });
  }

  // ── Aplicar baixa (DINHEIRO) ─────────────────────────────────────

  @Post('dinheiro')
  async aplicarDinheiro(
    @Req() req: any,
    @Body()
    body: {
      parcelas: Array<{ registro: string; controle: string }>;
      storeCode?: string;
    },
  ) {
    this.requireRole(req);
    const { code, name } = this.resolveStore(req, body?.storeCode);
    return this.svc.applyBaixaDinheiro({
      parcelas: body?.parcelas || [],
      lojaCode: code,
      lojaName: name,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  // ── Aplicar baixa (PIX — gera Pagar.me) ──────────────────────────

  @Post('pix')
  async aplicarPix(
    @Req() req: any,
    @Body()
    body: {
      parcelas: Array<{ registro: string; controle: string }>;
      storeCode?: string;
      customerName?: string;
      customerCpf?: string;
      customerEmail?: string;
      customerPhone?: string;
    },
  ) {
    this.requireRole(req);
    const { code, name } = this.resolveStore(req, body?.storeCode);
    return this.svc.createPendingBaixaPix({
      parcelas: body?.parcelas || [],
      lojaCode: code,
      lojaName: name,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
      customerName: body?.customerName,
      customerCpf: body?.customerCpf,
      customerPhone: body?.customerPhone,
      customerEmail: body?.customerEmail,
    });
  }

  // ── Status (polling) ─────────────────────────────────────────────

  @Get('status/:id')
  async status(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getBaixaStatus(id);
  }

  // ── Detalhe (recibo) ─────────────────────────────────────────────

  @Get(':id')
  async detail(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getBaixaDetail(id);
  }
}
