import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import {
  PreviewInput,
  ProcessarInput,
  ProductRegistrationService,
} from './product-registration.service';

/**
 * Endpoints REST do Cadastro Dinâmico de Produtos.
 * Base: /api/product-registration
 */
@Controller('product-registration')
export class ProductRegistrationController {
  constructor(private readonly svc: ProductRegistrationService) {}

  /** Lista grupos, cores, tamanhos e fornecedores pra popular os modais. */
  @Get('catalogo')
  catalogo() {
    return this.svc.catalogo();
  }

  /** Lista subgrupos de um grupo específico (carrega depois que o user escolhe grupo). */
  @Get('subgrupos/:grupoCodigo')
  subgrupos(@Param('grupoCodigo', ParseIntPipe) grupoCodigo: number) {
    return this.svc.subgruposDoGrupo(grupoCodigo);
  }

  /** Cria um grupo novo no Wincred (tabela grupos). */
  @Post('grupo')
  criarGrupo(@Body() body: { nome: string }) {
    return this.svc.criarGrupo(body.nome);
  }

  /** Cria um subgrupo novo no Wincred (tabela subgrupos), associado a um grupo. */
  @Post('subgrupo')
  criarSubgrupo(@Body() body: { grupoCodigo: number; nome: string }) {
    return this.svc.criarSubgrupo(body.grupoCodigo, body.nome);
  }

  /** Gera preview da matriz cor×tamanho com EANs (não grava). */
  @Post('preview')
  preview(@Body() body: PreviewInput) {
    return this.svc.preview(body);
  }

  /** Grava todos os produtos no Wincred (transação MySQL). */
  @Post('processar')
  processar(@Body() body: ProcessarInput) {
    return this.svc.processar(body);
  }
}
