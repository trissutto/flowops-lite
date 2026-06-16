import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  forwardRef,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PagbankService } from './pagbank.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';
import type { Request } from 'express';

@Controller('pagbank')
export class PagbankController {
  constructor(
    private readonly svc: PagbankService,
    @Inject(forwardRef(() => CrediarioBaixaService))
    private readonly crediarioBaixa: CrediarioBaixaService,
  ) {}

  // ── Config (admin only) ────────────────────────────────────────────

  /**
   * GET /pagbank/config — status (sem expor token).
   * Com ?reveal=1, retorna token+secret em texto puro (admin only).
   * Util pra admin copiar/colar tokens em outros sistemas.
   */
  @UseGuards(JwtAuthGuard)
  @Get('config')
  async getConfig(@Req() req: any, @Query('reveal') reveal?: string) {
    const role = req?.user?.role;
    if (role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getConfig(reveal === '1' || reveal === 'true');
  }

  /** POST /pagbank/test — testa conexão com o token salvo */
  @UseGuards(JwtAuthGuard)
  @Post('test')
  async testConnection(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.testConnection();
  }

  /** POST /pagbank/diagnose — testa o token em vários endpoints PagBank */
  @UseGuards(JwtAuthGuard)
  @Post('diagnose')
  async diagnose(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.deepDiagnose();
  }

  /**
   * POST /pagbank/pix/test-sandbox
   *
   * Cria um PIX REAL em sandbox (R$ 1,00) e retorna request + response
   * completos pra enviar à Nathalia (Chamado 1360753759) como evidência
   * de homologação. Só funciona se ambiente=sandbox.
   */
  @UseGuards(JwtAuthGuard)
  @Post('pix/test-sandbox')
  async testPixSandbox(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.createTestPixSandbox();
  }

  /**
   * GET /pagbank/store-configs — lista config por loja (sem expor tokens)
   * Retorna array com 1 entry por loja que tem config cadastrada.
   */
  @UseGuards(JwtAuthGuard)
  @Get('store-configs')
  async listStoreConfigs(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.listStoreConfigs();
  }

  /**
   * GET /pagbank/store-config/:storeCode — config especifica de uma loja.
   * Com ?reveal=1, retorna token+secret em texto puro (admin only).
   */
  @UseGuards(JwtAuthGuard)
  @Get('store-config/:storeCode')
  async getStoreConfig(
    @Req() req: any,
    @Param('storeCode') storeCode: string,
    @Query('reveal') reveal?: string,
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getStoreConfig(storeCode, reveal === '1' || reveal === 'true');
  }

  /** POST /pagbank/store-config/:storeCode — admin salva config de uma loja especifica */
  @UseGuards(JwtAuthGuard)
  @Post('store-config/:storeCode')
  async setStoreConfig(
    @Req() req: any,
    @Param('storeCode') storeCode: string,
    @Body()
    body: {
      ambiente?: 'sandbox' | 'production';
      email?: string;
      bearerToken?: string;
      webhookSecret?: string;
      enabled?: boolean;
      contaLabel?: string;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setStoreConfig(storeCode, body);
  }

  /** DELETE /pagbank/store-config/:storeCode — remove config da loja (volta a usar singleton) */
  @UseGuards(JwtAuthGuard)
  @Post('store-config/:storeCode/remove')
  async removeStoreConfig(@Req() req: any, @Param('storeCode') storeCode: string) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.removeStoreConfig(storeCode);
  }

  /** POST /pagbank/config — admin salva token + ambiente */
  @UseGuards(JwtAuthGuard)
  @Post('config')
  async setConfig(
    @Req() req: any,
    @Body()
    body: {
      ambiente?: 'sandbox' | 'production';
      bearerToken?: string;
      webhookSecret?: string;
      enabled?: boolean;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setConfig(body);
  }

  // ── PIX (loja/admin) ───────────────────────────────────────────────

  /** POST /pagbank/pix/create — gera order PIX pra uma venda do PDV */
  @UseGuards(JwtAuthGuard)
  @Post('pix/create')
  async createPix(
    @Req() req: any,
    @Body()
    body: {
      saleId: string;
      valor: number;
      storeCode: string;
      customerName?: string;
      customerCpf?: string;
      customerEmail?: string;
      expiresInMinutes?: number;
    },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') {
      throw new ForbiddenException('Apenas admin ou loja');
    }
    if (!body?.saleId) throw new BadRequestException('saleId obrigatório');
    if (!body?.valor) throw new BadRequestException('valor obrigatório');
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.createPixCharge(body);
  }

  /** GET /pagbank/pix/status/:saleId — frontend faz polling rápido */
  @UseGuards(JwtAuthGuard)
  @Get('pix/status/:saleId')
  async getStatusBySale(@Req() req: any, @Param('saleId') saleId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    const p = await this.svc.getPaymentBySale(saleId);
    if (!p) return { found: false, status: 'none' };
    return {
      found: true,
      status: p.status,
      pagbankOrderId: p.pagbankOrderId,
      paidAt: p.paidAt,
      expiresAt: p.expiresAt,
      valor: p.valor,
    };
  }

  /** POST /pagbank/pix/check/:orderId — força consulta na PagBank (fallback) */
  @UseGuards(JwtAuthGuard)
  @Post('pix/check/:orderId')
  async checkOrder(@Req() req: any, @Param('orderId') orderId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    return this.svc.checkOrderStatus(orderId);
  }

  // ── Webhook (público, sem JWT — autenticado por HMAC) ──────────────

  /**
   * POST /pagbank/webhook — endpoint que PagBank chama quando status muda.
   *
   * IMPORTANTE: rota PÚBLICA (sem JwtAuthGuard) — autenticação é via
   * header `x-authenticity-token` (HMAC SHA256 com webhookSecret).
   */
  @Post('webhook')
  async webhook(
    @Body() body: any,
    @Req() req: Request,
    @Headers('x-authenticity-token') signature?: string,
  ) {
    const rawBody = JSON.stringify(body);
    const result = await this.svc.handleWebhook(body, rawBody, signature);

    // FIX PIX-LINK CREDIÁRIO (16/06/2026):
    // Quando webhook PagBank reporta paid PELA PRIMEIRA VEZ (statusChanged=true),
    // dispara baixa Giga automaticamente — mesmo padrão do Pagar.me.
    // Sem isso, parcela ficava em aberto + recibo não emitia.
    if (
      result.ok &&
      result.saleId &&
      result.status === 'paid' &&
      result.statusChanged
    ) {
      try {
        await this.crediarioBaixa.confirmBaixaPixIfExists(result.saleId);
      } catch (e: any) {
        // Não bloqueia ack do webhook — só loga. PagBank reenvia em falha.
      }
    }
    // PagBank espera 200 OK pra não retentar
    return { received: true, ...result };
  }

  // ── Lista (admin) ──────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('payments')
  async listPayments(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('saleId') saleId?: string,
    @Query('limit') limit?: string,
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.listPayments({
      status,
      saleId,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }
}
