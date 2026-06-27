import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PromoConfigService } from './promo-config.service';
import { PromoConfigController } from './promo-config.controller';

@Module({
  imports: [PrismaModule],
  controllers: [PromoConfigController],
  providers: [PromoConfigService],
  exports: [PromoConfigService],
})
export class PromoConfigModule {}
