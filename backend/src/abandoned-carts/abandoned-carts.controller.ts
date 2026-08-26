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
import { AdminOnly, AdminOnlyGuard, PermiteLoja } from '../auth/admin-only.guard';

@Controller('public/loja/checkout-recovery')
export class CheckoutRecoveryPublicController {
  constructor(private readonly service: AbandonedCartsService) {}

  @Post()
  capture(@Body() body: any, @Req() request: any) {
    const ip = String(request?.ips?.[0] ?? request?.ip ?? request?.socket?.remoteAddress ?? 'unknown');
    return this.service.captureCheckout(body || {}, ip);
  }
}

/**
 * ⚠️ LOJA TAMBÉM ENTRA AQUI desde 26/08/2026 — `CARRINHO_LOJAS` (env, códigos
 * separados por vírgula) libera a fila de carrinho pra loja. Piloto: Santos
 * (`02`), pra validar se a vendedora trabalha o lead antes de abrir pra rede.
 *
 * Liberado no controller INTEIRO de propósito: aqui não se move dinheiro nem se
 * apaga pedido — é lista de carrinho, quem assumiu e baixa por motivo. Recortar
 * endpoint a endpoint deixaria a tela quebrando com 403 em pedaço solto.
 *
 * A colisão entre duas pessoas já está resolvida no dado: `CarrinhoAtendimento`
 * tem o TELEFONE como chave primária — quem assume primeiro é dono da cliente.
 *
 * Pra fechar de volta: esvaziar a env. Sem `CARRINHO_LOJAS`, volta a ser só matriz.
 */
@Controller('abandoned-carts')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
@PermiteLoja('CARRINHO_LOJAS')
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

  /**
   * QUEM JÁ CHAMOU A CLIENTE — a tag "EM ATENDIMENTO" da aba Carrinhos.
   *
   * ⚠️ Tem que ficar ANTES do `@Get(':id')` lá embaixo: o Nest casa por ordem de
   * declaração e `atendimento` cairia no ParseIntPipe do id.
   *
   * Lista separada (e não um campo dentro de cada carrinho) porque a tela junta
   * QUATRO fontes — plugin, WooCommerce, pedido do site novo e captura de
   * checkout. A marca é por telefone, então um mapa só pinta as quatro sem
   * repetir a regra em quatro lugares.
   */
  @Get('atendimento')
  atendimentos() {
    return this.service.atendimentosAtivos();
  }

  /** Assume o atendimento da cliente (disparado pelo clique no WhatsApp). */
  @Post('atendimento')
  assumirAtendimento(@Body() body: any, @Req() request: any) {
    return this.service.assumirAtendimento(String(body?.telefone ?? ''), request?.user);
  }

  /**
   * BAIXAS — carrinhos que a operadora já resolveu como NÃO CONVERTIDO.
   *
   * Mesma razão do `atendimento` acima pra estar aqui em cima: o Nest casa por
   * ordem de declaração e `desfecho` cairia no ParseIntPipe do `:id`.
   *
   * Vem em lista separada porque a marca vale pra QUALQUER uma das quatro
   * fontes que a tela junta, e a chave é a linha (`pedido:`/`contato:`/...).
   */
  @Get('desfecho')
  desfechos(@Query('since') since?: string) {
    return this.service.desfechos(since);
  }

  /** Dá baixa: registra o motivo e tira a linha da fila. */
  @Post('desfecho')
  marcarNaoConvertido(@Body() body: any, @Req() request: any) {
    return this.service.marcarNaoConvertido(body || {}, request?.user);
  }

  /** Desfaz a baixa — baixa errada tem que ter volta. */
  @Post('desfecho/reabrir')
  reabrirCarrinho(@Body() body: any) {
    return this.service.reabrirCarrinho(String(body?.chave ?? ''));
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
