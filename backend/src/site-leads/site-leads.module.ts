import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SiteLeadsController, SiteLeadsPublicController } from './site-leads.controller';
import { SiteLeadsService } from './site-leads.service';

@Module({
  imports: [PrismaModule],
  controllers: [SiteLeadsPublicController, SiteLeadsController],
  providers: [SiteLeadsService],
  exports: [SiteLeadsService],
})
export class SiteLeadsModule {}
