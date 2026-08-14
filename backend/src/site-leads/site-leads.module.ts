import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { SiteLeadsController, SiteLeadsPublicController } from './site-leads.controller';
import { SiteLeadsService } from './site-leads.service';

@Module({
  // EmailModule/WhatsappModule → entrega do cupom prometido no popup.
  imports: [PrismaModule, EmailModule, WhatsappModule],
  controllers: [SiteLeadsPublicController, SiteLeadsController],
  providers: [SiteLeadsService],
  exports: [SiteLeadsService],
})
export class SiteLeadsModule {}
