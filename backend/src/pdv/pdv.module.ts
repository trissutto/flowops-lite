import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { CrediarioNativoModule } from '../crediario-nativo/crediario-nativo.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { CrediariosModule } from '../crediarios/crediarios.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { PromoConfigModule } from '../promo-config/promo-config.module';
import { AccessPolicyModule } from '../access-policy/access-policy.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { ConveniosModule } from '../convenios/convenios.module';
import { AdiantamentosModule } from '../adiantamentos/adiantamentos.module';
// ⚠️ RoutingModule aqui é seguro: a cadeia dele (Stock/Websocket/Erp/Push)
// não importa PdvModule — conferido antes de adicionar (lição do ciclo 07/08).
import { RoutingModule } from '../routing/routing.module';
// EmailModule/HttpModule → PedidoEmailService com instância própria (mesma
// receita do PickOrdersModule): o aviso ao cliente do pedido online sai daqui
// sem importar o LojaOrdersModule inteiro e sem criar ciclo.
import { EmailModule } from '../email/email.module';
import { HttpModule } from '@nestjs/axios';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';
import { PedidoOnlineService } from './pedido-online.service';
import { PdvService } from './pdv.service';
import { ErpOutboxService } from './erp-outbox.service';
import { PdvController } from './pdv.controller';
import { PixService } from './pix.service';
import { CashService } from './cash.service';
import { CashController } from './cash.controller';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { ReturnsPublicController } from './returns-public.controller';
import { NfceService } from './nfce.service';
import { CrediarioPrintService } from './crediario-print.service';
import { CoordsDbService } from './coords-db.service';
import { PdvDiagController } from './pdv-diag.controller';
import { MarcadosService } from './marcados.service';
import { MarcadosMirrorService } from './marcados-mirror.service';
import { MarcadosController } from './marcados.controller';
import { ActiveSellersService } from './active-sellers.service';
import { ActiveSellersController } from './active-sellers.controller';
import { CarneCoordsService } from './carne-coords.service';
import { CarneCoordsController } from './carne-coords.controller';
import { FiscalReportService } from './fiscal-report.service';
import { FiscalReportController } from './fiscal-report.controller';
import { ProdutosVendidosService } from './produtos-vendidos.service';
import { ProdutosVendidosController } from './produtos-vendidos.controller';
import { PixPagbankReconcileService } from './pix-pagbank-reconcile.service';
import { CashbackModule } from '../cashback/cashback.module';
import { PdvStoreSummaryController } from './store-summary.controller';
import { PdvStoreSummaryService } from './store-summary.service';

@Module({
  imports: [CashbackModule, PrismaModule, ErpModule, PagarmeModule, forwardRef(() => CrediariosModule), WooCommerceModule, PromoConfigModule, AccessPolicyModule, WincredMirrorModule, AdiantamentosModule, ConveniosModule, CrediarioNativoModule, RoutingModule, EmailModule, HttpModule],
  controllers: [PdvController, CashController, ReturnsController, ReturnsPublicController, PdvDiagController, MarcadosController, ActiveSellersController, CarneCoordsController, FiscalReportController, ProdutosVendidosController, PdvStoreSummaryController],
  // ⚠️ `PixPagbankReconcileService` entra SÓ como provider — nenhum import de
  // módulo novo. Foi exatamente um import novo aqui (PagbankModule) que criou
  // o ciclo e impediu o backend de subir em 07/08. Ele lê a tabela do PagBank
  // pelo Prisma, que este módulo já tem.
  providers: [PdvService, PedidoOnlineService, PedidoEmailService, ErpOutboxService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService, CoordsDbService, MarcadosService, MarcadosMirrorService, ActiveSellersService, CarneCoordsService, FiscalReportService, ProdutosVendidosService, PixPagbankReconcileService, PdvStoreSummaryService],
  exports: [PdvService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService, CoordsDbService, MarcadosService, MarcadosMirrorService, ActiveSellersService, CarneCoordsService, FiscalReportService, ProdutosVendidosService],
})
export class PdvModule {}
