import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { RealignmentModule } from '../realignment/realignment.module';
import { FinanceiroService } from './financeiro.service';
import { FinanceiroController } from './financeiro.controller';
import { FechamentoPdfService } from './pdf.service';
import { ContaCorrenteService } from './conta-corrente.service';
import { ContaCorrenteController } from './conta-corrente.controller';

@Module({
  imports: [PrismaModule, ErpModule, RealignmentModule],
  controllers: [FinanceiroController, ContaCorrenteController],
  providers: [FinanceiroService, FechamentoPdfService, ContaCorrenteService],
  exports: [FinanceiroService, FechamentoPdfService],
})
export class FinanceiroModule {}
