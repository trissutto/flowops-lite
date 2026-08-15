import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EvolutionClient } from './evolution.client';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { WhatsappCampaignController } from './whatsapp-campaign.controller';

/**
 * DISPARO DE WHATSAPP PELO FLOWOPS — dono da própria campanha, sem n8n.
 * Evolution configurado por ENV (EVOLUTION_URL/KEY/INSTANCE no Railway).
 */
@Module({
  imports: [PrismaModule],
  controllers: [WhatsappCampaignController],
  providers: [EvolutionClient, WhatsappCampaignService],
  exports: [WhatsappCampaignService],
})
export class WhatsappCampaignModule {}
