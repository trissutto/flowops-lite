import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { TrackingModule } from '../tracking/tracking.module';
import { EmailModule } from '../email/email.module';
import { ErpModule } from '../erp/erp.module';
import { TrocasService } from './trocas.service';
import { TrocasPublicController } from './trocas-public.controller';
import { TrocasAdminController } from './trocas-admin.controller';

@Module({
  imports: [PrismaModule, WooCommerceModule, TrackingModule, EmailModule, ErpModule],
  controllers: [TrocasPublicController, TrocasAdminController],
  providers: [TrocasService],
  exports: [TrocasService],
})
export class TrocasModule {}
