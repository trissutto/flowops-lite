import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersAppModule } from '../customers-app/customers-app.module';
import { SizeFeedbackController } from './size-feedback.controller';
import { SizeFeedbackService } from './size-feedback.service';

@Module({
  imports: [PrismaModule, CustomersAppModule],
  controllers: [SizeFeedbackController],
  providers: [SizeFeedbackService],
  exports: [SizeFeedbackService],
})
export class SizeFeedbackModule {}
