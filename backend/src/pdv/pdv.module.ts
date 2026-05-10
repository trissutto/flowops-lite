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
import { PdvDiagController } from './pdv-diag.controller';
import { MarcadosService } from './marcados.service';
import { MarcadosController } from './marcados.controller';
import { ActiveSellersService } from './active-sellers.service';
import { ActiveSellersController } from './active-sellers.controller';
import { CarneCoordsService } from './carne-coords.service';
import { CarneCoordsController } from './carne-coords.controller';

@Module({
  imports: [PrismaModule, ErpModule, PagarmeModule, forwardRef(() => CrediariosModule), WooCommerceModule],
  controllers: [PdvController, CashController, ReturnsController, PdvDiagController, MarcadosController, ActiveSellersController, CarneCoordsController],
  providers: [PdvService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService, MarcadosService, ActiveSellersService, CarneCoordsService],
  exports: [PdvService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService, MarcadosService, ActiveSellersService, CarneCoordsService],
})
export class PdvModule {}
