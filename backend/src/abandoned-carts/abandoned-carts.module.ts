import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AbandonedCartsController, CheckoutRecoveryPublicController } from './abandoned-carts.controller';
import { AbandonedCartsService } from './abandoned-carts.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [HttpModule, AuthModule],
  controllers: [AbandonedCartsController, CheckoutRecoveryPublicController],
  providers: [AbandonedCartsService],
  exports: [AbandonedCartsService],
})
export class AbandonedCartsModule {}
