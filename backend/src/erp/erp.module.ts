import { Module } from '@nestjs/common';
import { ErpService } from './erp.service';
import { ErpQueryController } from './erp-query.controller';
import { NcmAuditService } from './ncm-audit.service';
import { NcmAuditController } from './ncm-audit.controller';

@Module({
  controllers: [ErpQueryController, NcmAuditController],
  providers: [ErpService, NcmAuditService],
  exports: [ErpService, NcmAuditService],
})
export class ErpModule {}
