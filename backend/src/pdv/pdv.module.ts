import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { CrediarioNativoModule } from '../crediario-nativo/crediario-nativo.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { CrediariosModule } from '../crediarios/crediarios.module';
import { PromoConfigModule } from '../promo-config/promo-config.module';
import { AccessPolicyModule } from '../access-policy/access-policy.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { ConveniosModule } from '../convenios/convenios.module';
import { AdiantamentosModule } from '../adiantamentos/adiantamentos.module';
// ⚠️ RoutingModule aqui é seguro: a cadeia dele (Stock/Websocket/Erp/Push)
// não importa PdvModule — conferido antes de adicionar (lição do ciclo 07/08).
import { RoutingModule } from '../routing/routing.module';
// StockModule (25/09): o semáforo de lastro da venda a distância lê o estoque
// pela MESMA vista do routing (`wincred_estoque` via StockService) — lia
// `giga_estoque` cru e dava vermelho pra peça que a Consulta mostrava com 12
// na rede. A cadeia dele (Erp/Prisma/WincredMirror) já está toda aqui.
import { StockModule } from '../stock/stock.module';
// EmailModule/HttpModule → PedidoEmailService com instância própria (mesma
// receita do PickOrdersModule): o aviso ao cliente do pedido online sai daqui
// sem importar o LojaOrdersModule inteiro e sem criar ciclo.
import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { HttpModule } from '@nestjs/axios';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';
import { PedidoOnlineService } from './pedido-online.service';
import { LastroRedeService } from './lastro-rede.service';
import { PdvService } from './pdv.service';
import { ErpOutboxService } from './erp-outbox.service';
import { ConferenciaVendasService } from './conferencia-vendas.service';
import { ConferenciaExtratoService } from './conferencia-extrato.service';
import { PdvController } from './pdv.controller';
import { FotoProdutoService } from './foto-produto.service';
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
import { PagarmeLinkReconcileService } from './pagarme-link-reconcile.service';
import { CashbackModule } from '../cashback/cashback.module';
import { PdvStoreSummaryController } from './store-summary.controller';
import { PdvStoreSummaryService } from './store-summary.service';
import { CobrancasOnlineService } from './cobrancas-online.service';
// Gamificação (29/08): FaturamentoModule é seguro aqui — a cadeia dele é só
// Prisma + Erp, nenhum caminho de volta pro PdvModule (lição do ciclo 07/08).
import { FaturamentoModule } from '../faturamento/faturamento.module';
import { MetasService } from './metas.service';
import { MetasController } from './metas.controller';

/**
 * ⚠️ O `WooCommerceModule` SAIU DAS IMPORTS EM 14/09/2026.
 *
 * O PDV injetava o `WooCommerceService` por UM motivo só: a miniatura do
 * carrinho (`GET /pdv/product-image` e `/product-images`) pedia a foto por SKU
 * pro WordPress. Ele foi apagado em 27/08/2026 e `WC_URL` hoje é o site novo,
 * que responde 403 — e o método engolia o erro e cacheava "sem foto" por 1h,
 * então a falha nunca apareceu em tela nenhuma.
 *
 * A foto agora vem de `product_photos` (Postgres + R2) pelo
 * `FotoProdutoService` — a MESMA fonte da Consulta, da Separação e do site.
 * Nenhum outro provider deste módulo falava com o WooCommerce (conferido por
 * varredura antes de remover o import), então a frente de caixa deixou de ter
 * qualquer caminho até o host morto.
 */
@Module({
  imports: [CashbackModule, PrismaModule, ErpModule, PagarmeModule, forwardRef(() => CrediariosModule), PromoConfigModule, AccessPolicyModule, WincredMirrorModule, AdiantamentosModule, ConveniosModule, CrediarioNativoModule, RoutingModule, EmailModule, HttpModule, WhatsappModule, FaturamentoModule, StockModule],
  controllers: [PdvController, CashController, ReturnsController, ReturnsPublicController, PdvDiagController, MarcadosController, ActiveSellersController, CarneCoordsController, FiscalReportController, ProdutosVendidosController, PdvStoreSummaryController, MetasController],
  // ⚠️ `PixPagbankReconcileService` entra SÓ como provider — nenhum import de
  // módulo novo. Foi exatamente um import novo aqui (PagbankModule) que criou
  // o ciclo e impediu o backend de subir em 07/08. Ele lê a tabela do PagBank
  // pelo Prisma, que este módulo já tem.
  //
  // `PagarmeLinkReconcileService` (17/08) segue a MESMA regra e pelo mesmo
  // motivo: fecha a venda quando o link Pagar.me é pago (antes ninguém
  // fechava — venda ficava aberta pra sempre com o dinheiro na conta) e lê
  // `pagarme_payment` pelo Prisma, sem importar o PagarmeModule.
  providers: [PdvService, FotoProdutoService, PedidoOnlineService, LastroRedeService, PedidoEmailService, ErpOutboxService, ConferenciaVendasService, ConferenciaExtratoService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService, CoordsDbService, MarcadosService, MarcadosMirrorService, ActiveSellersService, CarneCoordsService, FiscalReportService, ProdutosVendidosService, PixPagbankReconcileService, PagarmeLinkReconcileService, PdvStoreSummaryService, CobrancasOnlineService, MetasService],
  exports: [PdvService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService, CoordsDbService, MarcadosService, MarcadosMirrorService, ActiveSellersService, CarneCoordsService, FiscalReportService, ProdutosVendidosService],
})
export class PdvModule {}
