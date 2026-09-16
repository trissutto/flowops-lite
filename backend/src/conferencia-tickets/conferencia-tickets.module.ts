import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { ConferenciaTicketsAdminController } from './conferencia-tickets-admin.controller';
import { ConferenciaTicketsPublicoController } from './conferencia-tickets-publico.controller';
import { ConferenciaTicketsController } from './conferencia-tickets.controller';
import { ConferenciaTicketsService } from './conferencia-tickets.service';
import { LeitorTicketsService } from './leitor-tickets.service';
import { TicketsArmazenamentoService } from './tickets-armazenamento.service';

/** Conferência de tickets por foto (16/09/2026) — ver conferencia-tickets.service.ts. */
@Module({
  imports: [PrismaModule, WhatsappModule, WebsocketModule],
  providers: [ConferenciaTicketsService, LeitorTicketsService, TicketsArmazenamentoService],
  controllers: [ConferenciaTicketsController, ConferenciaTicketsAdminController, ConferenciaTicketsPublicoController],
})
export class ConferenciaTicketsModule {}
