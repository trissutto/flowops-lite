import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { ClientesGigaController } from './clientes-giga.controller';
import { ClientesGigaService } from './clientes-giga.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [ClientesGigaController],
  providers: [ClientesGigaService],
  exports: [ClientesGigaService],
})
export class ClientesGigaModule {}
