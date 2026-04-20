import { Module } from '@nestjs/common';
import { PickOrdersController } from './pick-orders.controller';
import { PickOrdersService } from './pick-orders.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsocketModule } from '../websocket/websocket.module';

@Module({
  imports: [PrismaModule, WebsocketModule],
  controllers: [PickOrdersController],
  providers: [PickOrdersService],
  exports: [PickOrdersService],
})
export class PickOrdersModule {}
