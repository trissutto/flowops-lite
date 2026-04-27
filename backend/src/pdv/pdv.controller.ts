import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { PdvService } from './pdv.service';
import { ErpService } from '../erp/erp.service';

/**
 * /pdv — frente de caixa.
 * Acessível por role 'store' (vendedora) e 'admin'.
 */
@UseGuards(JwtAuthGuard)
@Controller('pdv')
export class PdvController {
  constructor(
    private readonly svc: PdvService,
    private readonly erp: ErpService,
  ) {}

  private requireRole(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'store')
      throw new ForbiddenException('Apenas admin ou loja');
  }

  /**
   * GET /pdv/product?sku=5358427
   * Busca produto Giga pra pré-visualização (sem adicionar ao carrinho).
   * Útil pra consulta de preço.
   */
  @Get('product')
  product(@Req() req: any, @Query('sku') sku: string) {
    this.requireRole(req);
    if (!sku) throw new BadRequestException('sku obrigatório');
    return this.erp.getPdvProductInfo(sku);
  }

  /**
   * POST /pdv/sales { storeCode }
   * Abre nova venda OPEN.
   */
  @Post('sales')
  createSale(@Req() req: any, @Body() body: { storeCode: string }) {
    this.requireRole(req);
    return this.svc.createSale({
      storeCode: body?.storeCode,
      vendedorUserId: req?.user?.id || req?.user?.sub,
      vendedorName: req?.user?.name || null,
    });
  }

  /**
   * GET /pdv/sales?storeCode=01&status=open&limit=20
   */
  @Get('sales')
  listSales(
    @Req() req: any,
    @Query('storeCode') storeCode: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    this.requireRole(req);
    if (!storeCode) throw new BadRequestException('storeCode obrigatório');
    return this.svc.listSales({
      storeCode,
      status,
      limit: limit ? Number(limit) : 20,
    });
  }

  /**
   * GET /pdv/sales/:id
   */
  @Get('sales/:id')
  getSale(@Req() req: any, @Param('id') id: string) {
    this.requireRole(req);
    return this.svc.getSale(id);
  }

  /**
   * POST /pdv/sales/:id/items { skuOrEan, qty? }
   */
  @Post('sales/:id/items')
  addItem(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { skuOrEan: string; qty?: number },
  ) {
    this.requireRole(req);
    return this.svc.addItem({
      saleId: id,
      skuOrEan: body?.skuOrEan,
      qty: body?.qty,
    });
  }

  /**
   * PATCH /pdv/sales/:id/items/:itemId { qty }
   */
  @Patch('sales/:id/items/:itemId')
  updateItemQty(
    @Req() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { qty: number },
  ) {
    this.requireRole(req);
    return this.svc.updateItemQty({
      saleId: id,
      itemId,
      qty: body?.qty,
    });
  }

  /**
   * DELETE /pdv/sales/:id/items/:itemId
   */
  @Delete('sales/:id/items/:itemId')
  removeItem(
    @Req() req: any,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    this.requireRole(req);
    return this.svc.removeItem({ saleId: id, itemId });
  }

  /**
   * PATCH /pdv/sales/:id/customer { cpf, name, email, phone }
   */
  @Patch('sales/:id/customer')
  setCustomer(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { cpf?: string; name?: string; email?: string; phone?: string },
  ) {
    this.requireRole(req);
    return this.svc.setCustomer({ saleId: id, ...body });
  }

  /**
   * POST /pdv/sales/:id/finalize { paymentMethod, paymentDetails? }
   */
  @Post('sales/:id/finalize')
  finalize(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { paymentMethod: string; paymentDetails?: any },
  ) {
    this.requireRole(req);
    return this.svc.finalize({
      saleId: id,
      paymentMethod: body?.paymentMethod,
      paymentDetails: body?.paymentDetails,
    });
  }

  /**
   * POST /pdv/sales/:id/cancel { reason? }
   */
  @Post('sales/:id/cancel')
  cancel(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    this.requireRole(req);
    return this.svc.cancel({ saleId: id, reason: body?.reason });
  }
}
