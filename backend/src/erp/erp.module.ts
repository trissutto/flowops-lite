import { Module } from '@nestjs/common';
import { ErpService } from './erp.service';
import { ErpQueryController } from './erp-query.controller';

@Module({
  controllers: [ErpQueryController],
  providers: [ErpService],
  exports: [ErpService],
})
export class ErpModule {}
