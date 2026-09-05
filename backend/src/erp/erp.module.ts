import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpService } from './erp.service';
import { NcmAuditController } from './ncm-audit.controller';
import { SombraService } from './sombra.service';

@Module({
  imports: [PrismaModule],
  // ErpQueryController (explorer /erp-query da tela /relatorios/giga) foi
  // DELETADO no enterro do Wincred (09/2026): o pool MySQL não é mais criado
  // (`gigaDesligado()` em onModuleInit), então `listAllTables` devolvia [],
  // `getTableSchema` devolvia 404 e o health respondia "Pool ERP não
  // inicializado" em 100% dos cliques. Explorer de banco desligado é museu.
  // O SombraController (GET/POST /erp/sombra) foi DELETADO em 09/2026: servia
  // o placar da comparação Postgres × ERP legado durante a migração, e não há
  // mais segundo banco pra comparar. O SombraService fica — nele moram as
  // consultas de catálogo/estoque no Postgres.
  controllers: [NcmAuditController],
  // NcmAuditService saiu do módulo (Onda 1) e o ARQUIVO foi DELETADO na Onda 2:
  // as rotas viram GoneException, ninguém injetava o service, e ele abria um
  // pool MySQL próprio pro servidor desligado. Auditoria de NCM, quando voltar,
  // nasce sobre a tabela nativa `product` — não sobre a `produtos` do Giga.
  providers: [ErpService, SombraService],
  exports: [ErpService, SombraService],
})
export class ErpModule {}
