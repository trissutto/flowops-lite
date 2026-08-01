import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { CrediarioNativoController } from './crediario-nativo.controller';
import { CrediarioNativoService } from './crediario-nativo.service';
import { CrediarioCriacaoService } from './crediario-criacao.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [CrediarioNativoController],
  providers: [CrediarioNativoService, CrediarioCriacaoService],
  exports: [CrediarioNativoService, CrediarioCriacaoService],
})
export class CrediarioNativoModule {}
