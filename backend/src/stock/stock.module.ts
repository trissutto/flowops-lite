import { Module } from '@nestjs/common';
import { StockService } from './stock.service';
import { StockController } from './stock.controller';
import { ErpModule } from '../erp/erp.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ErpModule, PrismaModule],
  controllers: [StockController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
