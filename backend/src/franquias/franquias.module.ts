import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductSearchModule } from '../product-search/product-search.module';
import { FranquiasController } from './franquias.controller';
import { FranquiasService } from './franquias.service';

/** Portal de Franquias — números (faturamento/estoque) das lojas FILIAL. */
@Module({
  imports: [PrismaModule, ProductSearchModule],
  controllers: [FranquiasController],
  providers: [FranquiasService],
})
export class FranquiasModule {}
