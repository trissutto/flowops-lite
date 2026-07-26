import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { FaturamentoModule } from '../faturamento/faturamento.module';
import { DreController } from './dre.controller';
import { DreService } from './dre.service';

// FaturamentoModule entra aqui pra DRE e tela de Faturamento comerem da MESMA
// função no canal digital — reimplementar a regra do SITE já custou R$ 48k de
// divergência entre as duas telas (26/07).
@Module({
  imports: [PrismaModule, ErpModule, FaturamentoModule],
  controllers: [DreController],
  providers: [DreService],
  exports: [DreService],
})
export class DreModule {}
