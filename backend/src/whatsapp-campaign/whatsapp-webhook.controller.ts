import { Body, Controller, Param, Post } from '@nestjs/common';
import { WhatsappInboxService } from './whatsapp-inbox.service';

/**
 * Endpoint PÚBLICO que o Evolution chama a CADA mensagem (webhook). Sem JWT —
 * é servidor-pra-servidor. Defesa: token opcional no caminho
 * (`WHATSAPP_WEBHOOK_TOKEN`); sem ele, aceita (o serviço já filtra 1:1 e ignora
 * o que não reconhece). Rota final: `/api/whatsapp-inbox/webhook[/<token>]`.
 */
@Controller('whatsapp-inbox/webhook')
export class WhatsappWebhookController {
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
    if (esperado && token !== esperado) return { ok: false };
    return this.service.receberWebhook(body);
  }
}
