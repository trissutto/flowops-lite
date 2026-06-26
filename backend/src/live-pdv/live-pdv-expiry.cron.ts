import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LivePdvService } from './live-pdv.service';

/**
 * Cron de expiração de reservas da Live PDV.
 *
 * POLÍTICA (pedido do dono, 2026-06-25): reservas da Live NÃO expiram mais
 * automaticamente. Os itens ficam no carrinho ATÉ INTERVENÇÃO HUMANA — a
 * operadora exclui o carrinho (botão 🗑) ou cancela o item. A auto-expiração
 * por TTL está DESLIGADA. O método svc.expireReservations() segue existindo
 * pra uma eventual limpeza manual; basta reativar a chamada abaixo pra voltar.
 */
@Injectable()
export class LivePdvExpiryCron {
  private readonly logger = new Logger(LivePdvExpiryCron.name);

  constructor(private readonly svc: LivePdvService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handle() {
    // DESATIVADO — reservas só saem por ação humana. Pra reativar a expiração
    // automática por TTL, descomente o bloco abaixo.
    // try {
    //   await this.svc.expireReservations();
    // } catch (e) {
    //   this.logger.warn(`expireReservations falhou: ${(e as Error).message}`);
    // }
    return;
  }
}
