import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * PublicVitrineController — endpoint PÚBLICO (sem JWT) pra alimentar a
 * vitrine /vitrine do frontend. É uma simulação da home pública do site,
 * pensada pra testar diagramação e conversão sem depender da infra do WP.
 *
 * Por que separado do ProductsController:
 *   - ProductsController tem @UseGuards(JwtAuthGuard) no topo (todos os
 *     endpoints exigem login). Se eu puxar o guard, arrebenta rotas internas.
 *   - Este controller é um "anexo" explicitamente público — fácil de ver
 *     que não exige auth.
 *   - Caso no futuro queira expor pra internet (vitrine real), está isolado
 *     pra aplicar rate-limit / cache HTTP à parte.
 *
 * Reusa ProductsService.list() do ProductsModule (importa o service, que já
 * está registrado como provider lá).
 *
 * Retorno: mesmo shape do GET /products — mas status=publish fixo (só peça
 * ativa aparece na vitrine).
 */
@Controller('public/vitrine')
export class PublicVitrineController {
  constructor(private readonly products: ProductsService) {}

  /**
   * Lista de produtos pra vitrine. Parâmetros:
   *   - page (default 1)
   *   - per_page (default 24, max 60 pra não travar com catálogo enorme)
   *   - search (opcional)
   *   - stock (default 'instock' — esconde sem estoque)
   *   - orderby: date | sales (default 'sales' — mais vendidos primeiro)
   */
  @Get()
  async list(
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('search') search?: string,
    @Query('stock') stock?: 'instock' | 'outofstock' | 'any',
    @Query('orderby') orderby?: 'date' | 'sales',
  ) {
    const per = Math.min(parseInt(perPage ?? '24', 10) || 24, 60);
    const result = await this.products.list({
      page: page ? parseInt(page, 10) : 1,
      perPage: per,
      search,
      status: 'publish',
      stockStatus: stock === 'any' ? undefined : (stock ?? 'instock'),
    });

    // Ordena por totalSales (mais vendidos) quando pedido — o WC já aceita
    // orderby=popularity mas o endpoint interno não expõe. Ordeno client-side
    // aqui pra não mexer no service compartilhado.
    if (orderby === 'sales') {
      result.data = [...result.data].sort(
        (a: any, b: any) => (b.totalSales ?? 0) - (a.totalSales ?? 0),
      );
    }

    return result;
  }

  /**
   * Detalhe de um produto pelo slug — alimenta /vitrine/[slug] do frontend.
   * Retorna shape completo (galeria de imagens, variações, atributos,
   * descrição). 404 se não encontrado.
   */
  @Get(':slug')
  async detail(@Param('slug') slug: string) {
    const p = await this.products.getBySlug(slug);
    if (!p) throw new NotFoundException('Produto não encontrado');
    return p;
  }

  /**
   * Produtos relacionados (mesma categoria) pro bloco "você também pode
   * gostar" na página de detalhe. Ordena por popularidade.
   */
  @Get(':slug/related')
  async related(@Param('slug') slug: string) {
    const p = await this.products.getBySlug(slug);
    if (!p) throw new NotFoundException('Produto não encontrado');
    return this.products.getRelated(p.id, 8);
  }
}
