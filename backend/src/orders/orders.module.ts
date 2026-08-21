import { Module, forwardRef } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { StockModule } from '../stock/stock.module';
import { RoutingModule } from '../routing/routing.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { ErpModule } from '../erp/erp.module';
import { PickScanModule } from '../pick-orders/pick-scan.module';
import { PickOrdersModule } from '../pick-orders/pick-orders.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';

@Module({
  // PickScanModule → estorno dos bipes no cancelamento/reembolso do pedido.
  // PickOrdersModule (forwardRef) → JuntadaService dos endpoints /juntar.
  // WincredMirrorModule → WincredCatalogService (troca manual de item lê a
  // peça nova pelo espelho, mesmo caminho do bipe do PDV).
  imports: [StockModule, RoutingModule, ErpModule, PickScanModule, WincredMirrorModule, forwardRef(() => WooCommerceModule), forwardRef(() => PickOrdersModule)],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
