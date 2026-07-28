import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NfeModule } from '../nfe/nfe.module';
import { DceController } from './dce.controller';
import { DceEmitService } from './dce-emit.service';
import { DacePdfService } from './dace-pdf.service';
import { NfeSequenceService } from '../nfe/nfe-sequence.service';

/**
 * DC-e (modelo 99) — Declaração de Conteúdo eletrônica.
 * Reaproveita a camada fiscal existente: certificado/identidade do NfceConfig,
 * numeração NfeSequence (modelo 99), padrão de assinatura/transmissão da NFC-e.
 */
@Module({
  imports: [PrismaModule, NfeModule],
  controllers: [DceController],
  providers: [DceEmitService, DacePdfService, NfeSequenceService],
  exports: [DceEmitService, DacePdfService],
})
export class DceModule {}
