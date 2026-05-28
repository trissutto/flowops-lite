import { Module } from '@nestjs/common';
import { SiteSaidasReportService } from './site-saidas.service';
import { SiteSaidasController } from './site-saidas.controller';
import { ErpModule } from '../erp/erp.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ErpModule, AuthModule],
  providers: [SiteSaidasReportService],
  controllers: [SiteSaidasController],
  exports: [SiteSaidasReportService],
})
export class ReportsModule {}
