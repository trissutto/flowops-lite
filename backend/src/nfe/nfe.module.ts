import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { NfeController } from './nfe.controller';
import { NfeTransferService } from './nfe-transfer.service';
import { NfeSequenceService } from './nfe-sequence.service';

@Module({
  // WincredMirrorModule → WincredCatalogService (custo + NCM do espelho)
  imports: [PrismaModule, WincredMirrorModule],
  controllers: [NfeController],
  providers: [NfeTransferService, NfeSequenceService],
  exports: [NfeTransferService],
})
export class NfeModule {}
