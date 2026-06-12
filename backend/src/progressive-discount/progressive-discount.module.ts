import { Module } from '@nestjs/common';
import { ProgressiveDiscountService } from './progressive-discount.service';
import {
  ProgressiveDiscountAdminController,
  ProgressiveDiscountPublicController,
} from './progressive-discount.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ProgressiveDiscountAdminController, ProgressiveDiscountPublicController],
  providers: [ProgressiveDiscountService],
  exports: [ProgressiveDiscountService],
})
export class ProgressiveDiscountModule {}
