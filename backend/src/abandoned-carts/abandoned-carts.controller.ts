import {
  Controller,
  Body,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AbandonedCartsService } from './abandoned-carts.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';

@Controller('public/loja/checkout-recovery')
export class CheckoutRecoveryPublicController {
  constructor(private readonly service: AbandonedCartsService) {}

  @Post()
  capture(@Body() body: any, @Req() request: any) {
    const ip = String(request?.ips?.[0] ?? request?.ip ?? request?.socket?.remoteAddress ?? 'unknown');
    return this.service.captureCheckout(body || {}, ip);
  }
}

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

  /**
   * Carrinhos do E-COMMERCE NOVO (lurdsplussize.com.br) — pedidos
   * source='ecommerce' do Postgres com checkout iniciado e sem pagamento.
   * Query: status (abandoned|recovered|lost|all), since, until, search.
   */
  @Get('ecommerce/list')
  ecommercePending(
    @Query('status') status?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listEcommercePending({ status, since, until, search });
  }

  /** KPIs do e-commerce novo — o badge da aba soma isto ao plugin. */
  @Get('ecommerce/stats')
  ecommerceStats(@Query('since') since?: string, @Query('until') until?: string) {
    return this.service.statsEcommercePending(since, until);
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

  /**
   * Detalhe HIDRATADO: pega o detail do plugin + busca cada produto no WC REST
   * pra trazer nome, imagem, SKU, preco. Necessario porque o plugin PHP do
   * CartFlows so guarda product_id e quantity no cart_contents.
   */
  @Get(':id/full')
  detailFull(@Param('id', ParseIntPipe) id: number) {
    return this.service.detailFull(id);
  }
}
