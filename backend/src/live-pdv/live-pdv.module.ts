import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { RoutingModule } from '../routing/routing.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { PagbankModule } from '../pagbank/pagbank.module';
import { ProductPhotosModule } from '../product-photos/product-photos.module';
import { RealignmentModule } from '../realignment/realignment.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { ProductSearchModule } from '../product-search/product-search.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { LivePdvController } from './live-pdv.controller';
import { LivePublicController, ManychatHookController } from './live-public.controller';
import { LivePayPublicController } from './live-pay-public.controller';
import { LivePdvService } from './live-pdv.service';
import { ManychatService } from './manychat.service';
import { LivePdvExpiryCron } from './live-pdv-expiry.cron';
import { LivePdvPayReconcileCron } from './live-pdv-pay-reconcile.cron';

/**
 * Módulo de Live Commerce operado pela apresentadora (Live PDV).
 *
 * Reusa: ErpModule (grade/estoque/preço), RoutingModule (loja de origem),
 * PagarmeModule (PIX), ProductPhotosModule (foto), WebsocketModule (realtime).
 */
@Module({
  imports: [
    AuthModule,
    PrismaModule,
    ErpModule,
    RoutingModule,
    PagarmeModule,
    PagbankModule,
    ProductPhotosModule,
    RealignmentModule,
    WincredMirrorModule,
    ProductSearchModule,
    WebsocketModule,
  ],
  controllers: [LivePdvController, LivePublicController, ManychatHookController, LivePayPublicController],
  providers: [LivePdvService, ManychatService, LivePdvExpiryCron, LivePdvPayReconcileCron],
  exports: [LivePdvService],
})
export class LivePdvModule {}
