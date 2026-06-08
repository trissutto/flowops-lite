import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WooCommerceService } from './woocommerce.service';
import { WooCommerceController } from './woocommerce.controller';
import { WcPollerService } from './wc-poller.service';
import { OrdersModule } from '../orders/orders.module';
import { QueueModule } from '../queue/queue.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { PilotModule } from '../pilot/pilot.module';
import { CustomersAppModule } from '../customers-app/customers-app.module';

@Module({
  imports: [
    HttpModule,
    forwardRef(() => OrdersModule),
    QueueModule,
    WebsocketModule,
    forwardRef(() => PilotModule),
    CustomersAppModule,
  ],
  providers: [WooCommerceService, WcPollerService],
  controllers: [WooCommerceController],
  exports: [WooCommerceService],
})
export class WooCommerceModule {}
