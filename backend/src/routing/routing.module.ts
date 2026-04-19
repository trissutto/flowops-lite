import { Module } from '@nestjs/common';
import { RoutingEngine } from './routing.engine';
import { RoutingService } from './routing.service';
import { StockModule } from '../stock/stock.module';

@Module({
  imports: [StockModule],
  providers: [RoutingEngine, RoutingService],
  exports: [RoutingEngine, RoutingService],
})
export class RoutingModule {}
