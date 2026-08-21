import { Controller, Get, HttpException, Param, Req } from '@nestjs/common';
import { PagbankService } from './pagbank.service';

/**
 * Controller PÚBLICO (SEM JwtAuthGuard) do link de PIX da venda online.
 *
 * A loja manda `/qr/<token>` pra cliente em vez do copia-e-cola cru. O EMV
 * da PagBank carrega uma URL no meio (api.pagseguro.com/pix/v2/...) que o
 * WhatsApp pinta de azul — a cliente toca no azul em vez de copiar o código
 * inteiro e o pagamento não sai (caso Itanhaém 21/08). No link curto, tocar
 * é o caminho certo: a página mostra QR + botão "Copiar código PIX".
 *
 * Segurança: token com 10 chars sorteados (não dá pra enumerar) e a resposta
 * só expõe valor, QR e nome/WhatsApp da loja — nada de CPF, telefone da
 * cliente ou itens. Rate limit por IP porque a rota é aberta.
 *
 * O teto é mais alto que o do pagar-link porque esta página FICA ABERTA
 * fazendo polling (10s) até o pagamento cair — e o polling bate SÓ no nosso
 * Postgres, nunca na PagBank (lição da live de 01/07).
 */
@Controller('public/pix')
export class PixLinkPublicController {
  constructor(private readonly pagbank: PagbankService) {}

  private static readonly RL_WINDOW_MS = 5 * 60_000;
  // Cada página aberta consome ~30/5min (polling de 10s) e operadora móvel
  // agrupa MUITAS clientes atrás do mesmo IP (CGNAT) — teto baixo daria 429
  // pra cliente inocente. O custo por request é um findUnique no Postgres.
  private static readonly RL_MAX = 200;
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
      this.rlHits.set(ip, { n: 1, resetAt: now + PixLinkPublicController.RL_WINDOW_MS });
      return;
    }
    cur.n += 1;
    if (cur.n > PixLinkPublicController.RL_MAX) {
      throw new HttpException('Muitas tentativas. Espera uns minutinhos 💜', 429);
    }
  }

  @Get(':token')
  async estado(@Param('token') token: string, @Req() req: any) {
    this.throttle(req);
    return this.pagbank.estadoDoPix(token);
  }
}
