import { Body, Controller, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { SizeFeedbackService } from '../size-feedback/size-feedback.service';

/**
 * Endpoints PÚBLICOS de catálogo — sem auth (qualquer cliente vê).
 * Usado pelo app PWA (app.lurds.com.br) pra mostrar produtos/categorias.
 */
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly svc: CatalogService,
    private readonly sizeFeedback: SizeFeedbackService,
  ) {}

  /**
   * GET /catalog/size-stats/:productId?size=48
   * Estatísticas públicas de review por tamanho.
   * NOTA: tive que usar /size-stats/:productId em vez de
   * /products/:productId/size-stats pra evitar conflito com /products/:slug.
   */
  @Get('size-stats/:productId')
  async sizeStats(
    @Param('productId') productId: string,
    @Query('size') size?: string,
  ) {
    const id = Number(productId);
    if (!id) return { total: 0, recommendation: 'no_data' };
    return this.sizeFeedback.getStats(id, size);
  }

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

  /**
   * GET /catalog/products/:productId/related
   * Produtos sugeridos pra cross-sell (cross_sell_ids > related_ids > mesma categoria).
   * Usado no modal "Combina com isso" após adicionar ao carrinho.
   */
  @Get('products/:productId/related')
  async relatedProducts(
    @Param('productId') productId: string,
    @Query('limit') limit?: string,
  ) {
    const id = Number(productId);
    if (!id) return { products: [] };
    const products = await this.svc.getRelatedProducts(id, limit ? Number(limit) : 6);
    return { products };
  }

  @Get('products')
  async products(
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('size') size?: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @Query('orderby') orderby?: string,
    @Query('onSale') onSale?: string,
  ) {
    return this.svc.getProducts({
      category,
      search,
      size,
      page: page ? Number(page) : 1,
      perPage: perPage ? Number(perPage) : 12,
      orderby: orderby as any,
      onSale: onSale === '1' || onSale === 'true',
    });
  }

  /**
   * GET /catalog/sizes — lista tamanhos PUROS pra exibir como chips no app.
   * Esconde híbridos (46/48, etc) — o filtro inclui esses automaticamente
   * quando cliente seleciona um tamanho puro. UX mais limpa.
   */
  @Get('sizes')
  async sizes() {
    const sizes = await this.svc.listAppSizes();
    return { sizes };
  }

  /**
   * GET /catalog/stores — lista lojas ativas pra app cliente.
   * Puxa do banco (Store.active=true) ordenado por code. Sempre atualizado.
   */
  @Get('stores')
  async stores() {
    const stores = await this.svc.listAppStores();
    return { stores };
  }

  /**
   * POST /catalog/availability
   * Body: { skus: string[], cep: string }
   *
   * Retorna em quais lojas tem estoque do(s) SKU(s) E distância da cliente.
   * Ordenado por distância. Pra UX "disponível na loja perto de mim".
   */
  @Post('availability')
  async availability(@Body() body: { skus: string[]; cep?: string }) {
    return this.svc.checkAvailability({
      skus: Array.isArray(body?.skus) ? body.skus.filter(Boolean) : [],
      cep: body?.cep || null,
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

  /**
   * GET /catalog/shipping/debug — diagnóstico de zonas de frete do WC.
   * Retorna zonas + locations + methods crus, ignorando cache.
   * Use pra descobrir QUAL zona tem free_shipping ativo e desabilitar no WP Admin.
   */
  @Get('shipping/debug')
  async shippingDebug() {
    const zones = await this.svc.debugWcShippingZones();
    return {
      zones: zones.map((z: any) => ({
        id: z.id,
        name: z.name,
        order: z.order,
        locations: z._locations,
        methods: (z._methods || []).map((m: any) => ({
          instance_id: m.instance_id,
          method_id: m.method_id,
          method_title: m.method_title,
          title: m.title,
          enabled: m.enabled,
          settings_cost: m.settings?.cost?.value,
          settings_min_amount: m.settings?.min_amount?.value,
          settings_requires: m.settings?.requires?.value,
        })),
      })),
    };
  }

  /** POST /catalog/shipping/clear-cache — força refetch das zones na próxima chamada */
  @Post('shipping/clear-cache')
  async clearShippingCache() {
    this.svc.clearWcShippingCache();
    return { ok: true, msg: 'Cache invalidado. Próximo calculateShipping irá refazer fetch.' };
  }
}
