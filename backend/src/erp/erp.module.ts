import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpService } from './erp.service';
import { ErpQueryController } from './erp-query.controller';
import { NcmAuditController } from './ncm-audit.controller';
import { SombraService } from './sombra.service';
import { SombraController } from './sombra.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ErpQueryController, NcmAuditController, SombraController],
  // NcmAuditService saiu do módulo no enterro do Wincred (09/2026): as rotas
  // viraram GoneException e ninguém mais o injeta. O arquivo fica no museu
  // (regras de NCM por categoria) — registrá-lo só abriria mais um pool MySQL
  // pro servidor desligado no boot.
  providers: [ErpService, SombraService],
  exports: [ErpService, SombraService],
})
export class ErpModule {}
