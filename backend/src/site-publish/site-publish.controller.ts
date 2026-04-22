import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
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
 *
 * Mapa de endpoints:
 *   GET    /site-publish/status            — habilitação IA + upload
 *   GET    /site-publish/giga-search       — busca REFs no Wincred
 *   GET    /site-publish/facets            — dropdowns (grupo/subgrupo/forn)
 *   POST   /site-publish/queue             — marca 1 cor pra fila
 *   POST   /site-publish/queue/batch       — marca várias cores de uma vez
 *   GET    /site-publish/queue             — lista fila (filtra por status)
 *   GET    /site-publish/queue/:id         — detalhe (pra enriquecer)
 *   PATCH  /site-publish/queue/:id         — salva enriquecimento manual
 *   DELETE /site-publish/queue/:id         — remove da fila
 *   POST   /site-publish/queue/:id/ai      — gera conteúdo com IA
 *   POST   /site-publish/queue/:id/image   — upload imagem (via URL)
 *   POST   /site-publish/queue/:id/publish — publica no WC como draft
 *   GET    /site-publish/wc/categories     — categorias WC ao vivo
 *   GET    /site-publish/wc/tags           — tags WC ao vivo
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

  /** Status das integrações (IA + upload mídia). */
  @Get('status')
  async status(@Req() req: any) {
    this.assertAdmin(req);
    return this.service.integrationStatus();
  }

  // ============================================================
  // FASE 1 — SEARCH & QUEUE
  // ============================================================

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

  @Get('facets')
  async facets(@Req() req: any) {
    this.assertAdmin(req);
    return this.service.facets();
  }

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

  @Get('queue')
  async listQueue(@Req() req: any, @Query('status') status?: string) {
    this.assertAdmin(req);
    return this.service.listQueue({ status });
  }

  @Get('queue/:id')
  async getQueueItem(@Req() req: any, @Param('id') id: string) {
    this.assertAdmin(req);
    return this.service.getQueueItem(id);
  }

  @Delete('queue/:id')
  async removeFromQueue(@Req() req: any, @Param('id') id: string) {
    this.assertAdmin(req);
    return this.service.removeFromQueue(id);
  }

  // ============================================================
  // FASE 2 — ENRIQUECIMENTO
  // ============================================================

  /**
   * Salva edição do enriquecimento. Body aceita qualquer subconjunto dos
   * campos wcTitulo/wcCategoryIds/wcTags/wcAtributos/wcDescricao/
   * wcDescricaoCurta/wcImagens/wcPesoKg/wcDimensoesCm/wcPrecoVenda/wcPrecoPromo.
   */
  @Patch('queue/:id')
  async patchQueueItem(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.assertAdmin(req);
    const patch: any = {};
    if (body?.wcTitulo !== undefined) patch.wcTitulo = body.wcTitulo ? String(body.wcTitulo).trim() : null;
    if (body?.wcCategoryIds !== undefined) {
      patch.wcCategoryIds = Array.isArray(body.wcCategoryIds)
        ? body.wcCategoryIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
        : null;
    }
    if (body?.wcTags !== undefined) {
      patch.wcTags = Array.isArray(body.wcTags)
        ? body.wcTags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 30)
        : null;
    }
    if (body?.wcAtributos !== undefined) {
      patch.wcAtributos = Array.isArray(body.wcAtributos)
        ? body.wcAtributos
            .map((a: any) => ({
              nome: String(a?.nome || '').trim(),
              valor: String(a?.valor || '').trim(),
            }))
            .filter((a: any) => a.nome && a.valor)
            .slice(0, 20)
        : null;
    }
    if (body?.wcDescricao !== undefined) patch.wcDescricao = body.wcDescricao ? String(body.wcDescricao) : null;
    if (body?.wcDescricaoCurta !== undefined) {
      patch.wcDescricaoCurta = body.wcDescricaoCurta ? String(body.wcDescricaoCurta) : null;
    }
    if (body?.wcImagens !== undefined) {
      patch.wcImagens = Array.isArray(body.wcImagens)
        ? body.wcImagens
            .map((i: any) => ({
              id: i?.id ? Number(i.id) : undefined,
              url: String(i?.url || '').trim(),
              alt: i?.alt ? String(i.alt).trim() : '',
            }))
            .filter((i: any) => i.url)
        : null;
    }
    if (body?.wcPesoKg !== undefined) patch.wcPesoKg = body.wcPesoKg ? Number(body.wcPesoKg) : null;
    if (body?.wcDimensoesCm !== undefined) {
      const d = body.wcDimensoesCm;
      patch.wcDimensoesCm = d
        ? {
            comprimento: d.comprimento ? Number(d.comprimento) : undefined,
            largura: d.largura ? Number(d.largura) : undefined,
            altura: d.altura ? Number(d.altura) : undefined,
          }
        : null;
    }
    if (body?.wcPrecoVenda !== undefined) patch.wcPrecoVenda = body.wcPrecoVenda ? Number(body.wcPrecoVenda) : null;
    if (body?.wcPrecoPromo !== undefined) patch.wcPrecoPromo = body.wcPrecoPromo ? Number(body.wcPrecoPromo) : null;

    return this.service.saveEnrichment(id, patch);
  }

  /** Gera conteúdo com IA. Body: { force?: boolean }. */
  @Post('queue/:id/ai')
  async aiGenerate(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.assertAdmin(req);
    return this.service.aiGenerate(id, { force: !!body?.force });
  }

  /**
   * Adiciona imagem via URL pública (cola link que o frontend gerou ou URL
   * direta de imagem hospedada em algum lugar).
   * Body: { sourceUrl: string, alt?: string }
   */
  @Post('queue/:id/image')
  async uploadImage(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.assertAdmin(req);
    const sourceUrl = String(body?.sourceUrl || '').trim();
    if (!sourceUrl) throw new BadRequestException('sourceUrl obrigatória.');
    return this.service.uploadImage(id, { sourceUrl, alt: body?.alt });
  }

  /** Categorias WC (live). */
  @Get('wc/categories')
  async wcCategories(@Req() req: any) {
    this.assertAdmin(req);
    return this.service.wcCategories();
  }

  /** Tags WC (live, com search opcional). */
  @Get('wc/tags')
  async wcTags(@Req() req: any, @Query('search') search?: string) {
    this.assertAdmin(req);
    return this.service.wcTags(search);
  }

  // ============================================================
  // FASE 3 — PUBLICAÇÃO
  // ============================================================

  /** Publica no WC como draft. Body: { force?: boolean } — aceita sobrescrita de SKU duplicado (MVP: force não implementado). */
  @Post('queue/:id/publish')
  async publish(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.assertAdmin(req);
    return this.service.publishToWc(id, { force: !!body?.force });
  }

  /**
   * Re-aplica o código Giga (EAN da etiqueta) em cada variação já criada no
   * WC. Corrige produtos publicados antes da gente setar o global_unique_id
   * no payload de criação — evita apagar e re-publicar.
   */
  @Post('queue/:id/sync-eans')
  async syncEans(@Req() req: any, @Param('id') id: string) {
    this.assertAdmin(req);
    return this.service.syncEansOnWc(id);
  }

  // ============================================================
  // BULK — agilizar quando são muitas cores
  // ============================================================

  /**
   * Publica vários itens de uma vez. Body: { ids: string[], force?: boolean }.
   * Sequencial pra não bater em rate-limit do WC/WP.
   */
  @Post('queue/publish-batch')
  async publishBatch(@Req() req: any, @Body() body: any) {
    this.assertAdmin(req);
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.map((x: any) => String(x)).filter(Boolean)
      : [];
    if (!ids.length) throw new BadRequestException('ids[] vazio.');
    return this.service.publishBatch(ids, { force: !!body?.force });
  }

  /**
   * Dispara IA em vários itens de uma vez. Body: { ids: string[], force?: boolean }.
   * Útil pra gerar conteúdo pra 10 cores da mesma REF num único clique.
   */
  @Post('queue/ai-batch')
  async aiBatch(@Req() req: any, @Body() body: any) {
    this.assertAdmin(req);
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.map((x: any) => String(x)).filter(Boolean)
      : [];
    if (!ids.length) throw new BadRequestException('ids[] vazio.');
    return this.service.aiGenerateBatch(ids, { force: !!body?.force });
  }

  /**
   * Edição em bloco. Body: { ids: string[], patch: {...} }
   * Aplica o mesmo patch em todos os itens (campos aceitos = PATCH /queue/:id).
   * NÃO afeta itens já publicados.
   */
  @Patch('queue/bulk')
  async bulkPatch(@Req() req: any, @Body() body: any) {
    this.assertAdmin(req);
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.map((x: any) => String(x)).filter(Boolean)
      : [];
    if (!ids.length) throw new BadRequestException('ids[] vazio.');
    const raw = body?.patch || {};
    const patch: any = {};
    if (raw.wcTitulo !== undefined) patch.wcTitulo = raw.wcTitulo ? String(raw.wcTitulo).trim() : null;
    if (raw.wcCategoryIds !== undefined) {
      patch.wcCategoryIds = Array.isArray(raw.wcCategoryIds)
        ? raw.wcCategoryIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
        : null;
    }
    if (raw.wcTags !== undefined) {
      patch.wcTags = Array.isArray(raw.wcTags)
        ? raw.wcTags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 30)
        : null;
    }
    if (raw.wcAtributos !== undefined) {
      patch.wcAtributos = Array.isArray(raw.wcAtributos)
        ? raw.wcAtributos
            .map((a: any) => ({
              nome: String(a?.nome || '').trim(),
              valor: String(a?.valor || '').trim(),
            }))
            .filter((a: any) => a.nome && a.valor)
            .slice(0, 20)
        : null;
    }
    if (raw.wcDescricao !== undefined) patch.wcDescricao = raw.wcDescricao ? String(raw.wcDescricao) : null;
    if (raw.wcDescricaoCurta !== undefined) {
      patch.wcDescricaoCurta = raw.wcDescricaoCurta ? String(raw.wcDescricaoCurta) : null;
    }
    if (raw.wcPesoKg !== undefined) patch.wcPesoKg = raw.wcPesoKg ? Number(raw.wcPesoKg) : null;
    if (raw.wcDimensoesCm !== undefined) {
      const d = raw.wcDimensoesCm;
      patch.wcDimensoesCm = d
        ? {
            comprimento: d.comprimento ? Number(d.comprimento) : undefined,
            largura: d.largura ? Number(d.largura) : undefined,
            altura: d.altura ? Number(d.altura) : undefined,
          }
        : null;
    }
    if (raw.wcPrecoVenda !== undefined) patch.wcPrecoVenda = raw.wcPrecoVenda ? Number(raw.wcPrecoVenda) : null;
    if (raw.wcPrecoPromo !== undefined) patch.wcPrecoPromo = raw.wcPrecoPromo ? Number(raw.wcPrecoPromo) : null;
    return this.service.bulkPatchQueue(ids, patch);
  }
}
