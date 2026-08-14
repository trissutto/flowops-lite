import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { DefeitosService } from './defeitos.service';

/**
 * DEFEITOS — registro de peça avariada fora do módulo de marcados.
 *
 * Dependências e por quê:
 *   - ErpModule           → `decreaseStockAsync` (baixa no Flow + réplica
 *                           Giga via outbox)
 *   - WincredMirrorModule → `getPdvProductInfo`, o mesmo caminho do bipe do
 *                           PDV (espelho primeiro, Giga como fallback)
 *
 * O service é exportado porque o PDV vai chamá-lo na devolução marcada como
 * "voltou com defeito" (fase 4) — a peça não retorna ao estoque, vira
 * registro de defeito direto.
 */
@Module({
  imports: [PrismaModule, ErpModule, WincredMirrorModule],
  providers: [DefeitosService],
  exports: [DefeitosService],
})
export class DefeitosModule {}
