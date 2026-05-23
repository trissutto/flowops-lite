import { Module } from '@nestjs/common';
import { RoutingEngine } from './routing.engine';
import { RoutingService } from './routing.service';
import { SalesStatsService } from './sales-stats.service';
import { StockModule } from '../stock/stock.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { ErpModule } from '../erp/erp.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [StockModule, WebsocketModule, ErpModule, PushModule],
  providers: [RoutingEngine, RoutingService, SalesStatsService],
  exports: [RoutingEngine, RoutingService, SalesStatsService],
})
export class RoutingModule {}
