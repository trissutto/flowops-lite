import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { CustomersCrmService } from './customers-crm.service';
import { CustomersCrmController } from './customers-crm.controller';
import { CustomersEtlService } from './customers-etl.service';
import { CustomerResumeController } from './customer-resume.controller';
import { OrdersModule } from '../orders/orders.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { AuthModule } from '../auth/auth.module';
import { PersonIdentityModule } from '../person-identity/person-identity.module';
import { CustomerIdentityReviewService } from './customer-identity-review.service';
// A ficha do PDV lê o saldo do ledger único (chave = CPF) desde 22/09.
import { CashbackModule } from '../cashback/cashback.module';

/**
 * CustomersGigaEtlService foi DELETADO no enterro do Wincred (09/2026): as 7
 * rotas `/customers-crm/etl/giga*` abriam com `if (!pool) throw` sobre um pool
 * MySQL que `ErpService.onModuleInit` não cria mais. Com ele, o `ErpModule`
 * saiu daqui — nenhum provider deste módulo injeta ErpService/SombraService.
 */
@Module({
  imports: [OrdersModule, WooCommerceModule, AuthModule, PersonIdentityModule, CashbackModule],
  providers: [CustomersService, CustomersCrmService, CustomerIdentityReviewService, CustomersEtlService],
  controllers: [CustomersController, CustomersCrmController, CustomerResumeController],
  exports: [CustomersService, CustomersCrmService, CustomersEtlService],
})
export class CustomersModule {}
