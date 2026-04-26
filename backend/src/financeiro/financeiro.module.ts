import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { FinanceiroService } from './financeiro.service';
import { FinanceiroController } from './financeiro.controller';
import { FechamentoPdfService } from './pdf.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [FinanceiroController],
  providers: [FinanceiroService, FechamentoPdfService],
  exports: [FinanceiroService, FechamentoPdfService],
})
export class FinanceiroModule {}
