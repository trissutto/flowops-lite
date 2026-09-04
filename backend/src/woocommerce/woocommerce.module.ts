import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WooCommerceService } from './woocommerce.service';
import { WooCommerceController } from './woocommerce.controller';

/**
 * Cliente REST do WooCommerce legado.
 *
 * ⚠️ O `WcPollerService` saiu daqui em 04/09/2026 (enterro do Wincred, Onda 2):
 * o cron batia em `WC_URL` de minuto em minuto e já retornava na primeira
 * linha por `wordpressLegadoLigado()` desde que a KingHost foi desligada
 * (27/08). Com ele foram embora as importações de OrdersModule, QueueModule,
 * WebsocketModule, PilotModule e CustomersAppModule — nenhum provider deste
 * módulo injeta mais nada de lá, e a dependência circular
 * WooCommerce ⇄ Pilot morreu junto.
 *
 * O `WooCommerceService` FICA: oito módulos vivos ainda o injetam (orders,
 * pdv, pick-orders, pilot, trocas, wc-returns, customers) e desligar isso é
 * mudança de comportamento, não remoção de código morto.
 */
@Module({
  imports: [
    // timeout default: sem isto, várias chamadas (getOrder, updateOrder...) não
    // tinham timeout e um WP travado pendurava a request pra sempre. Escopado a
    // este módulo — não afeta o HttpService de outros módulos.
    HttpModule.register({ timeout: 15000 }),
  ],
  providers: [WooCommerceService],
  controllers: [WooCommerceController],
  exports: [WooCommerceService],
})
export class WooCommerceModule {}
