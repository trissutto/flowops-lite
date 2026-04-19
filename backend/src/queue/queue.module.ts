import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { RoutingModule } from '../routing/routing.module';

/**
 * Versão Lite: QueueService executa jobs de forma SÍNCRONA em memória.
 * Sem BullMQ / Redis.
 */
@Module({
  imports: [RoutingModule],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
