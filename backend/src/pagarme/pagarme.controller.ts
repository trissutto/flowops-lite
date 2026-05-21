import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { PagarmeService } from './pagarme.service';
import { CrediarioBaixaService } from '../crediarios/crediario-baixa.service';
import { Inject, forwardRef } from '@nestjs/common';

@Controller('pagarme')
export class PagarmeController {
  constructor(
    private readonly svc: PagarmeService,
    @Inject(forwardRef(() => CrediarioBaixaService))
    private readonly crediarioBaixa: CrediarioBaixaService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('config')
  async getConfig(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.getConfig();
  }

  @UseGuards(JwtAuthGuard)
  @Post('config')
  async setConfig(
    @Req() req: any,
    @Body()
    body: {
      ambiente?: 'test' | 'live';
      apiKey?: string;
      webhookSecret?: string;
      recipientId?: string;
      enabled?: boolean;
    },
  ) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.setConfig(body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('test')
  async test(@Req() req: any) {
    if (req?.user?.role !== 'admin') throw new ForbiddenException('Apenas admin');
    return this.svc.testConnection();
  }

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
      customerPhone?: string;
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

  /**
   * POST /pagarme/checkout/create
   * Cria Link de Pagamento Pagar.me (PIX + cartão parcelado SEM JUROS).
   * Vendedora compartilha URL via WhatsApp/Instagram. Quando cliente paga,
   * o MESMO webhook do PIX dispara order.paid e finaliza a venda.
   */
  @UseGuards(JwtAuthGuard)
  @Post('checkout/create')
  async createCheckout(
    @Req() req: any,
    @Body()
    body: {
      saleId: string;
      valor: number;
      storeCode: string;
      customerName?: string;
      customerCpf?: string;
      customerEmail?: string;
      customerPhone?: string;
      maxInstallments?: number;
      expiresInMinutes?: number;
      acceptPix?: boolean;
      acceptCreditCard?: boolean;
    },
  ) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') {
      throw new ForbiddenException('Apenas admin ou loja');
    }
    if (!body?.saleId) throw new BadRequestException('saleId obrigatório');
    if (!body?.valor) throw new BadRequestException('valor obrigatório');
    if (!body?.storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.createCheckoutLink(body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('pix/status/:saleId')
  async getStatusBySale(@Req() req: any, @Param('saleId') saleId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    const p = await this.svc.getPaymentBySale(saleId);
    if (!p) return { found: false, status: 'none' };

    // SEGURANÇA: SEMPRE consulta Pagar.me ao vivo se o pagamento foi criado
    // nos últimos 30min (independente do status local).
    //
    // ANTES: confiava no banco local — webhook marcava paid, e mesmo se
    // Pagar.me revertesse depois (failed/canceled), o frontend recebia paid
    // e finalizava a venda. AGORA: live é a fonte de verdade enquanto recente.
    let currentStatus = p.status;
    let paidAt = p.paidAt;
    const ageMs = Date.now() - new Date(p.createdAt).getTime();
    const isRecent = ageMs < 30 * 60 * 1000;
    if (isRecent && p.pagarmeOrderId) {
      try {
        const live = await this.svc.checkOrderStatus(p.pagarmeOrderId);
        currentStatus = live.status;
        if (live.isPaid) paidAt = new Date();
        // Se Pagar.me reverteu (failed/canceled) mas banco tinha paid: persiste a reversão
      } catch {
        // Falha de rede com Pagar.me — mantém status local (não force paid)
      }
    }

    return {
      found: true,
      status: currentStatus,
      isPaid: currentStatus === 'paid',
      isFailed: currentStatus === 'failed' || currentStatus === 'canceled',
      pagarmeOrderId: p.pagarmeOrderId,
      paidAt,
      expiresAt: p.expiresAt,
      valor: p.valor,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('pix/check/:orderId')
  async checkOrder(@Req() req: any, @Param('orderId') orderId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    return this.svc.checkOrderStatus(orderId);
  }

  // Webhook PÚBLICO — auth via HMAC
  @Post('webhook')
  async webhook(
    @Body() body: any,
    @Headers('x-hub-signature') signature?: string,
    @Headers('x-hub-signature-256') signature256?: string,
  ) {
    const rawBody = JSON.stringify(body);
    const sig = signature || signature256;
    const result = await this.svc.handleWebhook(body, rawBody, sig);
    // FIX PIX-LINK: se webhook reportou paid, dispara baixa Giga automaticamente.
    // Antes desse fix, baixas via PIX-LINK ficavam pending — webhook só marcava
    // PagarmePayment=paid mas nunca chamava confirmBaixaPix → Wincred não atualizava.
    if (result.ok && result.saleId) {
      const eventType = String(body?.type || '');
      if (eventType === 'order.paid' || eventType === 'charge.paid') {
        try {
          await this.crediarioBaixa.confirmBaixaPixIfExists(result.saleId);
        } catch (e: any) {
          // Não bloqueia ack do webhook — só loga
        }
      }
    }
    return { received: true, ...result };
  }

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
