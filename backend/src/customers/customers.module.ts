import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { CustomersCrmService } from './customers-crm.service';
import { CustomersCrmController } from './customers-crm.controller';
import { CustomersEtlService } from './customers-etl.service';
import { CashbackConfigService } from './cashback-config.service';
import { CashbackConfigController } from './cashback-config.controller';
import { CustomerResumeController } from './customer-resume.controller';
import { OrdersModule } from '../orders/orders.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { AuthModule } from '../auth/auth.module';
import { PersonIdentityModule } from '../person-identity/person-identity.module';
import { CustomerIdentityReviewService } from './customer-identity-review.service';

/**
 * CustomersGigaEtlService foi DELETADO no enterro do Wincred (09/2026): as 7
 * rotas `/customers-crm/etl/giga*` abriam com `if (!pool) throw` sobre um pool
 * MySQL que `ErpService.onModuleInit` não cria mais. Com ele, o `ErpModule`
 * saiu daqui — nenhum provider deste módulo injeta ErpService/SombraService.
 */
@Module({
  imports: [OrdersModule, WooCommerceModule, AuthModule, PersonIdentityModule],
  providers: [CustomersService, CustomersCrmService, CustomerIdentityReviewService, CustomersEtlService, CashbackConfigService],
  controllers: [CustomersController, CustomersCrmController, CashbackConfigController, CustomerResumeController],
  exports: [CustomersService, CustomersCrmService, CustomersEtlService, CashbackConfigService],
})
export class CustomersModule {}
