import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { RoutingModule } from '../routing/routing.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { ProductPhotosModule } from '../product-photos/product-photos.module';
import { RealignmentModule } from '../realignment/realignment.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { LivePdvController } from './live-pdv.controller';
import { LivePdvService } from './live-pdv.service';
import { LivePdvExpiryCron } from './live-pdv-expiry.cron';

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
    ProductPhotosModule,
    RealignmentModule,
    WebsocketModule,
  ],
  controllers: [LivePdvController],
  providers: [LivePdvService, LivePdvExpiryCron],
  exports: [LivePdvService],
})
export class LivePdvModule {}
