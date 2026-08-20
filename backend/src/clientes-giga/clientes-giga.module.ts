import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { ClientesGigaController, ClientesGigaPdvController } from './clientes-giga.controller';
import { ClientesGigaService } from './clientes-giga.service';
import { ClientesLimpezaService } from './clientes-limpeza.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [ClientesGigaController, ClientesGigaPdvController],
  providers: [ClientesGigaService, ClientesLimpezaService],
  exports: [ClientesGigaService],
})
export class ClientesGigaModule {}
