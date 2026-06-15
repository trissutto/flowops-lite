import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { CutoverService } from './cutover.service';
import { CutoverController } from './cutover.controller';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [CutoverController],
  providers: [CutoverService],
  exports: [CutoverService],
})
export class CutoverModule {}
