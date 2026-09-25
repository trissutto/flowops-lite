import { Module } from '@nestjs/common';
import { PecasExtraviadasModule } from '../pecas-extraviadas/pecas-extraviadas.module';
import { RoutingEngine } from './routing.engine';
import { RoutingService } from './routing.service';
import { AwaitingStockRetryCron } from './awaiting-stock-retry.cron';
import { VigilanciaSeparacaoCron } from './vigilancia-separacao.cron';
import { SalesStatsService } from './sales-stats.service';
import { StockModule } from '../stock/stock.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { ErpModule } from '../erp/erp.module';
import { PushModule } from '../push/push.module';
import { PickScanModule } from '../pick-orders/pick-scan.module';
// SEPARAÇÃO AUTOMÁTICA (25/09): o pedido pago do site roteia sozinho e avisa
// a loja pelo WhatsApp — por isso o WhatsappModule entra aqui.
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { SeparacaoAutomaticaService } from './separacao-automatica.service';

@Module({
  // PickScanModule → estorno dos bipes quando o recalcular/trocar-loja apaga
  // um card. Só depende de Prisma+Erp, então não fecha ciclo com pick-orders.
  imports: [
    PecasExtraviadasModule,StockModule, WebsocketModule, ErpModule, PushModule, PickScanModule, WhatsappModule],
  providers: [RoutingEngine, RoutingService, SalesStatsService, AwaitingStockRetryCron, VigilanciaSeparacaoCron, SeparacaoAutomaticaService],
  exports: [RoutingEngine, RoutingService, SalesStatsService, VigilanciaSeparacaoCron, SeparacaoAutomaticaService],
})
export class RoutingModule {}
