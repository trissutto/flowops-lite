import {
  Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { FichaCorInput, FichaInput, ProdutoFichaService } from './produto-ficha.service';
import { FichaIaService } from './ficha-ia.service';

/**
 * Ficha do produto (tela master) e grades de medidas.
 *
 * REF sozinha nunca identifica: toda rota exige `marca`, porque REF numérica é
 * reciclada entre fornecedores.
 *
 * Rotas:
 *   GET   /produto-ficha/grades              — templates de medidas
 *   POST  /produto-ficha/grades              — cria template
 *   PATCH /produto-ficha/grades/:id          — edita template
 *   GET   /produto-ficha/ia/status           — quanto falta da extração por IA
 *   POST  /produto-ficha/ia/lote             — extrai a ficha da descrição
 *   GET   /produto-ficha/reposicao?ref&marca&cor — mínimo/ideal por tamanho
 *   PUT   /produto-ficha/reposicao?ref&marca&cor — grava a grade inteira
 *   GET   /produto-ficha/:ref?marca=X        — ficha completa (REF + cores + fotos)
 *   PATCH /produto-ficha/:ref?marca=X        — nível REF
 *   PATCH /produto-ficha/:ref/cor/:cor?marca=X — nível COR
 */
@Controller('produto-ficha')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class ProdutoFichaController {
  constructor(
    private readonly svc: ProdutoFichaService,
    private readonly ia: FichaIaService,
  ) {}

  private userLabel(req: any): string {
    return req?.user?.name || req?.user?.email || `user#${req?.user?.sub || '?'}`;
  }

  /**
   * GET /produto-ficha/fila — o que preencher primeiro (item 24).
   *
   * Também vem antes de `:ref`, senão "fila" seria lido como REF.
   */
  @Get('fila')
  fila(
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('limite') limite?: string,
    @Query('incluirCompletas') incluirCompletas?: string,
  ) {
    return this.svc.fila({
      de: de || undefined,
      ate: ate || undefined,
      limite: limite ? Number(limite) : undefined,
      incluirCompletas: incluirCompletas === '1' || incluirCompletas === 'true',
    });
  }

  /**
   * A DESCRIÇÃO VIRA FICHA — extração por IA, em lotes.
   *
   * Também antes de `:ref` (senão "ia" vira REF). É POST com gente clicando
   * porque cada peça é uma chamada paga; a tela repete enquanto sobrar
   * `restantes`.
   */
  @Get('ia/status')
  statusIa() {
    return this.ia.status();
  }

  @Post('ia/lote')
  loteIa(@Body() body: { limite?: number }) {
    return this.ia.processarLote(Number(body?.limite) || undefined);
  }

  // As rotas de grade vêm ANTES de `:ref` pra "grades" não ser lido como REF.
  @Get('grades')
  listGrades(@Query('incluirInativas') incluirInativas?: string) {
    return this.svc.listGrades(incluirInativas === '1' || incluirInativas === 'true');
  }

  @Post('grades')
  createGrade(@Body() body: { nome?: string; observacao?: string; linhas?: unknown }) {
    return this.svc.createGrade(body);
  }

  @Patch('grades/:id')
  updateGrade(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateGrade(id, body);
  }

  /**
   * MATRIZ DE REPOSIÇÃO de uma cor — o mínimo e o ideal por tamanho.
   *
   * Também antes de `:ref`, senão "reposicao" seria lido como REF.
   *
   * Só o que é DIGITADO passa por aqui. O TENHO e o VENDEU da matriz a tela
   * compõe das fontes que já existem (a própria grade de estoque que ela
   * desenha logo acima, e `/intelligence/vendas-produto/grade`) — dois
   * caminhos pro mesmo estoque acabam divergindo.
   */
  @Get('reposicao')
  getReposicao(
    @Query('ref') ref: string,
    @Query('marca') marca: string,
    @Query('cor') cor: string,
  ) {
    return this.svc.reposicao(ref, marca, cor);
  }

  @Put('reposicao')
  putReposicao(
    @Query('ref') ref: string,
    @Query('marca') marca: string,
    @Query('cor') cor: string,
    @Body() body: {
      tamanhos?: Array<{ tamanho?: string; minimoLoja?: number | null; idealLoja?: number | null }>;
    },
    @Req() req: any,
  ) {
    return this.svc.salvarReposicao(ref, marca, cor, body?.tamanhos ?? [], this.userLabel(req));
  }

  @Get(':ref')
  get(@Param('ref') ref: string, @Query('marca') marca: string) {
    return this.svc.get(ref, marca);
  }

  @Patch(':ref')
  upsert(
    @Param('ref') ref: string,
    @Query('marca') marca: string,
    @Body() body: FichaInput,
    @Req() req: any,
  ) {
    return this.svc.upsert(ref, marca, body, this.userLabel(req));
  }

  @Patch(':ref/cor/:cor')
  upsertCor(
    @Param('ref') ref: string,
    @Param('cor') cor: string,
    @Query('marca') marca: string,
    @Body() body: FichaCorInput,
    @Req() req: any,
  ) {
    return this.svc.upsertCor(ref, marca, cor, body, this.userLabel(req));
  }
}
