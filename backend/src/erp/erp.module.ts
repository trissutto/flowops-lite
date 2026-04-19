import { Module } from '@nestjs/common';
import { ErpService } from './erp.service';

@Module({
  providers: [ErpService],
  exports: [ErpService],
})
export class ErpModule {}
