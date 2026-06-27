import {
  Body, Controller, Get, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import {
  CatalogFilters, ProductClassificationService, QuickFilter,
} from './product-classification.service';

/**
 * Tela Cadastros → Classificação de Produtos (BÁSICO/MODA).
 * Só matriz (admin + operator) — @AdminOnly na classe.
 *
 * Rotas:
 *   GET  /product-classification/list      — grid paginado + filtros
 *   GET  /product-classification/counters  — cartões do topo
 *   GET  /product-classification/facets     — marcas/fornecedores/categorias p/ filtros
 *   POST /product-classification/set        — toggle de 1 REF
 *   POST /product-classification/bulk       — alteração em lote (selecionados ou filtro)
 *   POST /product-classification/refresh    — recarrega snapshot do catálogo do ERP
 */
@Controller('product-classification')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class ProductClassificationController {
  constructor(private readonly svc: ProductClassificationService) {}

  private filtersFromQuery(q: any): CatalogFilters {
    return {
      search: q.search ? String(q.search) : undefined,
      quick: (q.quick as QuickFilter) || undefined,
      marca: q.marca ? String(q.marca) : undefined,
      fornecedor: q.fornecedor ? String(q.fornecedor) : undefined,
      categoria: q.categoria ? String(q.categoria) : undefined,
      plusSize: String(q.plusSize) === '1' || String(q.plusSize) === 'true',
    };
  }

  private userLabel(req: any): string {
    return req?.user?.name || req?.user?.email || `user#${req?.user?.sub || '?'}`;
  }

  @Get('list')
  list(@Query() q: any) {
    const page = parseInt(q.page, 10) || 1;
    const perPage = parseInt(q.perPage, 10) || 50;
    return this.svc.list(this.filtersFromQuery(q), page, perPage);
  }

  @Get('counters')
  counters() {
    return this.svc.counters();
  }

  @Get('facets')
  facets() {
    return this.svc.facets();
  }

  @Post('refresh')
  refresh() {
    return this.svc.refresh();
  }

  @Post('set')
  set(@Body() body: { ref: string; tipoProduto: number }, @Req() req: any) {
    return this.svc.setOne(body?.ref, Number(body?.tipoProduto), this.userLabel(req));
  }

  @Post('bulk')
  bulk(
    @Body() body: { tipoProduto: number; refs?: string[]; filtro?: CatalogFilters },
    @Req() req: any,
  ) {
    return this.svc.bulk({
      tipoProduto: Number(body?.tipoProduto),
      refs: body?.refs,
      filtro: body?.filtro,
      user: this.userLabel(req),
    });
  }
}
