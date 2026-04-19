import { Module, forwardRef } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { StockModule } from '../stock/stock.module';
import { RoutingModule } from '../routing/routing.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';

@Module({
  imports: [StockModule, RoutingModule, forwardRef(() => WooCommerceModule)],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
