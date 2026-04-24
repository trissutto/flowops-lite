import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { RealignmentController } from './realignment.controller';
import { RealignmentService } from './realignment.service';

/**
 * Nota: dependia de WhatsappModule (disparo de WhatsApp consolidado) até o
 * pivot #168..#172 — agora o alerta chega pela filial via socket, então a
 * integração WhatsApp foi removida e o módulo passa a depender do
 * WebsocketModule pra emitir `realignment:new` e `realignment:sent`.
 */
@Module({
  imports: [AuthModule, PrismaModule, ErpModule, WebsocketModule],
  controllers: [RealignmentController],
  providers: [RealignmentService],
  exports: [RealignmentService],
})
export class RealignmentModule {}
