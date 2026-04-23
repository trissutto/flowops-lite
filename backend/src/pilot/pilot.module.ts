import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { RoutingModule } from '../routing/routing.module';
import { OrdersModule } from '../orders/orders.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { PilotController } from './pilot.controller';
import { PilotService } from './pilot.service';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    WhatsappModule,
    RoutingModule,
    forwardRef(() => OrdersModule),
    forwardRef(() => WooCommerceModule),
  ],
  controllers: [PilotController],
  providers: [PilotService],
  exports: [PilotService],
})
export class PilotModule {}
