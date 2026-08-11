import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { CustomersCrmService } from './customers-crm.service';
import { CustomersCrmController } from './customers-crm.controller';
import { CustomersEtlService } from './customers-etl.service';
import { CustomersGigaEtlService } from './customers-giga-etl.service';
import { CpfWooService } from './cpf-woo.service';
import { WpDbModule } from '../wp-db/wp-db.module';
import { CashbackConfigService } from './cashback-config.service';
import { CashbackConfigController } from './cashback-config.controller';
import { CustomerResumeController } from './customer-resume.controller';
import { OrdersModule } from '../orders/orders.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { AuthModule } from '../auth/auth.module';
import { ErpModule } from '../erp/erp.module';
import { PersonIdentityModule } from '../person-identity/person-identity.module';
import { CustomerIdentityReviewService } from './customer-identity-review.service';

@Module({
  imports: [OrdersModule, WooCommerceModule, AuthModule, ErpModule, WpDbModule, PersonIdentityModule],
  providers: [CustomersService, CustomersCrmService, CustomerIdentityReviewService, CustomersEtlService, CustomersGigaEtlService, CashbackConfigService, CpfWooService],
  controllers: [CustomersController, CustomersCrmController, CashbackConfigController, CustomerResumeController],
  exports: [CustomersService, CustomersCrmService, CustomersEtlService, CustomersGigaEtlService, CashbackConfigService],
})
export class CustomersModule {}
