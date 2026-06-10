import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { StockMirrorService } from './stock-mirror.service';
import { StockMirrorController } from './stock-mirror.controller';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [StockMirrorController],
  providers: [StockMirrorService],
  exports: [StockMirrorService],
})
export class StockMirrorModule {}
