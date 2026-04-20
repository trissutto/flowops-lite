import { Module } from '@nestjs/common';
import { RoutingEngine } from './routing.engine';
import { RoutingService } from './routing.service';
import { StockModule } from '../stock/stock.module';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [StockModule, WebsocketModule],
  providers: [RoutingEngine, RoutingService],
  exports: [RoutingEngine, RoutingService],
})
export class RoutingModule {}
