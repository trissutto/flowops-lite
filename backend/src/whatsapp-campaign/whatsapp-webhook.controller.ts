import { Body, Controller, Logger, Param, Post } from '@nestjs/common';
import { WhatsappInboxService } from './whatsapp-inbox.service';

/**
 * Endpoint PÚBLICO que o Evolution chama a CADA mensagem (webhook). Sem JWT —
 * é servidor-pra-servidor, então tem auth PRÓPRIA (revisão adversarial 16/08):
 * aceita só se vier o token da URL (`WHATSAPP_WEBHOOK_TOKEN`) OU o `apikey` do
 * Evolution no corpo == `EVOLUTION_KEY`. Sem isso, um POST forjado poderia
 * plantar mensagem/instrução no inbox e fazer a conta da loja mandar mensagem
 * pra número arbitrário (via auto-resposta). Rota: `/api/whatsapp-inbox/webhook[/<token>]`.
 */
@Controller('whatsapp-inbox/webhook')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);
  private avisou = false;

  constructor(private readonly service: WhatsappInboxService) {}

  @Post()
  raiz(@Body() body: any) {
    return this.processar(undefined, body);
  }

  @Post(':token')
  comToken(@Param('token') token: string, @Body() body: any) {
    return this.processar(token, body);
  }

  private processar(token: string | undefined, body: any) {
    const esperado = process.env.WHATSAPP_WEBHOOK_TOKEN || '';
    const evoKey = process.env.EVOLUTION_KEY || '';
    const porToken = !!esperado && token === esperado;
    const porApikey = !!evoKey && body?.apikey === evoKey;

    if (esperado || evoKey) {
      // Auth configurada → EXIGE (token da URL OU apikey do Evolution no corpo).
      if (!porToken && !porApikey) return { ok: false };
    } else if (!this.avisou) {
      // Nenhuma auth possível (nem token nem chave) — fail-open, mas avisa uma vez.
      this.avisou = true;
      this.logger.warn('[wa-webhook] SEM auth (defina WHATSAPP_WEBHOOK_TOKEN) — endpoint aberto');
    }
    return this.service.receberWebhook(body);
  }
}
