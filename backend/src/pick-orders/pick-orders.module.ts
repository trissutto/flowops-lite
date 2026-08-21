import { Module, forwardRef } from '@nestjs/common';
import { PickOrdersController } from './pick-orders.controller';
import { PickOrdersService } from './pick-orders.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { ErpModule } from '../erp/erp.module';
import { LivePdvModule } from '../live-pdv/live-pdv.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { CorreiosModule } from '../correios/correios.module';
import { MaisEnviosModule } from '../mais-envios/mais-envios.module';
import { DceModule } from '../dce/dce.module';
import { NfeModule } from '../nfe/nfe.module';
import { CorreiosPostagemReconcileCron } from './correios-postagem-reconcile.cron';
import { EntregaAvisoCron } from './entrega-aviso.cron';
import { HttpModule } from '@nestjs/axios';
import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { PedidoEmailService } from '../loja-orders/pedido-email.service';
import { PickScanModule } from './pick-scan.module';
import { TrackingModule } from '../tracking/tracking.module';
import { RealignmentModule } from '../realignment/realignment.module';
import { JuntadaService } from './juntada.service';

@Module({
  // LivePdvModule → ManychatService (WhatsApp de rastreio pra cliente da LIVE)
  // WincredMirrorModule → WincredCatalogService (preço do espelho pra diferença na troca de peça)
  // CorreiosModule → CorreiosService (rastreio pro cron marcar enviado na postagem)
  // DceModule → DceEmitService (declaração de conteúdo eletrônica no "Gerar envio")
  // NfeModule → NfeTransferService (NF-e da venda no "Gerar envio" + chave na pré-postagem)
  // EmailModule/HttpModule → PedidoEmailService registrado AQUI de novo (instância
  // própria, deps são só Email/Config/Http): o aviso de rastreio do site novo
  // dispara do afterShipped sem criar ciclo com o LojaOrdersModule.
  // TrackingModule → onde o objeto está (cache de rastreio) pra tela "Vendi online"
  // PickScanModule → bipe que baixa estoque + estorno (compartilhado com
  // routing e orders, por isso mora em módulo próprio).
  // RealignmentModule → JuntadaService cria a CAIXA do feeder (remessa +
  // etiqueta pra loja âncora + NF de transferência + romaneio carimbado).
  imports: [PrismaModule, WebsocketModule, forwardRef(() => WooCommerceModule), ErpModule, LivePdvModule, WincredMirrorModule, CorreiosModule, MaisEnviosModule, DceModule, NfeModule, EmailModule, HttpModule, WhatsappModule, PickScanModule, TrackingModule, RealignmentModule],
  controllers: [PickOrdersController],
  providers: [PickOrdersService, JuntadaService, CorreiosPostagemReconcileCron, EntregaAvisoCron, PedidoEmailService],
  exports: [PickOrdersService, JuntadaService],
})
export class PickOrdersModule {}
