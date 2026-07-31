import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductNativeService } from './product-native.service';
import { ProductNativeController } from './product-native.controller';

/**
 * PRODUTO NATIVO — fase produtos da migração "sair da Giga".
 * P1: tabela `product` sincronizada do espelho (este módulo).
 * P2: leituras via flag PRODUCT_NATIVE_READS (product-search + wincred-catalog).
 * P3: escritas via flag PRODUCT_NATIVE_WRITES (products-editor grava aqui
 *     primeiro e replica pro Giga; flowIsSource protege da sobrescrita).
 */
@Module({
  imports: [PrismaModule],
  controllers: [ProductNativeController],
  providers: [ProductNativeService],
  exports: [ProductNativeService],
})
export class ProductNativeModule {}
