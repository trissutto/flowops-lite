import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';

/**
 * Endpoints PÚBLICOS de catálogo — sem auth (qualquer cliente vê).
 * Usado pelo app PWA (app.lurds.com.br) pra mostrar produtos/categorias.
 */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly svc: CatalogService) {}

  @Get('categories')
  async categories() {
    const data = await this.svc.getCategories();
    return { categories: data };
  }

  @Get('products/:slug')
  async productBySlug(@Param('slug') slug: string) {
    const product = await this.svc.getProductBySlug(slug);
    if (!product) throw new NotFoundException('Produto não encontrado');
    return product;
  }

  @Get('products')
  async products(
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @Query('orderby') orderby?: string,
    @Query('onSale') onSale?: string,
  ) {
    return this.svc.getProducts({
      category,
      search,
      page: page ? Number(page) : 1,
      perPage: perPage ? Number(perPage) : 12,
      orderby: orderby as any,
      onSale: onSale === '1' || onSale === 'true',
    });
  }

  @Post('shipping/calculate')
  async calculateShipping(@Body() body: { cep: string; weight?: number }) {
    const options = await this.svc.calculateShipping(body);
    return { options };
  }

  @Post('orders/create')
  async createOrder(@Body() body: any) {
    return this.svc.createOrder(body);
  }

  /** POST /catalog/app-checkout — prepara checkout WC via plugin */
  @Post('app-checkout')
  async appCheckout(@Body() body: any) {
    return this.svc.appCheckout(body);
  }

  @Get('orders/:wcOrderId')
  async getOrder(@Param('wcOrderId') wcOrderId: string) {
    const id = Number(wcOrderId);
    if (!id) throw new NotFoundException('Pedido inválido');
    const order = await this.svc.getOrder(id);
    if (!order) throw new NotFoundException('Pedido não encontrado');
    return order;
  }

  /** GET /catalog/payment-methods — diagnóstico: lista gateways do WC */
  @Get('payment-methods')
  async paymentMethods() {
    return { gateways: await this.svc.getPaymentGateways() };
  }
}
