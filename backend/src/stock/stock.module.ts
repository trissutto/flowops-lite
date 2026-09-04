import { Module } from '@nestjs/common';
import { StockService } from './stock.service';
import { DiagnoseController } from './diagnose.controller';
import { ErpModule } from '../erp/erp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';

/**
 * O StockController saiu em 09/26: os três endpoints dele (`/stock/diagnose`,
 * `/stock/giga-tables`, `/stock/wp-diagnose`) só liam o MySQL do Giga e o do
 * WordPress, os dois mortos desde 27/08 — e nenhuma tela chamava nenhum deles.
 * Com ele foi embora o WpDbModule, que estava aqui só pro `wp-diagnose`.
 */
@Module({
  imports: [ErpModule, PrismaModule, WincredMirrorModule],
  controllers: [DiagnoseController],
  providers: [StockService],
  exports: [StockService],
})
export class StockModule {}
