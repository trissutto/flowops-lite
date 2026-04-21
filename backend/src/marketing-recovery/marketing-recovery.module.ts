import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { AbandonedCartsModule } from '../abandoned-carts/abandoned-carts.module';
import { MarketingRecoveryController } from './marketing-recovery.controller';
import { MarketingRecoveryService } from './marketing-recovery.service';

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, AbandonedCartsModule],
  controllers: [MarketingRecoveryController],
  providers: [MarketingRecoveryService],
  exports: [MarketingRecoveryService],
})
export class MarketingRecoveryModule {}
