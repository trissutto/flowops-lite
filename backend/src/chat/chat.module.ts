import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { LojaCatalogModule } from '../loja-catalog/loja-catalog.module';
// Traz JwtModule junto (o módulo do app cliente o exporta) — é ele que valida
// o token da cliente quando ela está logada.
import { CustomersAppModule } from '../customers-app/customers-app.module';
import { ChatService } from './chat.service';
import { ChatAdminController, ChatPublicController } from './chat.controller';

@Module({
  imports: [PrismaModule, HttpModule, ConfigModule, LojaCatalogModule, CustomersAppModule],
  controllers: [ChatPublicController, ChatAdminController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
