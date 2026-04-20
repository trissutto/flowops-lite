import { Module, forwardRef } from '@nestjs/common';
import { PickOrdersController } from './pick-orders.controller';
import { PickOrdersService } from './pick-orders.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { ErpModule } from '../erp/erp.module';

@Module({
  imports: [PrismaModule, WebsocketModule, forwardRef(() => WooCommerceModule), ErpModule],
  controllers: [PickOrdersController],
  providers: [PickOrdersService],
  exports: [PickOrdersService],
})
export class PickOrdersModule {}
