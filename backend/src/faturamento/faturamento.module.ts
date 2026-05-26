import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { FaturamentoService } from './faturamento.service';
import { FaturamentoController } from './faturamento.controller';

@Module({
  imports: [PrismaModule, ErpModule],
  providers: [FaturamentoService],
  controllers: [FaturamentoController],
  exports: [FaturamentoService],
})
export class FaturamentoModule {}
