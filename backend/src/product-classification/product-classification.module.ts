import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { ProductSearchModule } from '../product-search/product-search.module';
import { ProductClassificationService } from './product-classification.service';
import { ProductClassificationController } from './product-classification.controller';

/**
 * Classificação de Produtos (Cadastros) — BÁSICO/MODA por referência.
 * Lê o catálogo do ERP (ErpService) e guarda a classificação no Postgres
 * (product_classification). Busca de produto = ProductSearchService (a MESMA
 * lógica da live — diretriz 10/07). Não altera nada existente.
 */
@Module({
  imports: [PrismaModule, ErpModule, ProductSearchModule],
  providers: [ProductClassificationService],
  controllers: [ProductClassificationController],
})
export class ProductClassificationModule {}
