import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { CrediariosModule } from '../crediarios/crediarios.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { PdvService } from './pdv.service';
import { PdvController } from './pdv.controller';
import { PixService } from './pix.service';
import { CashService } from './cash.service';
import { CashController } from './cash.controller';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { NfceService } from './nfce.service';
import { CrediarioPrintService } from './crediario-print.service';

@Module({
  imports: [PrismaModule, ErpModule, PagarmeModule, forwardRef(() => CrediariosModule), WooCommerceModule],
  controllers: [PdvController, CashController, ReturnsController],
  providers: [PdvService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService],
  exports: [PdvService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService],
})
export class PdvModule {}
