import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SiteBannersController, SiteBannersPublicController } from './site-banners.controller';
import { SiteBannersService } from './site-banners.service';

@Module({
  imports: [PrismaModule],
  controllers: [SiteBannersPublicController, SiteBannersController],
  providers: [SiteBannersService],
  exports: [SiteBannersService],
})
export class SiteBannersModule {}
