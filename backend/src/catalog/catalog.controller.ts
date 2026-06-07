import { Controller, Get, Query } from '@nestjs/common';
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
}
