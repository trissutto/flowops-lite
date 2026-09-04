import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StockMirrorService } from './stock-mirror.service';
import { StockMirrorController } from './stock-mirror.controller';

/**
 * O ErpModule saiu daqui em 09/26 junto com o `fullSyncFromGiga`: era a única
 * coisa deste módulo que falava com o MySQL do Giga. O espelho é 100% Postgres.
 */
@Module({
  imports: [PrismaModule],
  controllers: [StockMirrorController],
  providers: [StockMirrorService],
  exports: [StockMirrorService],
})
export class StockMirrorModule {}
