import { Module } from '@nestjs/common';
import { PecasExtraviadasModule } from '../pecas-extraviadas/pecas-extraviadas.module';
import { RoutingEngine } from './routing.engine';
import { RoutingService } from './routing.service';
import { SalesStatsService } from './sales-stats.service';
import { StockModule } from '../stock/stock.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { ErpModule } from '../erp/erp.module';
import { PushModule } from '../push/push.module';
import { PickScanModule } from '../pick-orders/pick-scan.module';

@Module({
  // PickScanModule → estorno dos bipes quando o recalcular/trocar-loja apaga
  // um card. Só depende de Prisma+Erp, então não fecha ciclo com pick-orders.
  imports: [
    PecasExtraviadasModule,StockModule, WebsocketModule, ErpModule, PushModule, PickScanModule],
  providers: [RoutingEngine, RoutingService, SalesStatsService],
  exports: [RoutingEngine, RoutingService, SalesStatsService],
})
export class RoutingModule {}
