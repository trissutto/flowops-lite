import { Module } from '@nestjs/common';
import { StockService } from './stock.service';
import { ErpModule } from '../erp/erp.module';

@Module({
  imports: [ErpModule],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
