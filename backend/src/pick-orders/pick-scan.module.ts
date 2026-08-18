import { Module } from '@nestjs/common';
import { PickScanService } from './pick-scan.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';

/**
 * Módulo próprio (e minúsculo) DE PROPÓSITO: o estorno dos bipes precisa ser
 * chamado por pick-orders, routing (recalcular/trocar loja) e orders (pedido
 * cancelado). Se morasse dentro do PickOrdersModule, routing e orders teriam
 * que importar o módulo inteiro — e o PickOrdersModule já depende de
 * WooCommerce/Live/Correios/NF-e, o que fecharia ciclo. Aqui as dependências
 * são só Prisma + Erp.
 */
@Module({
  imports: [PrismaModule, ErpModule],
  providers: [PickScanService],
  exports: [PickScanService],
})
export class PickScanModule {}
