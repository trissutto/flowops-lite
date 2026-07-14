import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { ProductSearchModule } from '../product-search/product-search.module';
import { ProductsEditorService } from './products-editor.service';
import { ProductsEditorController } from './products-editor.controller';

/**
 * EDITOR DE PRODUTOS — padronizar REF / preço em bloco / descrição em bloco.
 * Grava no GIGA (fonte da verdade) e reflete nos espelhos. Ver service.
 */
@Module({
  imports: [PrismaModule, ErpModule, ProductSearchModule],
  controllers: [ProductsEditorController],
  providers: [ProductsEditorService],
})
export class ProductsEditorModule {}
