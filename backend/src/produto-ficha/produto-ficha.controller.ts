import {
  Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { FichaCorInput, FichaInput, ProdutoFichaService } from './produto-ficha.service';

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
 *   GET   /produto-ficha/:ref?marca=X        — ficha completa (REF + cores + fotos)
 *   PATCH /produto-ficha/:ref?marca=X        — nível REF
 *   PATCH /produto-ficha/:ref/cor/:cor?marca=X — nível COR
 */
@Controller('produto-ficha')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class ProdutoFichaController {
  constructor(private readonly svc: ProdutoFichaService) {}

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
