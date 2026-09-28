import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ErpModule } from '../erp/erp.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { PecasExtraviadasModule } from '../pecas-extraviadas/pecas-extraviadas.module';
import { InventarioService } from './inventario.service';
import { InventarioController } from './inventario.controller';

/**
 * INVENTÁRIO — contar a loja inteira sem fechar a loja.
 *
 * Dependências e por quê:
 *   · ErpModule              → `increaseStock`/`decreaseStock` (o Flow é a
 *                              fonte; o delta aplica no Postgres na hora) e
 *                              `skuVariants`, pra ler o espelho nas mesmas
 *                              grafias de código que a operação gravou
 *   · WincredMirrorModule    → `getPdvProductInfo`, o MESMO bipe do PDV:
 *                              resolve EAN legado e erra alto em vez de dizer
 *                              "não existe" com a peça na mão
 *   · PecasExtraviadasModule → peça contada é peça achada: a loja que reportou
 *                              "não achei" volta a entrar no roteamento
 *
 * Módulo folha: ninguém importa este. Quem quiser saber o que o inventário fez
 * lê `stock_movements` (reason `inventario`), como qualquer outro movimento.
 */
@Module({
  imports: [PrismaModule, ErpModule, WincredMirrorModule, PecasExtraviadasModule],
  controllers: [InventarioController],
  providers: [InventarioService],
})
export class InventarioModule {}
