import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { ContasPagarMigracaoService } from './contas-pagar-migracao.service';
import { ContasPagarService } from './contas-pagar.service';
import { ContasPagarController } from './contas-pagar.controller';

/**
 * Contas a Pagar 100% Flow (decisão do dono 11/07/2026 — GIGA congela).
 * Fase 1: modelo (schema.prisma) + espelho giga_pagar + migração idempotente
 * + validação de aceite. Dossiê-contrato: docs/GIGA-CONTAS-DESCOBERTA.md.
 */
@Module({
  imports: [PrismaModule, ErpModule],
  providers: [ContasPagarMigracaoService, ContasPagarService],
  controllers: [ContasPagarController],
})
export class ContasPagarModule {}
