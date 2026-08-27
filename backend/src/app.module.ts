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
import { AvaliacoesModule } from './avaliacoes/avaliacoes.module';
import { RiscoModule } from './risco/risco.module';
import { PosVendaModule } from './pos-venda/pos-venda.module';
import { ContaResumoModule } from './conta-resumo/conta-resumo.module';
import { CatalogModule } from './catalog/catalog.module';
import { ProgressiveDiscountModule } from './progressive-discount/progressive-discount.module';
import { StockMirrorModule } from './stock-mirror/stock-mirror.module';
import { WincredMirrorModule } from './wincred-mirror/wincred-mirror.module';
import { ProductsModule } from './products/products.module';
import { ProductsEditorModule } from './products-editor/products-editor.module';
import { StockConferidorModule } from './stock-conferidor/stock-conferidor.module';
import { DemandasModule } from './demandas/demandas.module';
import { ConciliacaoModule } from './conciliacao/conciliacao.module';
import { ProductNativeModule } from './product-native/product-native.module';
import { StoresModule } from './stores/stores.module';
import { StockModule } from './stock/stock.module';
import { RoutingModule } from './routing/routing.module';
import { WooCommerceModule } from './woocommerce/woocommerce.module';
import { ErpModule } from './erp/erp.module';
import { ProductClassificationModule } from './product-classification/product-classification.module';
import { AtributosPecaModule } from './atributos-peca/atributos-peca.module';
import { DefeitosModule } from './defeitos/defeitos.module';
import { ProdutoFichaModule } from './produto-ficha/produto-ficha.module';
import { ContasPagarModule } from './contas-pagar/contas-pagar.module';
import { FornecedoresModule } from './fornecedores/fornecedores.module';
import { LimiteRedeModule } from './limite-rede/limite-rede.module';
import { CashbackModule } from './cashback/cashback.module';
import { FranquiasModule } from './franquias/franquias.module';
import { QueueModule } from './queue/queue.module';
import { WebsocketModule } from './websocket/websocket.module';
import { WpDbModule } from './wp-db/wp-db.module';
import { AbandonedCartsModule } from './abandoned-carts/abandoned-carts.module';
import { CarrinhosAbandonadosModule } from './carrinhos-abandonados/carrinhos-abandonados.module';
import { EtiquetaConfigModule } from './etiqueta-config/etiqueta-config.module';
import { EventLoopModule } from './health/event-loop.module';
import { HealthModule } from './health/health.module';
import { ReportsModule } from './reports/reports.module';
import { UsersModule } from './users/users.module';
import { PickOrdersModule } from './pick-orders/pick-orders.module';
import { NfeModule } from './nfe/nfe.module';
import { PecasExtraviadasModule } from './pecas-extraviadas/pecas-extraviadas.module';
import { DceModule } from './dce/dce.module';
import { ClientesGigaModule } from './clientes-giga/clientes-giga.module';
import { CrediarioNativoModule } from './crediario-nativo/crediario-nativo.module';
import { ConveniosModule } from './convenios/convenios.module';
import { MarketingRecoveryModule } from './marketing-recovery/marketing-recovery.module';
import { CrmModule } from './crm/crm.module';
import { SuppliesModule } from './supplies/supplies.module';
import { SitePublishModule } from './site-publish/site-publish.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { IntegrationLogsModule } from './integration-logs/integration-logs.module';
import { TrackingModule } from './tracking/tracking.module';
import { CorreiosModule } from './correios/correios.module';
import { MaisEnviosModule } from './mais-envios/mais-envios.module';
import { PilotModule } from './pilot/pilot.module';
import { SellersModule } from './sellers/sellers.module';
import { PontoModule } from './ponto/ponto.module';
import { RealignmentModule } from './realignment/realignment.module';
import { CrediariosModule } from './crediarios/crediarios.module';
import { CommissionsModule } from './commissions/commissions.module';
import { FitModule } from './fit/fit.module';
import { LojaCatalogModule } from './loja-catalog/loja-catalog.module';
import { SiteBannersModule } from './site-banners/site-banners.module';
import { SiteCategoriasModule } from './site-categorias/site-categorias.module';
import { SiteVitrinesModule } from './site-vitrines/site-vitrines.module';
import { SiteLeadsModule } from './site-leads/site-leads.module';
import { ChatModule } from './chat/chat.module';
import { LojaOrdersModule } from './loja-orders/loja-orders.module';
import { CutoverModule } from './cutover/cutover.module';
import { FinanceiroModule } from './financeiro/financeiro.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { PdvModule } from './pdv/pdv.module';
import { WcReturnsModule } from './wc-returns/wc-returns.module';
import { TrocasModule } from './trocas/trocas.module';
import { TelemetriaModule } from './telemetria/telemetria.module';
import { SiteMetricsModule } from './site-metrics/site-metrics.module';
import { EmailMarketingModule } from './email-marketing/email-marketing.module';
import { WhatsappCampaignModule } from './whatsapp-campaign/whatsapp-campaign.module';
import { OrderStatusModule } from './order-status/order-status.module';
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
import { DreModule } from './dre/dre.module';
import { LivePdvModule } from './live-pdv/live-pdv.module';
import { PromoConfigModule } from './promo-config/promo-config.module';
import { AccessPolicyModule } from './access-policy/access-policy.module';
import { OperadorPinModule } from './operador-pin/operador-pin.module';
import { SiteMediaModule } from './site-media/site-media.module';
import { SiteContentEditorModule } from './site-content-editor/site-content-editor.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Primeiro da fila de propósito: é o vigia que mede o congelamento do
    // backend, e ele precisa estar contando desde antes de qualquer módulo
    // pesado subir. Ver EventLoopService.
    EventLoopModule,
    CommonModule,
    PrismaModule,
    AuthModule,
    OrdersModule,
    CustomersModule,
    CustomersAppModule,
    SizeFeedbackModule,
    AvaliacoesModule,
    RiscoModule,
    PosVendaModule,
    ContaResumoModule,
    CatalogModule,
    ProgressiveDiscountModule,
    StockMirrorModule,
    WincredMirrorModule,
    ProductsModule,
    ProductsEditorModule,
    StockConferidorModule,
    DemandasModule,
    ConciliacaoModule,
    ProductNativeModule,
    StoresModule,
    StockModule,
    RoutingModule,
    WooCommerceModule,
    ErpModule,
    ProductClassificationModule,
    AtributosPecaModule,
    DefeitosModule,
    ProdutoFichaModule,
    ContasPagarModule,
    FornecedoresModule,
    LimiteRedeModule,
    CashbackModule,
    FranquiasModule,
    QueueModule,
    WebsocketModule,
    WpDbModule,
    AbandonedCartsModule,
    CarrinhosAbandonadosModule,
    EtiquetaConfigModule,
    HealthModule,
    UsersModule,
    PickOrdersModule,
    NfeModule,
    PecasExtraviadasModule,
    DceModule,
    ClientesGigaModule,
    CrediarioNativoModule,
    ConveniosModule,
    MarketingRecoveryModule,
    CrmModule,
    SuppliesModule,
    SitePublishModule,
    WhatsappModule,
    IntegrationLogsModule,
    TrackingModule,
    CorreiosModule,
    MaisEnviosModule,
    PilotModule,
    SellersModule,
    PontoModule,
    RealignmentModule,
    CrediariosModule,
    CommissionsModule,
    FitModule,
    LojaCatalogModule,
    SiteBannersModule,
    SiteCategoriasModule,
    SiteVitrinesModule,
    SiteLeadsModule,
    ChatModule,
    LojaOrdersModule,
    CutoverModule,
    FinanceiroModule,
    IntelligenceModule,
    PdvModule,
    WcReturnsModule,
    TrocasModule,
    OrderStatusModule,
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
    DreModule,
    LivePdvModule,
    PromoConfigModule,
    AccessPolicyModule,
    OperadorPinModule,
    SiteMediaModule,
    SiteContentEditorModule,
    ReportsModule,
    TelemetriaModule,
    SiteMetricsModule,
    EmailMarketingModule,
    WhatsappCampaignModule,
  ],
})
export class AppModule {}
