import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AbandonedCartsController } from './abandoned-carts.controller';
import { AbandonedCartsService } from './abandoned-carts.service';

@Module({
  imports: [HttpModule],
  controllers: [AbandonedCartsController],
  providers: [AbandonedCartsService],
})
export class AbandonedCartsModule {}
