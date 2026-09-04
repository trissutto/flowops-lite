import { Controller, Post, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';

/**
 * MUSEU (04/09/2026) — o que sobrou da entrada de pedidos do WooCommerce.
 *
 * O WordPress/WooCommerce legado morava na KingHost, desligada em 27/08/2026.
 * Com ele foram embora as DUAS portas de entrada de pedido:
 *
 *  • `WcPollerService` — cron de 1 em 1 minuto batendo em `WC_URL`. Já saía na
 *    primeira linha por `wordpressLegadoLigado()` desde 27/08; agora saiu do
 *    código.
 *  • `POST /webhooks/woocommerce` — o webhook do site velho. Ninguém do outro
 *    lado existe pra assinar o HMAC, e nenhuma tela do Flow chamava a rota.
 *
 * `POST /orders/poll-now` FICA porque a tela `/visao-geral` ainda tem o botão
 * "buscar pedidos agora" e uma rota removida vira tela quebrada. A resposta é
 * a MESMA que ela já recebia desde 27/08 — o poller retornava na hora, sem
 * buscar nada.
 */
@Controller()
export class WooCommerceController {
  @Post('orders/poll-now')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async pollNow() {
    return { ok: true, at: new Date().toISOString() };
  }
}
