import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { EmailModule } from '../email/email.module';
import { MauticClient } from './mautic.client';
import { EmailMarketingService } from './email-marketing.service';
import { EmailMarketingController } from './email-marketing.controller';

/**
 * DISPARO DE E-MAIL PELO FLOWOPS falando com o Mautic via API.
 * HttpModule → chamadas à API do Mautic · EmailModule → prévia pelo nosso SES.
 */
@Module({
  imports: [HttpModule, EmailModule],
  controllers: [EmailMarketingController],
  providers: [MauticClient, EmailMarketingService],
  exports: [EmailMarketingService],
})
export class EmailMarketingModule {}
