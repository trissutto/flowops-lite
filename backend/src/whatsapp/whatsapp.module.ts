import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappCobrancaService } from './whatsapp-cobranca.service';
import { WhatsappCobrancaController } from './whatsapp-cobranca.controller';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EvolutionClient } from '../whatsapp-campaign/evolution.client';

@Module({
  imports: [AuthModule, PrismaModule],
  /**
   * `EvolutionClient` entra como PROVIDER, não pelo import do
   * WhatsappCampaignModule — mesma receita do `PedidoEmailService` no PdvModule
   * e pelo mesmo motivo (um import de módulo novo foi o que fechou o ciclo e
   * derrubou o backend em 07/08). Ele é stateless e lê tudo de env, então a
   * segunda instância não custa nada nem duplica estado.
   */
  providers: [WhatsappService, WhatsappCobrancaService, EvolutionClient],
  controllers: [WhatsappController, WhatsappCobrancaController],
  exports: [WhatsappService, WhatsappCobrancaService],
})
export class WhatsappModule {}
