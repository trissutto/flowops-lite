import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PushService } from './push.service';
import { PushController } from './push.controller';

/**
 * PushModule — Web Push Notifications.
 * Exporta PushService pra outros módulos (routing, realignment, etc) dispararem
 * pushes nos eventos relevantes (pedido novo, transferência, etc).
 */
@Module({
  imports: [PrismaModule],
  providers: [PushService],
  controllers: [PushController],
  exports: [PushService],
})
export class PushModule {}
