import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { CommonModule } from './common/common.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { OrdersModule } from './orders/orders.module';
import { CustomersModule } from './customers/customers.module';
import { CustomersAppModule } from './customers-app/customers-app.module';
import { SizeFeedbackModule } from './size-feedback/size-feedback.module';
import { CatalogModule } from './catalog/catalog.module';
import { ProgressiveDiscountModule } from './progressive-discount/progressive-discount.module';
import { StockMirrorModule } from './stock-mirror/stock-mirror.module';
import { WincredMirrorModule } from './wincred-mirror/wincred-mirror.module';
import { ProductsModule } from './products/products.module';
import { ProductsEditorModule } from './products-editor/products-editor.module';
import { ProductNativeModule } from './product-native/product-native.module';
import { StoresModule } from './stores/stores.module';
import { StockModule } from './stock/stock.module';
import { RoutingModule } from './routing/routing.module';
import { WooCommerceModule } from './woocommerce/woocommerce.module';
import { ErpModule } from './erp/erp.module';
import { ProductClassificationModule } from './product-classification/product-classification.module';
import { ContasPagarModule } from './contas-pagar/contas-pagar.module';
import { QueueModule } from './queue/queue.module';
import { WebsocketModule } from './websocket/websocket.module';
import { WpDbModule } from './wp-db/wp-db.module';
import { AbandonedCartsModule } from './abandoned-carts/abandoned-carts.module';
import { CarrinhosAbandonadosModule } from './carrinhos-abandonados/carrinhos-abandonados.module';
import { EtiquetaConfigModule } from './etiqueta-config/etiqueta-config.module';
import { HealthModule } from './health/health.module';
import { ReportsModule } from './reports/reports.module';
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
import { SellersModule } from './sellers/sellers.module';
import { PontoModule } from './ponto/ponto.module';
import { RealignmentModule } from './realignment/realignment.module';
import { CrediariosModule } from './crediarios/crediarios.module';
import { CommissionsModule } from './commissions/commissions.module';
import { CutoverModule } from './cutover/cutover.module';
import { FinanceiroModule } from './financeiro/financeiro.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { PdvModule } from './pdv/pdv.module';
import { WcReturnsModule } from './wc-returns/wc-returns.module';
import { PagbankModule } from './pagbank/pagbank.module';
import { PagarmeModule } from './pagarme/pagarme.module';
import { ProductRegistrationModule } from './product-registration/product-registration.module';
import { StoneModule } from './stone/stone.module';
import { LiveModule } from './live/live.module';
import { DesktopModule } from './desktop/desktop.module';
import { PropertiesModule } from './properties/properties.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { ProductPhotosModule } from './product-photos/product-photos.module';
import { PushModule } from './push/push.module';
import { FaturamentoModule } from './faturamento/faturamento.module';
import { LivePdvModule } from './live-pdv/live-pdv.module';
import { PromoConfigModule } from './promo-config/promo-config.module';
import { AccessPolicyModule } from './access-policy/access-policy.module';
import { OperadorPinModule } from './operador-pin/operador-pin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    PrismaModule,
    AuthModule,
    OrdersModule,
    CustomersModule,
    CustomersAppModule,
    SizeFeedbackModule,
    CatalogModule,
    ProgressiveDiscountModule,
    StockMirrorModule,
    WincredMirrorModule,
    ProductsModule,
    ProductsEditorModule,
    ProductNativeModule,
    StoresModule,
    StockModule,
    RoutingModule,
    WooCommerceModule,
    ErpModule,
    ProductClassificationModule,
    ContasPagarModule,
    QueueModule,
    WebsocketModule,
    WpDbModule,
    AbandonedCartsModule,
    CarrinhosAbandonadosModule,
    EtiquetaConfigModule,
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
    SellersModule,
    PontoModule,
    RealignmentModule,
    CrediariosModule,
    CommissionsModule,
    CutoverModule,
    FinanceiroModule,
    IntelligenceModule,
    PdvModule,
    WcReturnsModule,
    PagbankModule,
    PagarmeModule,
    ProductRegistrationModule,
    StoneModule,
    LiveModule,
    DesktopModule,
    PropertiesModule,
    PurchaseOrdersModule,
    ProductPhotosModule,
    PushModule,
    FaturamentoModule,
    LivePdvModule,
    PromoConfigModule,
    AccessPolicyModule,
    OperadorPinModule,
    ReportsModule,
  ],
})
export class AppModule {}
