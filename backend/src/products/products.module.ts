import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { PublicVitrineController } from './public-vitrine.controller';
import { VendaCertaAutoMatchService } from './venda-certa-auto-match.service';
import { ErpModule } from '../erp/erp.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WincredMirrorModule } from '../wincred-mirror/wincred-mirror.module';
import { ProductSearchModule } from '../product-search/product-search.module';

/**
 * ⚠️ O `StockSyncCronService` SAIU DAQUI EM 14/09/2026.
 *
 * Ele registrava `@Cron('0 3 * * *', { name: 'stock-sync-daily-3am' })` e
 * chamava `ProductsService.startBulkSync()` — o bulk sync "ERP → WooCommerce",
 * que pagina `WC_URL/wp-json/wc/v3/products`. O WordPress foi apagado em
 * 27/08/2026 e esse endereço hoje é o site NOVO, que devolve **HTTP 403 pela
 * Vercel** (medido em 14/09/2026 no apex e no www).
 *
 * Por que sair, e não só desligar:
 *   • nenhuma rota, tela ou cron dependia dele rodar às 3h — a única coisa que
 *     sobrava era o efeito colateral;
 *   • a falha era ENGOLIDA (`runBulkSync` grava `lastError`, dá `break` e
 *     marca `finishedAt`), então o job terminava "ok" com catálogo vazio,
 *     todo dia, sem alarme e sem ninguém lendo o log;
 *   • o kill-switch que o desligaria (`STOCK_SYNC_CRON_DISABLED=1`) NÃO existe
 *     no Railway — o default era LIGADO. Kill-switch que ninguém setou não é
 *     proteção, é bilhete.
 *
 * O `startBulkSync` continua existindo porque o botão "Sincronizar tudo" da
 * tela /produtos chama ele — e agora ele responde 410 Gone com o motivo em vez
 * de fingir que sincronizou (ver `woocommerce/wp-morto.ts`).
 */
@Module({
  imports: [HttpModule, ErpModule, PrismaModule, WincredMirrorModule, ProductSearchModule],
  providers: [ProductsService, VendaCertaAutoMatchService],
  controllers: [ProductsController, PublicVitrineController],
  exports: [ProductsService, VendaCertaAutoMatchService],
})
export class ProductsModule {}
