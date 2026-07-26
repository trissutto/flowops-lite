import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { DreController } from './dre.controller';
import { DreService } from './dre.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [DreController],
  providers: [DreService],
  exports: [DreService],
})
export class DreModule {}
