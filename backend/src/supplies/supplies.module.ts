import { Module } from '@nestjs/common';
import { SuppliesController } from './supplies.controller';
import { SuppliesService } from './supplies.service';
import { PrismaModule } from '../prisma/prisma.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [PrismaModule, WebsocketModule, PushModule],
  controllers: [SuppliesController],
  providers: [SuppliesService],
  exports: [SuppliesService],
})
export class SuppliesModule {}
