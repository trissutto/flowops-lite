import { Module } from '@nestjs/common';
import { SiteSaidasReportService } from './site-saidas.service';
import { SiteSaidasController } from './site-saidas.controller';
// Buscador Postgres de codigo/ean/ref (buscarEtiquetasAvulsas, commit 919585f)
// — substituiu o erp.buscarProdutoPorCodigo do Giga morto no enriquecimento.
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PurchaseOrdersModule, AuthModule],
  providers: [SiteSaidasReportService],
  controllers: [SiteSaidasController],
  exports: [SiteSaidasReportService],
})
export class ReportsModule {}
