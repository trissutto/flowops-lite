import { Controller, Get, HttpException, Param, Req } from '@nestjs/common';
import { PagarmeService } from './pagarme.service';

/**
 * Controller PÚBLICO (SEM JwtAuthGuard) do link de pagamento da loja.
 *
 * A loja manda `/pg/<token>` pra cliente em vez da URL crua da Pagar.me. A
 * URL deles é de USO ÚNICO: paga, cancelada ou vencida, o checkout some e a
 * cliente vê "Oops — não encontramos seu pedido · 404", sem saber se pagou e
 * sem ninguém pra falar (caso Moema 15/08: link pago no dia anterior,
 * reaberto no outro dia).
 *
 * Aqui o link nunca morre calado: válido redireciona, pago mostra a
 * confirmação, vencido oferece o WhatsApp da loja pra pedir outro.
 *
 * Segurança: o token tem 10 chars sorteados (não dá pra enumerar) e a resposta
 * só expõe valor, nome da loja e WhatsApp — nada de CPF, telefone da cliente
 * ou itens. Rate limit por IP porque a rota é aberta.
 */
@Controller('public/pagar-link')
export class PagamentoLinkPublicController {
  constructor(private readonly pagarme: PagarmeService) {}

  private static readonly RL_WINDOW_MS = 5 * 60_000;
  private static readonly RL_MAX = 30;
  private readonly rlHits = new Map<string, { n: number; resetAt: number }>();

  private throttle(req: any): void {
    const ip =
      String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
      String(req?.ip || 'desconhecido');
    const now = Date.now();
    if (this.rlHits.size > 5000) {
      for (const [k, v] of this.rlHits) if (v.resetAt < now) this.rlHits.delete(k);
    }
    const cur = this.rlHits.get(ip);
    if (!cur || cur.resetAt < now) {
      this.rlHits.set(ip, { n: 1, resetAt: now + PagamentoLinkPublicController.RL_WINDOW_MS });
      return;
    }
    cur.n += 1;
    if (cur.n > PagamentoLinkPublicController.RL_MAX) {
      throw new HttpException('Muitas tentativas. Espera uns minutinhos 💜', 429);
    }
  }

  @Get(':token')
  async estado(@Param('token') token: string, @Req() req: any) {
    this.throttle(req);
    return this.pagarme.estadoDoLink(token);
  }
}
