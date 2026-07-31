import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpService } from './erp.service';
import { ErpQueryController } from './erp-query.controller';
import { NcmAuditService } from './ncm-audit.service';
import { NcmAuditController } from './ncm-audit.controller';
import { SombraService } from './sombra.service';
import { SombraController } from './sombra.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ErpQueryController, NcmAuditController, SombraController],
  providers: [ErpService, NcmAuditService, SombraService],
  exports: [ErpService, NcmAuditService, SombraService],
})
export class ErpModule {}
