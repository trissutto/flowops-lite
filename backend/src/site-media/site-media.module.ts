import { Module } from '@nestjs/common';
import { CloudflareImagesClient } from './cloudflare-images.client';
import { SiteMediaController } from './site-media.controller';
import { SiteMediaService } from './site-media.service';

@Module({
  controllers: [SiteMediaController],
  providers: [CloudflareImagesClient, SiteMediaService],
  exports: [SiteMediaService],
})
export class SiteMediaModule {}
