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
import { CorreiosPostagemReconcileCron } from './correios-postagem-reconcile.cron';

@Module({
  // LivePdvModule → ManychatService (WhatsApp de rastreio pra cliente da LIVE)
  // WincredMirrorModule → WincredCatalogService (preço do espelho pra diferença na troca de peça)
  // CorreiosModule → CorreiosService (rastreio pro cron marcar enviado na postagem)
  imports: [PrismaModule, WebsocketModule, forwardRef(() => WooCommerceModule), ErpModule, LivePdvModule, WincredMirrorModule, CorreiosModule],
  controllers: [PickOrdersController],
  providers: [PickOrdersService, CorreiosPostagemReconcileCron],
  exports: [PickOrdersService],
})
export class PickOrdersModule {}
