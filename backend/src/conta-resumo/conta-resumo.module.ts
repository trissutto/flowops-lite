import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersAppModule } from '../customers-app/customers-app.module';
import { AvaliacoesModule } from '../avaliacoes/avaliacoes.module';
import { ContaResumoService } from './conta-resumo.service';
import { ContaResumoController } from './conta-resumo.controller';

@Module({
  imports: [PrismaModule, CustomersAppModule, AvaliacoesModule],
  controllers: [ContaResumoController],
  providers: [ContaResumoService],
  exports: [ContaResumoService],
})
export class ContaResumoModule {}
