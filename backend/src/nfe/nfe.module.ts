import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { NfeController } from './nfe.controller';
import { VendaEtiquetaService } from './venda-etiqueta.service';
import { CorreiosModule } from '../correios/correios.module';
import { MaisEnviosModule } from '../mais-envios/mais-envios.module';
import { NfeTransferService } from './nfe-transfer.service';
import { NfeSequenceService } from './nfe-sequence.service';
import { DanfePdfService } from './danfe-pdf.service';

@Module({
  // WincredMirrorModule → WincredCatalogService (custo + NCM do espelho)
  imports: [PrismaModule, WincredMirrorModule, CorreiosModule, MaisEnviosModule],
  controllers: [NfeController],
  providers: [NfeTransferService, NfeSequenceService, DanfePdfService, VendaEtiquetaService],
  exports: [NfeTransferService, DanfePdfService],
})
export class NfeModule {}
