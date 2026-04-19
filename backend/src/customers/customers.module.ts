import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { OrdersModule } from '../orders/orders.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';

@Module({
  imports: [OrdersModule, WooCommerceModule],
  providers: [CustomersService],
  controllers: [CustomersController],
  exports: [CustomersService],
})
export class CustomersModule {}
