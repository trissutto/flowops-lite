import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AdminOnly, AdminOnlyGuard } from '../auth/admin-only.guard';
import { AtributoInput, AtributosPecaService } from './atributos-peca.service';

/**
 * Cadastros → Ocasiões / Tecidos / Modelagens / Coleções.
 *
 * Quatro telas, uma tabela. Só matriz (admin + operator), igual à tela de
 * Classificação de Produtos.
 *
 * Rotas:
 *   GET    /atributos-peca            — todos os tipos de uma vez (pedido de compra)
 *   GET    /atributos-peca/:tipo      — lista de um tipo (tela de cadastro)
 *   POST   /atributos-peca/:tipo      — cria
 *   PATCH  /atributos-peca/item/:id   — edita
 *   DELETE /atributos-peca/item/:id   — desativa (não apaga)
 */
@Controller('atributos-peca')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@AdminOnly()
export class AtributosPecaController {
  constructor(private readonly svc: AtributosPecaService) {}

  private incluirInativos(q: any): boolean {
    return String(q?.incluirInativos) === '1' || String(q?.incluirInativos) === 'true';
  }

  @Get()
  listAll(@Query() q: any) {
    return this.svc.listAll(this.incluirInativos(q));
  }

  @Get(':tipo')
  list(@Param('tipo') tipo: string, @Query() q: any) {
    return this.svc.list(tipo, this.incluirInativos(q));
  }

  @Post(':tipo')
  create(@Param('tipo') tipo: string, @Body() body: AtributoInput) {
    return this.svc.create(tipo, body);
  }

  // `item/:id` em vez de `:id` pra não colidir com `:tipo` acima.
  @Patch('item/:id')
  update(@Param('id') id: string, @Body() body: AtributoInput) {
    return this.svc.update(id, body);
  }

  @Delete('item/:id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
