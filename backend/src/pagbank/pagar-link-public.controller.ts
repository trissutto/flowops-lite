import { Body, Controller, Get, HttpException, Param, Post, Req } from '@nestjs/common';
import { PagbankService } from './pagbank.service';

/**
 * Controller PÚBLICO (SEM JwtAuthGuard) da página `/pague/<token>` — o link
 * de pagamento do PDV pelo PagBank (21/09/2026). Régua e história em
 * `common/link-pagamento-pagbank.ts`.
 *
 * A cliente abre o link que a loja mandou no WhatsApp e paga por PIX ou
 * cartão. O cartão chega CRIPTOGRAFADO pelo SDK do PagBank no navegador dela:
 * número e CVV nunca passam pelo nosso servidor.
 *
 * Segurança de página aberta:
 *  - token com 10 chars sorteados (não dá pra enumerar);
 *  - a resposta só expõe valor, loja e o QR — nada de CPF, telefone, e-mail
 *    ou itens da cliente;
 *  - teto de tentativas de cartão POR VENDA e uma cobrança em voo por venda
 *    (no service);
 *  - rate limit por IP aqui, com teto próprio pro cartão — o ataque de 28/08
 *    no site testou ~650 cartões numa noite.
 *
 * O estado (GET) é polling da página: lê SÓ o nosso Postgres, nunca o PagBank
 * ao vivo (lição da live de 01/07).
 */
@Controller('public/pague')
export class PagarLinkPublicController {
  constructor(private readonly pagbank: PagbankService) {}

  private static readonly RL_WINDOW_MS = 5 * 60_000;
  /** Polling de 10s ≈ 30/5min por página; CGNAT junta muita gente num IP. */
  private static readonly RL_ESTADO = 200;
  private static readonly RL_PIX = 20;
  private static readonly RL_CARTAO = 8;
  private readonly rlHits = new Map<string, { n: number; resetAt: number }>();

  private throttle(req: any, balde: 'estado' | 'pix' | 'cartao', max: number): void {
    const ip =
      String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
      String(req?.ip || 'desconhecido');
    const chave = `${balde}:${ip}`;
    const now = Date.now();
    if (this.rlHits.size > 5000) {
      for (const [k, v] of this.rlHits) if (v.resetAt < now) this.rlHits.delete(k);
    }
    const cur = this.rlHits.get(chave);
    if (!cur || cur.resetAt < now) {
      this.rlHits.set(chave, { n: 1, resetAt: now + PagarLinkPublicController.RL_WINDOW_MS });
      return;
    }
    cur.n += 1;
    if (cur.n > max) {
      throw new HttpException('Muitas tentativas. Espera uns minutinhos 💜', 429);
    }
  }

  @Get(':token')
  async estado(@Param('token') token: string, @Req() req: any) {
    this.throttle(req, 'estado', PagarLinkPublicController.RL_ESTADO);
    return this.pagbank.estadoDoLinkPublico(token);
  }

  @Post(':token/pix')
  async pix(@Param('token') token: string, @Req() req: any) {
    this.throttle(req, 'pix', PagarLinkPublicController.RL_PIX);
    return this.pagbank.pixDoLinkPublico(token);
  }

  @Post(':token/cartao')
  async cartao(
    @Param('token') token: string,
    @Req() req: any,
    @Body()
    body: {
      cardEncrypted?: string;
      holderName?: string;
      holderCpf?: string;
      installments?: number;
      email?: string;
      phone?: string;
    },
  ) {
    this.throttle(req, 'cartao', PagarLinkPublicController.RL_CARTAO);
    return this.pagbank.cartaoDoLinkPublico(token, body || {});
  }
}
