import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { PagarmeModule } from '../pagarme/pagarme.module';
import { CrediariosModule } from '../crediarios/crediarios.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { PromoConfigModule } from '../promo-config/promo-config.module';
import { PdvService } from './pdv.service';
import { PdvController } from './pdv.controller';
import { PixService } from './pix.service';
import { CashService } from './cash.service';
import { CashController } from './cash.controller';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { ReturnsPublicController } from './returns-public.controller';
import { NfceService } from './nfce.service';
import { CrediarioPrintService } from './crediario-print.service';
import { CoordsDbService } from './coords-db.service';
import { PdvDiagController } from './pdv-diag.controller';
import { MarcadosService } from './marcados.service';
import { MarcadosController } from './marcados.controller';
import { ActiveSellersService } from './active-sellers.service';
import { ActiveSellersController } from './active-sellers.controller';
import { CarneCoordsService } from './carne-coords.service';
import { CarneCoordsController } from './carne-coords.controller';
import { FiscalReportService } from './fiscal-report.service';
import { FiscalReportController } from './fiscal-report.controller';
import { ProdutosVendidosService } from './produtos-vendidos.service';
import { ProdutosVendidosController } from './produtos-vendidos.controller';

@Module({
  imports: [PrismaModule, ErpModule, PagarmeModule, forwardRef(() => CrediariosModule), WooCommerceModule, PromoConfigModule],
  controllers: [PdvController, CashController, ReturnsController, ReturnsPublicController, PdvDiagController, MarcadosController, ActiveSellersController, CarneCoordsController, FiscalReportController, ProdutosVendidosController],
  providers: [PdvService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService, CoordsDbService, MarcadosService, ActiveSellersService, CarneCoordsService, FiscalReportService, ProdutosVendidosService],
  exports: [PdvService, PixService, CashService, ReturnsService, NfceService, CrediarioPrintService, CoordsDbService, MarcadosService, ActiveSellersService, CarneCoordsService, FiscalReportService, ProdutosVendidosService],
})
export class PdvModule {}
