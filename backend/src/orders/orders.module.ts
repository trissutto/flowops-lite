import { Module, forwardRef } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { StockModule } from '../stock/stock.module';
import { RoutingModule } from '../routing/routing.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { ErpModule } from '../erp/erp.module';
import { PickScanModule } from '../pick-orders/pick-scan.module';

@Module({
  // PickScanModule → estorno dos bipes no cancelamento/reembolso do pedido.
  imports: [StockModule, RoutingModule, ErpModule, PickScanModule, forwardRef(() => WooCommerceModule)],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
