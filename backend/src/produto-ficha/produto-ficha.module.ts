import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AtributosPecaModule } from '../atributos-peca/atributos-peca.module';
import { ProdutoFichaService } from './produto-ficha.service';
import { ProdutoFichaController } from './produto-ficha.controller';

/**
 * Ficha do produto — a camada de enriquecimento que a tela master edita.
 * Depende do AtributosPecaModule pra resolver tecido/coleção/ocasião/modelagem
 * pelo cadastro em vez de confiar no texto que vem do navegador.
 */
@Module({
  imports: [PrismaModule, AtributosPecaModule],
  providers: [ProdutoFichaService],
  controllers: [ProdutoFichaController],
  exports: [ProdutoFichaService],
})
export class ProdutoFichaModule {}
