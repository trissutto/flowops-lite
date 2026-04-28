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

@Controller('pagarme')
export class PagarmeController {
  constructor(private readonly svc: PagarmeService) {}

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

  @UseGuards(JwtAuthGuard)
  @Get('pix/status/:saleId')
  async getStatusBySale(@Req() req: any, @Param('saleId') saleId: string) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
    const p = await this.svc.getPaymentBySale(saleId);
    if (!p) return { found: false, status: 'none' };

    // Se ainda pendente, consulta a Pagar.me AO VIVO (não depende do webhook).
    // Assim o polling do frontend (3s) já força sync direto com a Pagar.me.
    let currentStatus = p.status;
    let paidAt = p.paidAt;
    if (p.status === 'pending') {
      try {
        const live = await this.svc.checkOrderStatus(p.pagarmeOrderId);
        currentStatus = live.status;
        if (live.isPaid) paidAt = new Date();
      } catch {
        // Falha de rede com Pagar.me — mantém status local
      }
    }

    return {
      found: true,
      status: currentStatus,
      isPaid: currentStatus === 'paid',
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
