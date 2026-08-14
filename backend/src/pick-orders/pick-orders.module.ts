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
import { PedidoEmailService } from '../loja-orders/pedido-email.service';

@Module({
  // LivePdvModule → ManychatService (WhatsApp de rastreio pra cliente da LIVE)
  // WincredMirrorModule → WincredCatalogService (preço do espelho pra diferença na troca de peça)
  // CorreiosModule → CorreiosService (rastreio pro cron marcar enviado na postagem)
  // DceModule → DceEmitService (declaração de conteúdo eletrônica no "Gerar envio")
  // NfeModule → NfeTransferService (NF-e da venda no "Gerar envio" + chave na pré-postagem)
  // EmailModule/HttpModule → PedidoEmailService registrado AQUI de novo (instância
  // própria, deps são só Email/Config/Http): o aviso de rastreio do site novo
  // dispara do afterShipped sem criar ciclo com o LojaOrdersModule.
  imports: [PrismaModule, WebsocketModule, forwardRef(() => WooCommerceModule), ErpModule, LivePdvModule, WincredMirrorModule, CorreiosModule, MaisEnviosModule, DceModule, NfeModule, EmailModule, HttpModule],
  controllers: [PickOrdersController],
  providers: [PickOrdersService, CorreiosPostagemReconcileCron, EntregaAvisoCron, PedidoEmailService],
  exports: [PickOrdersService],
})
export class PickOrdersModule {}
