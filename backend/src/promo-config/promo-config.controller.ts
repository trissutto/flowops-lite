import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { PromoConfigService } from './promo-config.service';
import { FiltroProdutosCampanha, PromoCampanhaService } from './promo-campanha.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import type { ConfigCampanha } from '../common/promo-por-termo';

/**
 * /admin/promo-config — a matriz liga, ajusta e confere a campanha por termo.
 * Só matriz (admin + operator). O "tirar da campanha" da LOJA mora no PDV
 * (`POST /pdv/promo-campanha/tirar`), com a loja carimbada.
 */
@Controller('admin/promo-config')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class PromoConfigController {
  constructor(
    private readonly svc: PromoConfigService,
    private readonly campanha: PromoCampanhaService,
  ) {}

  private usuario(req: any): string {
    return req?.user?.name || req?.user?.email || `user#${req?.user?.sub || '?'}`;
  }

  /** GET — config atual (a campanha). */
  @Get()
  async get() {
    return this.svc.getConfig();
  }

  /**
   * POST { campanha: { ativa, nome, pct, termos, termosExclusao, grupos, subgrupos } }
   * — grava e vale na hora.
   */
  @Post()
  async set(@Body() body: { campanha?: Partial<ConfigCampanha> }, @Req() req: any) {
    const r = await this.svc.setConfig(body, this.usuario(req));
    this.campanha.invalidar();
    return r;
  }

  /**
   * POST { campanha? } — o que entra (famílias com estoque na rede), com a
   * config gravada ou com o RASCUNHO da tela. Não grava nada.
   */
  @Post('preview')
  preview(@Body() body: { campanha?: Partial<ConfigCampanha> }) {
    return this.campanha.preview(body?.campanha ?? null);
  }

  /**
   * POST { filtro: { busca?, grupo?, subgrupo?, marca?, participacao?, pagina?, porPagina? }, campanha? }
   * — o catálogo com estoque, dentro E fora da campanha (a busca da tela, com
   * a seleção em massa). Com `campanha`, responde pelo rascunho. Não grava nada.
   */
  @Post('produtos')
  produtos(@Body() body: { filtro?: FiltroProdutosCampanha; campanha?: Partial<ConfigCampanha> }) {
    return this.campanha.produtos(body?.filtro ?? {}, body?.campanha ?? null);
  }

  /** GET — grupos, subgrupos e marcas que têm peça na rede (opções da tela). */
  @Get('estrutura')
  estrutura() {
    return this.campanha.estrutura();
  }

  @Get('excecoes')
  excecoes() {
    return this.campanha.listarExcecoes();
  }

  /**
   * POST { chaves: string[], decisao: 'fora'|'dentro'|'remover', motivo? } —
   * a seleção da busca de uma vez (até 500 famílias).
   */
  @Post('excecoes/lote')
  excecoesEmLote(
    @Body() body: { chaves?: string[]; decisao: 'fora' | 'dentro' | 'remover'; motivo?: string },
    @Req() req: any,
  ) {
    return this.campanha.excecoesEmLote({
      chaves: body?.chaves ?? [],
      decisao: body?.decisao,
      motivo: body?.motivo,
      usuario: this.usuario(req),
      storeCode: req?.user?.storeCode ?? null,
    });
  }

  /** POST { codigo? | ref?, decisao: 'fora'|'dentro', motivo? } */
  @Post('excecoes')
  gravarExcecao(
    @Body() body: { codigo?: string; ref?: string; decisao: 'fora' | 'dentro'; motivo?: string },
    @Req() req: any,
  ) {
    return this.campanha.gravarExcecao({
      codigo: body?.codigo,
      ref: body?.ref,
      decisao: body?.decisao,
      motivo: body?.motivo,
      origem: 'retaguarda',
      storeCode: req?.user?.storeCode ?? null,
      usuario: this.usuario(req),
    });
  }

  /**
   * POST { chave } — devolve a família à regra dos termos. POST e não DELETE
   * com a chave na URL: família sem REF é `#codigo`, e `#` na URL some.
   */
  @Post('excecoes/remover')
  removerExcecao(@Body() body: { chave: string }, @Req() req: any) {
    return this.campanha.removerExcecao(body?.chave, { usuario: this.usuario(req), origem: 'retaguarda' });
  }
}
