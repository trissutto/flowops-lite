import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { CommissionsService } from './commissions.service';
import { CommissionsController } from './commissions.controller';

/**
 * Módulo de Comissões — F4 do plano 30/06.
 *
 * Substitui o cálculo que hoje vem do Wincred/Giga. Permite admin
 * configurar regras hierárquicas (global/store/seller), gerar fechamentos
 * mensais idempotentes e marcar comissões como pagas.
 */
@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [CommissionsController],
  providers: [CommissionsService],
  exports: [CommissionsService],
})
export class CommissionsModule {}
