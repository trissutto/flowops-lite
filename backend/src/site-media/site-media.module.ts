import { Module } from '@nestjs/common';
import { CloudflareImagesClient } from './cloudflare-images.client';
import { SiteMediaController } from './site-media.controller';
import { SiteMediaService } from './site-media.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SiteMediaController],
  providers: [CloudflareImagesClient, SiteMediaService],
  exports: [SiteMediaService],
})
export class SiteMediaModule {}
