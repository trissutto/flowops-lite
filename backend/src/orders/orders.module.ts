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
import { PagbankModule } from '../pagbank/pagbank.module';
import { PromoConfigModule } from '../promo-config/promo-config.module';
import { MaisEnviosModule } from '../mais-envios/mais-envios.module';
import { TrocaPecaService } from './troca-peca.service';
import { DespachoBackfillService } from './despacho-backfill.service';
import { LinhaDoTempoService } from './linha-do-tempo.service';
import { HttpModule } from '@nestjs/axios';
import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';

@Module({
  // PickScanModule → estorno dos bipes no cancelamento/reembolso do pedido.
  // PickOrdersModule (forwardRef) → JuntadaService dos endpoints /juntar.
  // WincredMirrorModule → WincredCatalogService (troca manual de item lê a
  // peça nova pelo espelho, mesmo caminho do bipe do PDV).
  // PagbankModule (forwardRef) → link de pagamento da diferença da troca de
  // peça (22/09 — era Pagar.me, que desligou o checkout). forwardRef porque o
  // PagbankModule mora no laço Crediarios ↔ Pagarme ↔ LojaOrders.
  // PromoConfigModule → o preço que o SITE cobra hoje pela peça nova (preço da
  // loja, com a campanha do caixa quando a peça entra), pra sugerir a diferença certa.
  // EmailModule/HttpModule/WhatsappModule → PedidoEmailService com instância
  // própria (mesma receita do PickOrdersModule): o aviso de CANCELAMENTO pra
  // cliente sai do cancelarLocalmente sem importar o LojaOrdersModule inteiro.
  imports: [StockModule, RoutingModule, ErpModule, PickScanModule, WincredMirrorModule, forwardRef(() => PagbankModule), PromoConfigModule, MaisEnviosModule, EmailModule, HttpModule, WhatsappModule, forwardRef(() => WooCommerceModule), forwardRef(() => PickOrdersModule)],
  // DespachoBackfillService → preenche `shipped_at` do que já estava
  // despachado quando a coluna nasceu (25/08). Roda uma vez e some.
  // LinhaDoTempoService → raio-x "onde está cada peça" + histórico assinado
  // da tela do pedido (contrato 26/08, casos ON-000106/LP-000244).
  providers: [OrdersService, TrocaPecaService, DespachoBackfillService, LinhaDoTempoService, PedidoEmailService],
  controllers: [OrdersController],
  exports: [OrdersService, TrocaPecaService],
})
export class OrdersModule {}
