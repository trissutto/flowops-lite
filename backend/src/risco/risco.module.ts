import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RiscoService } from './risco.service';
import { RiscoChavesService } from './risco-chaves.service';
import { RiscoPesosService } from './risco-pesos.service';
import { RiscoFilaService } from './risco-fila.service';
import { ChargebackService } from './chargeback.service';
import { DossiePdfService } from './dossie-pdf.service';
import { RiscoController } from './risco.controller';

/**
 * MÓDULO DE ANÁLISE DE RISCO, CRUZAMENTO DE PEDIDOS E CHARGEBACK.
 *
 * Depende só do Prisma de propósito: ele LÊ o pedido e escreve em tabelas
 * próprias, e não pode ter uma aresta capaz de derrubar venda. Quem precisa
 * dele (o `LojaOrdersModule`, pra gerar chave no pedido novo, e o
 * `PagarmeModule`, pro webhook de chargeback) importa este módulo — nunca o
 * contrário.
 */
@Module({
  imports: [PrismaModule],
  controllers: [RiscoController],
  providers: [
    RiscoChavesService,
    RiscoPesosService,
    RiscoService,
    RiscoFilaService,
    ChargebackService,
    DossiePdfService,
  ],
  exports: [RiscoChavesService, RiscoService, ChargebackService],
})
export class RiscoModule {}
