import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WcReturnsService } from './wc-returns.service';

@UseGuards(JwtAuthGuard)
@Controller('wc-returns')
export class WcReturnsController {
  constructor(private readonly svc: WcReturnsService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store') {
      throw new ForbiddenException('Apenas admin ou loja');
    }
  }

  /** GET /wc-returns/prazo — config atual (pra UI) */
  @Get('prazo')
  async getPrazo(@Req() req: any) {
    this.requireRole(req);
    const dias = await this.svc.getPrazoDias();
    return { dias };
  }

  /** POST /wc-returns/prazo — admin define prazo (dias) */
  @Post('prazo')
  async setPrazo(@Req() req: any, @Body() body: { dias: number }) {
    if (req?.user?.role !== 'admin') {
      throw new ForbiddenException('Apenas admin');
    }
    const dias = await this.svc.setPrazoDias(Number(body?.dias));
    return { dias };
  }

  /**
   * GET /wc-returns/search?q=Maria — busca pedidos WC por nome/numero
   */
  @Get('search')
  async search(@Req() req: any, @Query('q') q: string, @Query('limit') limit?: string) {
    this.requireRole(req);
    return this.svc.search({ q, limit: limit ? parseInt(limit, 10) : 20 });
  }

  /**
   * GET /wc-returns/order/:wcId — detalhe completo pra tela de troca
   */
  @Get('order/:wcId')
  async getOrder(@Req() req: any, @Param('wcId') wcId: string) {
    this.requireRole(req);
    return this.svc.getOrderForReturn(parseInt(wcId, 10));
  }

  /**
   * POST /wc-returns/accept
   * Body: {
   *   wcOrderId,
   *   receivingStoreCode,    // loja FÍSICA que recebeu de volta
   *   modo: 'devolucao' | 'troca' | 'credito',
   *   items: [{sku, qty}],
   *   motivo?, obs?,
   *   forceOutOfPrazo?, creditoValidadeDias?
   * }
   */
  @Post('accept')
  async accept(
    @Req() req: any,
    @Body()
    body: {
      wcOrderId: number;
      receivingStoreCode: string;
      modo: 'devolucao' | 'troca' | 'credito';
      items: Array<{ sku: string; qty: number; productName?: string }>;
      motivo?: string;
      obs?: string;
      forceOutOfPrazo?: boolean;
      creditoValidadeDias?: number;
    },
  ) {
    this.requireRole(req);
    if (!body?.wcOrderId) throw new BadRequestException('wcOrderId obrigatório');
    if (!body?.receivingStoreCode)
      throw new BadRequestException('receivingStoreCode obrigatório');
    return this.svc.accept({
      wcOrderId: body.wcOrderId,
      receivingStoreCode: body.receivingStoreCode,
      modo: body.modo,
      items: body.items,
      motivo: body.motivo,
      obs: body.obs,
      forceOutOfPrazo: body.forceOutOfPrazo,
      creditoValidadeDias: body.creditoValidadeDias,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /** GET /wc-returns — lista trocas registradas (admin / loja) */
  @Get()
  async list(
    @Req() req: any,
    @Query('storeCode') storeCode?: string,
    @Query('cpf') cpf?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    // Loja só vê as trocas que recebeu
    let effectiveStoreCode = storeCode;
    if (req?.user?.role === 'store') {
      effectiveStoreCode = req?.user?.storeCode;
    }
    return this.svc.list({
      storeCode: effectiveStoreCode,
      customerCpf: cpf,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }
}
