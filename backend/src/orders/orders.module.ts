import { Module, forwardRef } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { StockModule } from '../stock/stock.module';
import { RoutingModule } from '../routing/routing.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { ErpModule } from '../erp/erp.module';
import { PickScanModule } from '../pick-orders/pick-scan.module';
import { PickOrdersModule } from '../pick-orders/pick-orders.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { PromoSiteModule } from '../promo-site/promo-site.module';
import { TrocaPecaService } from './troca-peca.service';
import { DespachoBackfillService } from './despacho-backfill.service';

@Module({
  // PickScanModule → estorno dos bipes no cancelamento/reembolso do pedido.
  // PickOrdersModule (forwardRef) → JuntadaService dos endpoints /juntar.
  // WincredMirrorModule → WincredCatalogService (troca manual de item lê a
  // peça nova pelo espelho, mesmo caminho do bipe do PDV).
  // PagarmeModule → link de pagamento da diferença da troca de peça.
  // PromoSiteModule → o preço que o SITE cobra hoje pela peça nova (precoPromo
  // digitado / promoção de 50%), pra sugerir a diferença certa.
  imports: [StockModule, RoutingModule, ErpModule, PickScanModule, WincredMirrorModule, PagarmeModule, PromoSiteModule, forwardRef(() => WooCommerceModule), forwardRef(() => PickOrdersModule)],
  // DespachoBackfillService → preenche `shipped_at` do que já estava
  // despachado quando a coluna nasceu (25/08). Roda uma vez e some.
  providers: [OrdersService, TrocaPecaService, DespachoBackfillService],
  controllers: [OrdersController],
  exports: [OrdersService, TrocaPecaService],
})
export class OrdersModule {}
