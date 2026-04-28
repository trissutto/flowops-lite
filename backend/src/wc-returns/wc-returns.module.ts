import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WooCommerceModule } from '../woocommerce/woocommerce.module';
import { WcReturnsService } from './wc-returns.service';
import { WcReturnsController } from './wc-returns.controller';

@Module({
  imports: [PrismaModule, ErpModule, WooCommerceModule],
  controllers: [WcReturnsController],
  providers: [WcReturnsService],
  exports: [WcReturnsService],
})
export class WcReturnsModule {}
