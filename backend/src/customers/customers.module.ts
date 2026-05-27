import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { CustomersCrmService } from './customers-crm.service';
import { CustomersCrmController } from './customers-crm.controller';
import { CustomersEtlService } from './customers-etl.service';
import { OrdersModule } from '../orders/orders.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [OrdersModule, WooCommerceModule, AuthModule],
  providers: [CustomersService, CustomersCrmService, CustomersEtlService],
  controllers: [CustomersController, CustomersCrmController],
  exports: [CustomersService, CustomersCrmService, CustomersEtlService],
})
export class CustomersModule {}
