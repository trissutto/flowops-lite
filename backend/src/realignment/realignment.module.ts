import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { RealignmentController } from './realignment.controller';
import { RealignmentService } from './realignment.service';

@Module({
  imports: [AuthModule, PrismaModule, ErpModule, WhatsappModule],
  controllers: [RealignmentController],
  providers: [RealignmentService],
  exports: [RealignmentService],
})
export class RealignmentModule {}
