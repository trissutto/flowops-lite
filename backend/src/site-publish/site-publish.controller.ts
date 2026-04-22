import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { SitePublishService } from './site-publish.service';

/**
 * SitePublishController — endpoints pra tela /retaguarda/publicar-site.
 *
 * Restrito a admin/operator (matriz). Vendedora de loja NÃO pode marcar
 * produto pra subir no site — é decisão do CEO.
 */
@Controller('site-publish')
@UseGuards(JwtAuthGuard)
export class SitePublishController {
  constructor(private readonly service: SitePublishService) {}

  private assertAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'operator') {
      throw new ForbiddenException('Acesso restrito à matriz (admin/operator).');
    }
  }

  /**
   * Busca no Gigasistemas por REFs a publicar.
   *
   * Query params (todos opcionais, combinam com AND):
   *   refs        — CSV de REFs exatas (fast-path). Ex: "01010101,01010102"
   *   term        — trecho em DESCRICAOCOMPLETA (palavras AND)
   *   grupo       — filtro exato em GRUPO (só se coluna existir)
   *   subgrupo    — filtro exato em SUBGRUPO
   *   fornecedor  — filtro exato em FORNECEDOR
   *   diasCadastro— últimos N dias (só se DATACADASTRO existir no schema)
   *   limit       — máx de REFs retornadas (default 200, max 500)
   */
  @Get('giga-search')
  async gigaSearch(@Req() req: any, @Query() query: any) {
    this.assertAdmin(req);
    const refsCsv = typeof query.refs === 'string' ? query.refs : '';
    const refs = refsCsv
      ? refsCsv
          .split(/[,\n\r\t;]+/)
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined;
    const filters = {
      refs,
      term: typeof query.term === 'string' ? query.term.trim() : undefined,
      grupo: typeof query.grupo === 'string' && query.grupo ? query.grupo.trim() : undefined,
      subgrupo: typeof query.subgrupo === 'string' && query.subgrupo ? query.subgrupo.trim() : undefined,
      fornecedor:
        typeof query.fornecedor === 'string' && query.fornecedor ? query.fornecedor.trim() : undefined,
      diasCadastro: query.diasCadastro ? Number(query.diasCadastro) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    };
    return this.service.searchGiga(filters);
  }

  /** Lista de grupos, subgrupos, fornecedores pra popular dropdowns. */
  @Get('facets')
  async facets(@Req() req: any) {
    this.assertAdmin(req);
    return this.service.facets();
  }

  /**
   * Adiciona UMA cor à fila.
   * Body: { refCode, cor }
   */
  @Post('queue')
  async addToQueue(@Req() req: any, @Body() body: any) {
    this.assertAdmin(req);
    if (!body?.refCode || !body?.cor) {
      throw new BadRequestException('refCode e cor obrigatórios.');
    }
    return this.service.addToQueue({
      refCode: String(body.refCode).trim(),
      cor: String(body.cor).trim(),
      userId: req?.user?.sub,
    });
  }

  /**
   * Adiciona em lote (várias REFs+cores de uma vez).
   * Body: { items: [{refCode, cor}, ...] }
   */
  @Post('queue/batch')
  async addToQueueBatch(@Req() req: any, @Body() body: any) {
    this.assertAdmin(req);
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) throw new BadRequestException('items[] vazio.');
    const clean = items
      .map((it: any) => ({
        refCode: String(it?.refCode || '').trim(),
        cor: String(it?.cor || '').trim(),
      }))
      .filter((it: any) => it.refCode && it.cor)
      .slice(0, 500);
    return this.service.addToQueueBatch(clean, req?.user?.sub);
  }

  /** Lista a fila, com filtro opcional por status. */
  @Get('queue')
  async listQueue(@Req() req: any, @Query('status') status?: string) {
    this.assertAdmin(req);
    return this.service.listQueue({ status });
  }

  /** Detalhe de um item (pra enriquecimento Fase 2). */
  @Get('queue/:id')
  async getQueueItem(@Req() req: any, @Param('id') id: string) {
    this.assertAdmin(req);
    return this.service.getQueueItem(id);
  }

  /** Remove da fila. Não funciona pra itens já publicados. */
  @Delete('queue/:id')
  async removeFromQueue(@Req() req: any, @Param('id') id: string) {
    this.assertAdmin(req);
    return this.service.removeFromQueue(id);
  }
}
