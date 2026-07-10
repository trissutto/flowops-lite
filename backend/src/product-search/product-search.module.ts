import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductSearchService } from './product-search.service';

/**
 * Busca única de produto (diretriz 10/07) — ver ProductSearchService.
 * Consumidores: live-pdv (grade da live) e product-classification (MODA/BÁSICO).
 * Novas telas com busca de produto DEVEM importar este módulo, não criar busca.
 */
@Module({
  imports: [PrismaModule],
  providers: [ProductSearchService],
  exports: [ProductSearchService],
})
export class ProductSearchModule {}
