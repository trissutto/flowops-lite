import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AtributosPecaService } from './atributos-peca.service';
import { AtributosPecaController } from './atributos-peca.controller';

/**
 * Classificação da peça — Ocasião, Tecido, Modelagem e Coleção.
 *
 * São os eixos que o site usa pra montar vitrine além da categoria. Cadastrados
 * na retaguarda e escolhidos JÁ NO PEDIDO DE COMPRA, por isso o service é
 * exportado: o PurchaseOrdersModule usa `resolveRefs` pra validar os ids antes
 * de gravar.
 */
@Module({
  imports: [PrismaModule],
  providers: [AtributosPecaService],
  controllers: [AtributosPecaController],
  exports: [AtributosPecaService],
})
export class AtributosPecaModule {}
