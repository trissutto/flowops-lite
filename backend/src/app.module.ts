import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { CommonModule } from './common/common.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { CustomersModule } from './customers/customers.module';
import { ProductsModule } from './products/products.module';
import { StoresModule } from './stores/stores.module';
import { StockModule } from './stock/stock.module';
import { RoutingModule } from './routing/routing.module';
import { WooCommerceModule } from './woocommerce/woocommerce.module';
import { ErpModule } from './erp/erp.module';
import { QueueModule } from './queue/queue.module';
import { WebsocketModule } from './websocket/websocket.module';
import { WpDbModule } from './wp-db/wp-db.module';
import { AbandonedCartsModule } from './abandoned-carts/abandoned-carts.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { PickOrdersModule } from './pick-orders/pick-orders.module';
import { MarketingRecoveryModule } from './marketing-recovery/marketing-recovery.module';
import { CrmModule } from './crm/crm.module';
import { SuppliesModule } from './supplies/supplies.module';
import { SitePublishModule } from './site-publish/site-publish.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { IntegrationLogsModule } from './integration-logs/integration-logs.module';
import { TrackingModule } from './tracking/tracking.module';
import { PilotModule } from './pilot/pilot.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    PrismaModule,
    AuthModule,
    OrdersModule,
    CustomersModule,
    ProductsModule,
    StoresModule,
    StockModule,
    RoutingModule,
    WooCommerceModule,
    ErpModule,
    QueueModule,
    WebsocketModule,
    WpDbModule,
    AbandonedCartsModule,
    HealthModule,
    UsersModule,
    PickOrdersModule,
    MarketingRecoveryModule,
    CrmModule,
    SuppliesModule,
    SitePublishModule,
    WhatsappModule,
    IntegrationLogsModule,
    TrackingModule,
    PilotModule,
  ],
})
export class AppModule {}
