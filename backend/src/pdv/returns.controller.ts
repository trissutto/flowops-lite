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
import { ReturnsService } from './returns.service';

@UseGuards(JwtAuthGuard)
@Controller('pdv/devolucao')
export class ReturnsController {
  constructor(private readonly svc: ReturnsService) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  private resolveStore(req: any, override?: { storeCode?: string; storeName?: string }) {
    const role = req?.user?.role;
    if (role === 'admin') {
      const storeCode = override?.storeCode || req?.user?.storeCode;
      const storeName = override?.storeName || req?.user?.storeName || storeCode || '';
      if (!storeCode) throw new BadRequestException('storeCode obrigatório');
      return { storeCode, storeName };
    }
    const storeCode = req?.user?.storeCode;
    const storeName = req?.user?.storeName || storeCode || '';
    if (!storeCode) throw new BadRequestException('Usuário sem loja vinculada');
    return { storeCode, storeName };
  }

  /**
   * GET /pdv/devolucao/lookup?q=<id ou nfce>
   */
  @Get('lookup')
  async lookup(@Req() req: any, @Query('q') q: string) {
    this.requireRole(req);
    return this.svc.lookupSale(q);
  }

  /**
   * GET /pdv/devolucao/lookup-by-sku?sku=XXX
   * Lista as vendas finalizadas que contêm esse SKU, ordenadas da mais
   * recente pra mais antiga. Permite vendedora bipar a peça que voltou
   * (em vez de pedir o cupom da venda original).
   */
  @Get('lookup-by-sku')
  async lookupBySku(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    return this.svc.lookupSalesBySku(sku);
  }

  /**
   * POST /pdv/devolucao
   * Body: {
   *   originalSaleId, modo: 'dinheiro'|'troca'|'credito',
   *   items: [{originalItemId, qty}], motivo?, creditoValidadeDias?
   * }
   */
  @Post()
  async create(
    @Req() req: any,
    @Body()
    body: {
      originalSaleId: string;
      modo: 'dinheiro' | 'troca' | 'credito';
      items: Array<{ originalItemId: string; qty: number }>;
      motivo?: string;
      creditoValidadeDias?: number;
      storeCode?: string;
      storeName?: string;
      attachToSaleId?: string | null;
    },
  ) {
    this.requireRole(req);
    const { storeCode, storeName } = this.resolveStore(req, body);
    return this.svc.createReturn({
      originalSaleId: body.originalSaleId,
      storeCode,
      storeName,
      modo: body.modo,
      items: body.items,
      motivo: body.motivo,
      creditoValidadeDias: body.creditoValidadeDias,
      attachToSaleId: body.attachToSaleId ?? null,
      userId: req?.user?.sub || req?.user?.id || null,
      userName: req?.user?.name || req?.user?.email || null,
    });
  }

  /**
   * GET /pdv/devolucao — lista devoluções da loja
   */
  @Get()
  async list(
    @Req() req: any,
    @Query('storeCode') storeCodeOverride?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cpf') cpf?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    const { storeCode } = this.resolveStore(req, { storeCode: storeCodeOverride });
    return this.svc.list({
      storeCode,
      customerCpf: cpf,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  /**
   * GET /pdv/devolucao/credito/:code — consulta vale-troca SEM usar
   */
  @Get('credito/:code')
  async checkCredit(@Req() req: any, @Param('code') code: string) {
    this.requireRole(req);
    return this.svc.checkCredit(code);
  }

  /**
   * POST /pdv/devolucao/credito/usar
   * Body: { creditoCode, saleId }
   */
  @Post('credito/usar')
  async useCredit(
    @Req() req: any,
    @Body() body: { creditoCode: string; saleId: string },
  ) {
    this.requireRole(req);
    return this.svc.useCredit({
      creditoCode: body.creditoCode,
      usedInSaleId: body.saleId,
    });
  }
}
