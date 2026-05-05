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

  /** Reserva próximo código de grupo (usado quando user clica "criar grupo novo"). */
  @Post('reservar-grupo')
  reservarGrupo() {
    return this.svc.reservarGrupo();
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
