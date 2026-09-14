import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * PublicVitrineController — endpoint PÚBLICO (sem JWT) pra alimentar a
 * vitrine /vitrine do frontend. É uma simulação da home pública do site,
 * pensada pra testar diagramação e conversão sem depender da infra do WP.
 *
 * ⚠️ MORREU COM O WORDPRESS (27/08/2026) — as três rotas daqui são o
 * `ProductsService` com outro nome (`list` / `getBySlug` / `getRelated`), e
 * aquele caminho é o proxy REST do WooCommerce apagado. Desde 14/09/2026 elas
 * respondem **410 Gone com o motivo escrito** em vez de 500 mudo
 * (`exigirWordpressLegado`, em `woocommerce/wp-morto.ts`).
 *
 * Por que NÃO foram apagadas: ainda têm dois chamadores.
 *   • `ecommerce/src/services/catalog.ts` → `getProduct()`, que a PDP usa como
 *     REDE depois do catálogo novo (`fetchPeca`). O `try/catch` de lá trata
 *     qualquer falha como "não achei" e segue pro resgate de URL antiga
 *     (`/public/loja/slug-antigo`) e depois pro 404 — então o 410 entra no
 *     MESMO desvio que o 500 entrava, sem mudar o que a cliente vê, só mais
 *     rápido e com log legível. Apagar a rota daria 404 e o mesmo desvio, mas
 *     sem deixar escrito na resposta POR QUE não existe mais.
 *   • a tela `/vitrine` do frontend (o protótipo de diagramação), que não
 *     está no escopo deste PR.
 *
 * A vitrine DE VERDADE não passa por aqui: o site novo lê `loja-catalog` /
 * `site-vitrines` / `site-categorias`, tudo Postgres.
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
