import {
  Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { LojaCatalogService, ListarParams } from './loja-catalog.service';
import { SiteSyncService } from './site-sync.service';
import { InstagramFeedService } from './instagram-feed.service';
import { GrupoRefService } from './grupo-ref.service';
import { ClassificacaoService, FiltroClassificacao } from './classificacao.service';

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
  constructor(
    private readonly svc: LojaCatalogService,
    private readonly instagramSvc: InstagramFeedService,
  ) {}

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

  /**
   * GET /api/public/loja/instagram — os posts REAIS da @lurdsplussize.
   *
   * A grade da home mostrava foto de banco de imagem: bonita, e de outra
   * marca. Prova social só vale sendo a de verdade. Lista vazia quando a
   * integração não está configurada ou o Instagram falha — o site cai na
   * grade estática em vez de quebrar. Ver `InstagramFeedService`.
   */
  @Get('instagram')
  instagram(@Query('limite') limite?: string) {
    const n = Math.min(12, Math.max(1, Number(limite) || 6));
    return this.instagramSvc.posts(n);
  }

  @Get('produtos')
  produtos(@Query() q: any) {
    const params: ListarParams = {
      page: q.page ? Number(q.page) : 1,
      perPage: q.perPage ? Number(q.perPage) : 24,
      busca: q.busca || q.q || undefined,
      categoria: q.categoria || undefined,
      /**
       * SEGUNDO NÍVEL — `?subcategoria=manga-curta` (o chip da página da
       * categoria). O parâmetro chegava e era jogado fora: `/produtos?
       * categoria=blusas&subcategoria=regata` devolvia as mesmas 180 peças de
       * `categoria=blusas`. O chip pintava de dourado e a grade não mudava.
       */
      subcategoria: q.subcategoria || undefined,
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

  /**
   * GET /api/public/loja/produto/:slug/descobrir — o feed que continua a PDP.
   *
   * Uma sequência só: resto da subcategoria → resto da categoria → as outras
   * categorias na ordem do menu. Paginado porque a lista é o catálogo inteiro;
   * ver `LojaCatalogService.descobrir`.
   */
  @Get('produto/:slug/descobrir')
  descobrir(
    @Param('slug') slug: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    return this.svc.descobrir(slug, Number(page) || 1, Number(perPage) || 12);
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
    private readonly grupos: GrupoRefService,
    private readonly classificacao: ClassificacaoService,
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

  /**
   * DE-PARA de categorias — o que o WooCommerce manda × o que o site mostra.
   *
   * A tela `/retaguarda/categorias-mapa` lista as categorias que o sync viu no
   * WooCommerce (com quantas peças vieram em cada) e deixa escolher onde cada
   * uma entra no site. Antes disso, categoria fora do mapa fixo do código
   * fazia a peça cair no palpite pelo nome — e corrigir exigia deploy.
   */
  @Get('categorias-mapa')
  categoriasMapa(@Req() req: any) {
    this.requireAdmin(req);
    return this.svc.listarCategoriasMapa();
  }

  @Patch('categorias-mapa/:origem')
  salvarCategoriaMapa(
    @Req() req: any,
    @Param('origem') origem: string,
    @Body() body: { destino: string | null },
  ) {
    this.requireAdmin(req);
    const quem = req?.user?.email || req?.user?.name || 'admin';
    return this.svc.salvarCategoriaMapa(origem, body?.destino ?? null, quem);
  }

  /**
   * PRODUTOS AGRUPADOS — mesma peça em REFs diferentes.
   *
   * No catálogo legado a cor virava REF nova (`900887` preta, `900887B` bege),
   * e a vitrine mostrava dois cards do mesmo produto. A tela
   * `/retaguarda/produtos-agrupados` revisa o que o automático propôs — e
   * separar/juntar na mão TRAVA a decisão contra o sync. Ver `GrupoRefService`.
   */
  @Get('grupos')
  gruposListar(@Req() req: any) {
    this.requireAdmin(req);
    return this.grupos.listar();
  }

  @Post('grupos/recalcular')
  gruposRecalcular(@Req() req: any) {
    this.requireAdmin(req);
    return this.grupos.recalcular();
  }

  @Patch('grupos/:ref')
  gruposDefinir(@Req() req: any, @Param('ref') ref: string, @Body() body: { grupo: string | null }) {
    this.requireAdmin(req);
    return this.grupos.definir(ref, body?.grupo ?? null);
  }

  /**
   * CLASSIFICAÇÃO EM LOTE na árvore do site (categoria → subcategoria).
   *
   * 773 das 797 peças publicadas estavam sem grupo em 10/08/2026, e 345 sem
   * categoria nenhuma — quase metade da loja fora de todo menu. Uma a uma
   * seriam 773 telas; aqui a unidade é o lote. Ver `ClassificacaoService`.
   */
  @Get('classificacao/arvore')
  classArvore(@Req() req: any) {
    this.requireAdmin(req);
    return this.classificacao.arvore();
  }

  @Get('classificacao/progresso')
  classProgresso(@Req() req: any) {
    this.requireAdmin(req);
    return this.classificacao.progresso();
  }

  @Get('classificacao')
  classListar(@Req() req: any, @Query() q: any) {
    this.requireAdmin(req);
    return this.classificacao.listar({
      ...this.filtroClassificacao(q),
      page: q.page ? Number(q.page) : 1,
      perPage: q.perPage ? Number(q.perPage) : 50,
    });
  }

  /** Todas as REFs do filtro — o "marcar as N do filtro" da tela. */
  @Get('classificacao/refs')
  classRefs(@Req() req: any, @Query() q: any) {
    this.requireAdmin(req);
    return this.classificacao.refs(this.filtroClassificacao(q));
  }

  @Post('classificacao')
  classAplicar(
    @Req() req: any,
    @Body() body: {
      refs: string[];
      categoria: string | null;
      subcategoria: string | null;
      manterCategoria?: boolean;
    },
  ) {
    this.requireAdmin(req);
    const quem = req?.user?.email || req?.user?.name || 'admin';
    return this.classificacao.classificar({
      refs: body?.refs || [],
      categoria: body?.categoria ?? null,
      subcategoria: body?.subcategoria ?? null,
      manterCategoria: body?.manterCategoria === true,
      quem,
    });
  }

  /** Os mesmos filtros na lista e no "marcar todas" — divergir marcaria peça fora do filtro. */
  private filtroClassificacao(q: any): FiltroClassificacao {
    return {
      publicado: q.publicado === undefined ? undefined : this.booleanoAdmin(q.publicado),
      semSubcategoria: this.booleanoAdmin(q.semSubcategoria),
      semCategoria: this.booleanoAdmin(q.semCategoria),
      busca: q.busca || undefined,
      excluir: q.excluir || undefined,
      categoria: q.categoria || undefined,
      subcategoria: q.subcategoria || undefined,
    };
  }

  /** Cria uma subcategoria dentro de uma categoria — "Manga curta" em "Blusas". */
  @Post('classificacao/subcategoria')
  classCriarSub(@Req() req: any, @Body() body: { pai: string; nome: string }) {
    this.requireAdmin(req);
    const quem = req?.user?.email || req?.user?.name || 'admin';
    return this.classificacao.criarSubcategoria({
      pai: body?.pai || '',
      nome: body?.nome || '',
      quem,
    });
  }

  /** Cria uma categoria nova de nível de cima — "Linha Conforto". */
  @Post('classificacao/categoria')
  classCriarCategoria(@Req() req: any, @Body() body: { nome: string }) {
    this.requireAdmin(req);
    const quem = req?.user?.email || req?.user?.name || 'admin';
    return this.classificacao.criarCategoria({ nome: body?.nome || '', quem });
  }

  private booleanoAdmin(v: any): boolean | undefined {
    if (v === undefined || v === '') return undefined;
    return v === '1' || v === 'true' || v === true;
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
