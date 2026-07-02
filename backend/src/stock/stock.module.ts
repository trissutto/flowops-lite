import { Module } from '@nestjs/common';
import { StockService } from './stock.service';
import { StockController } from './stock.controller';
import { DiagnoseController } from './diagnose.controller';
import { ErpModule } from '../erp/erp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WpDbModule } from '../wp-db/wp-db.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';

@Module({
  imports: [ErpModule, PrismaModule, WpDbModule, WincredMirrorModule],
  controllers: [StockController, DiagnoseController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
