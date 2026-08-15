import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { EvolutionClient } from './evolution.client';
import { WhatsappCampaignService } from './whatsapp-campaign.service';
import { WhatsappCampaignController } from './whatsapp-campaign.controller';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappInboxController } from './whatsapp-inbox.controller';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappIaService } from './whatsapp-ia.service';

/**
 * WHATSAPP PELO FLOWOPS — dono da própria operação, sem n8n:
 *   · campanhas (disparo pausado + kill-switch);
 *   · inbox (WhatsApp Web da instância; celular fica na loja).
 * Evolution configurado por ENV (EVOLUTION_URL/KEY/INSTANCE no Railway).
 */
@Module({
  imports: [PrismaModule, HttpModule],
  controllers: [WhatsappCampaignController, WhatsappInboxController, WhatsappWebhookController],
  providers: [EvolutionClient, WhatsappCampaignService, WhatsappInboxService, WhatsappIaService],
  exports: [WhatsappCampaignService],
})
export class WhatsappCampaignModule {}
