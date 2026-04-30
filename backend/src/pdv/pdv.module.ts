import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { PdvService } from './pdv.service';
import { PdvController } from './pdv.controller';
import { PixService } from './pix.service';
import { CashService } from './cash.service';
import { CashController } from './cash.controller';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { NfceService } from './nfce.service';

@Module({
  imports: [PrismaModule, ErpModule, PagarmeModule],
  controllers: [PdvController, CashController, ReturnsController],
  providers: [PdvService, PixService, CashService, ReturnsService, NfceService],
  exports: [PdvService, PixService, CashService, ReturnsService, NfceService],
})
export class PdvModule {}
