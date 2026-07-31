import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { StockConferidorService } from './stock-conferidor.service';
import { StockConferidorController } from './stock-conferidor.controller';

/**
 * Conferidor de estoque Flow × Giga. Ver o service pro porquê.
 */
@Module({
  imports: [PrismaModule, ErpModule],
  controllers: [StockConferidorController],
  providers: [StockConferidorService],
  exports: [StockConferidorService],
})
export class StockConferidorModule {}
