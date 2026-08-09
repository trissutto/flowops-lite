import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { ProductRegistrationModule } from '../product-registration/product-registration.module';
import { AtributosPecaModule } from '../atributos-peca/atributos-peca.module';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { NcmAiClassifierService } from './ncm-ai-classifier.service';

@Module({
  imports: [
    HttpModule,
    PrismaModule,
    ErpModule,
    ProductRegistrationModule,
    AtributosPecaModule,
  ],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService, NcmAiClassifierService],
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
