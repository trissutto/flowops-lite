import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { PushModule } from '../push/push.module';
// Pro art. 130: o mapa de férias precisa contar as faltas injustificadas.
import { RhEventosModule } from '../rh-eventos/rh-eventos.module';
import { SellersController } from './sellers.controller';
import { SellersService } from './sellers.service';
import { SellerDocumentsService } from './seller-documents.service';
import { SellersCronService } from './sellers-cron.service';
import { RhResumoController } from './rh-resumo.controller';

@Module({
  imports: [AuthModule, PrismaModule, ErpModule, PushModule, RhEventosModule],
  controllers: [SellersController, RhResumoController],
  providers: [SellersService, SellerDocumentsService, SellersCronService],
  exports: [SellersService],
})
export class SellersModule {}
