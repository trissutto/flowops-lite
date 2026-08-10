import {
  Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { LojaCatalogService, ListarParams } from './loja-catalog.service';
import { SiteSyncService } from './site-sync.service';

/**
 * CATÁLOGO PÚBLICO DO E-COMMERCE (sprint 008).
 *
 * Sem JWT: é o que o site novo consome. Não expõe custo, margem nem estoque
 * por loja — só o que a cliente pode ver. Tudo sai do Postgres local (espelho
 * do ERP + cadastro do Flow), então aguenta ISR/prefetch sem encostar no
 * Giga nem no WordPress.
 */
@Controller('public/loja')
export class LojaCatalogPublicController {
  constructor(private readonly svc: LojaCatalogService) {}

  private booleano(v?: string) {
    if (v === undefined) return undefined;
    return v === '1' || v === 'true';
  }

  /**
   * GET /api/public/loja/grades-medidas — as tabelas de medida da casa.
   *
   * As grades já existiam cadastradas (`grades_medidas`, com busto/cintura/
   * quadril em centímetros por tamanho) e **não tinham porta pública**. Por
   * isso o site linkava "Guia de medidas" pra uma rota que não existe: não
   * havia de onde tirar o número.
   *
   * É o dado que mais decide compra de plus size — e o único que não dá pra
   * inventar: medida errada é troca na certa.
   */
  @Get('grades-medidas')
  gradesMedidas() {
    return this.svc.gradesMedidas();
  }

  /**
   * GET /api/public/loja/feed — catálogo inteiro pro feed de produtos do Meta.
   *
   * Quem monta o XML é o site (`/feed/meta.xml`), que sabe o domínio público e
   * a URL de cada peça. Aqui sai só o dado, sem paginação: o Meta lê uma vez
   * por dia e precisa do catálogo completo. Ver `catalogoParaFeed`.
   */
  @Get('feed')
  feed() {
    return this.svc.catalogoParaFeed();
  }

  @Get('produtos')
  produtos(@Query() q: any) {
    const params: ListarParams = {
      page: q.page ? Number(q.page) : 1,
      perPage: q.perPage ? Number(q.perPage) : 24,
      busca: q.busca || q.q || undefined,
      categoria: q.categoria || undefined,
      marca: q.marca || undefined,
      cor: q.cor || undefined,
      tamanho: q.tamanho || undefined,
      modelagem: q.modelagem || undefined,
      // Eixos da ficha do CRM (item 44) — tecido, ocasião e coleção.
      tecido: q.tecido || undefined,
      ocasiao: q.ocasiao || undefined,
      colecao: q.colecao || undefined,
      precoMin: q.precoMin ? Number(q.precoMin) : undefined,
      precoMax: q.precoMax ? Number(q.precoMax) : undefined,
      soPromocao: this.booleano(q.promocao),
      soNovidade: this.booleano(q.novidade),
      /**
       * ⚠️ O padrão era `?? true` — ESCONDER esgotado por omissão (item 37).
       * A peça sumia da vitrine sem explicação e a cliente achava que o site
       * tinha quebrado. Agora ela aparece riscada, e some só se pedirem
       * `?disponivel=1`. A ordenação joga esgotado pro fim.
       */
      soDisponivel: this.booleano(q.disponivel),
      ordenar: q.ordenar,
    };
    return this.svc.listar(params);
  }

  @Get('filtros')
  filtros() {
    return this.svc.filtros();
  }

  @Get('produto/:slug')
  async produto(@Param('slug') slug: string) {
    const p = await this.svc.porSlug(slug);
    if (!p) throw new NotFoundException('Produto não encontrado');
    return p;
  }

  @Get('produto/:slug/relacionados')
  relacionados(@Param('slug') slug: string, @Query('limite') limite?: string) {
    return this.svc.relacionados(slug, limite ? Number(limite) : 8);
  }
}

/**
 * ADMINISTRAÇÃO DO CATÁLOGO DO SITE (matriz).
 *   GET   /loja-catalog/validacao        → conferência ERP × site, com números
 *   POST  /loja-catalog/importar         → puxa conteúdo do site antigo
 *   GET   /loja-catalog/sync/historico   → log das rodadas
 *   PATCH /loja-catalog/produto/:ref     → edita o cadastro comercial
 *                                          (e o Flow toma posse da peça)
 */
@UseGuards(JwtAuthGuard)
@Controller('loja-catalog')
export class LojaCatalogAdminController {
  constructor(
    private readonly svc: LojaCatalogService,
    private readonly sync: SiteSyncService,
  ) {}

  private requireAdmin(req: any) {
    const role = req?.user?.role;
    if (role !== 'admin' && role !== 'master' && role !== 'operador') {
      throw new ForbiddenException('Apenas matriz');
    }
  }

  @Get('validacao')
  validacao(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.validacao();
  }

  @Post('importar')
  importar(@Req() req: any) {
    this.requireAdmin(req);
    const quem = req?.user?.email || req?.user?.name || 'admin';
    return this.sync.sincronizarConteudo(quem);
  }

  @Get('sync/historico')
  historico(@Req() req: any, @Query('limite') limite?: string) {
    this.requireAdmin(req);
    return this.sync.historico(limite ? Number(limite) : 20);
  }

  @Get('produto/:ref')
  async produto(@Req() req: any, @Param('ref') ref: string) {
    this.requireAdmin(req);
    const p = await this.svc.porSlug(ref);
    if (!p) throw new NotFoundException('REF não encontrada no ERP');
    return p;
  }

  @Patch('produto/:ref')
  editar(@Req() req: any, @Param('ref') ref: string, @Body() body: any) {
    this.requireAdmin(req);
    const quem = req?.user?.email || req?.user?.name || null;
    return this.svc.editar(ref, body || {}, quem);
  }
}
