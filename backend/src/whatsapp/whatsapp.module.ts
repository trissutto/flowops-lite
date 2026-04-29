import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappCobrancaService } from './whatsapp-cobranca.service';
import { WhatsappCobrancaController } from './whatsapp-cobranca.controller';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [AuthModule, PrismaModule],
  providers: [WhatsappService, WhatsappCobrancaService],
  controllers: [WhatsappController, WhatsappCobrancaController],
  exports: [WhatsappService, WhatsappCobrancaService],
})
export class WhatsappModule {}
