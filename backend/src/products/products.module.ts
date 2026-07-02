import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { PublicVitrineController } from './public-vitrine.controller';
import { VendaCertaAutoMatchService } from './venda-certa-auto-match.service';
import { StockSyncCronService } from './stock-sync-cron.service';
import { ErpModule } from '../erp/erp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';

@Module({
  imports: [HttpModule, ErpModule, PrismaModule, WincredMirrorModule],
  providers: [ProductsService, VendaCertaAutoMatchService, StockSyncCronService],
  controllers: [ProductsController, PublicVitrineController],
  exports: [ProductsService, VendaCertaAutoMatchService],
})
export class ProductsModule {}
