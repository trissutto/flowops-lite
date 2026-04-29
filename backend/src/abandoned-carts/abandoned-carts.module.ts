import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AbandonedCartsController } from './abandoned-carts.controller';
import { AbandonedCartsService } from './abandoned-carts.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [HttpModule, AuthModule],
  controllers: [AbandonedCartsController],
  providers: [AbandonedCartsService],
  exports: [AbandonedCartsService],
})
export class AbandonedCartsModule {}
