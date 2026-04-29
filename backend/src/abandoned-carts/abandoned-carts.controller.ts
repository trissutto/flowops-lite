import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AbandonedCartsService } from './abandoned-carts.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';

@Controller('abandoned-carts')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class AbandonedCartsController {
  constructor(private readonly service: AbandonedCartsService) {}

  /** Ping do plugin PHP (checa se a chave/URL estão batendo). */
  @Get('ping')
  ping() {
    return this.service.ping();
  }

  /** Diagnóstico do schema (nome da tabela + colunas + 3 linhas de amostra). */
  @Get('schema')
  schema() {
    return this.service.schema();
  }

  /** KPIs agregados. Query opcional: ?since=YYYY-MM-DD */
  @Get('stats')
  stats(@Query('since') since?: string) {
    return this.service.stats(since);
  }

  /**
   * Lista paginada de carrinhos.
   * Query: page, per_page, status, since (YYYY-MM-DD), until, search
   */
  @Get()
  list(
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('status') status?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('search') search?: string,
  ) {
    return this.service.list({
      page: page ? parseInt(page, 10) : undefined,
      perPage: perPage ? parseInt(perPage, 10) : undefined,
      status,
      since,
      until,
      search,
    });
  }

  /**
   * FALLBACK via WooCommerce REST — funciona sem o plugin .php instalado.
   * Lista pedidos pending/failed/on-hold como proxy de carrinho abandonado.
   * Query: page, per_page, status (abandoned|recovered|lost|all), since, until, search
   */
  @Get('wc-pending/list')
  wcPending(
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
    @Query('status') status?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listWcPending({
      page: page ? parseInt(page, 10) : undefined,
      perPage: perPage ? parseInt(perPage, 10) : undefined,
      status,
      since,
      until,
      search,
    });
  }

  /** Stats agregadas via fallback WC. */
  @Get('wc-pending/stats')
  wcPendingStats(
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    return this.service.statsWcPending(since, until);
  }

  /** Detalhe com carrinho deserializado. */
  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.service.detail(id);
  }
}
