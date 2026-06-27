import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { ProductClassificationService } from './product-classification.service';
import { ProductClassificationController } from './product-classification.controller';

/**
 * Classificação de Produtos (Cadastros) — BÁSICO/MODA por referência.
 * Lê o catálogo do ERP (ErpService) e guarda a classificação no Postgres
 * (product_classification). Não altera nada existente.
 */
@Module({
  imports: [PrismaModule, ErpModule],
  providers: [ProductClassificationService],
  controllers: [ProductClassificationController],
})
export class ProductClassificationModule {}
