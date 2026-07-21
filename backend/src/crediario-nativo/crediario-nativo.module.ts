import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { CrediarioNativoController } from './crediario-nativo.controller';
import { CrediarioNativoService } from './crediario-nativo.service';

@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [CrediarioNativoController],
  providers: [CrediarioNativoService],
  exports: [CrediarioNativoService],
})
export class CrediarioNativoModule {}
