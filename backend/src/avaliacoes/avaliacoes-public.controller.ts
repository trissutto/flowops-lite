import { Controller, Get, Param, Query } from '@nestjs/common';
import { AvaliacoesService } from './avaliacoes.service';

/**
 * O que a PDP mostra — sem login, como o resto do catálogo público.
 *
 * Só sai avaliação com status `publicada`, nome abreviado e medida da cliente
 * apenas quando ela autorizou. Ver `AvaliacoesService.doProduto`.
 */
@Controller('public/loja/avaliacoes')
export class AvaliacoesPublicController {
  constructor(private readonly svc: AvaliacoesService) {}

  /** GET /public/loja/avaliacoes/:chave — `chave` é o slug OU a REF da peça. */
  @Get(':chave')
  async doProduto(@Param('chave') chave: string, @Query('limite') limite?: string) {
    return this.svc.doProduto(chave, Number(limite) || 20);
  }
}
