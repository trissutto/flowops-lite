import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappIaService } from './whatsapp-ia.service';

/**
 * INBOX DE WHATSAPP — retaguarda (`/retaguarda/whatsapp-inbox`).
 * WhatsApp Web da instância dentro do FlowOps; celular fica na loja.
 */
@Controller('whatsapp-inbox')
@UseGuards(JwtAuthGuard)
export class WhatsappInboxController {
  constructor(
    private readonly service: WhatsappInboxService,
    private readonly ia: WhatsappIaService,
  ) {}

  /** Sugestão de resposta pela IA (Claude) — lê conversa + pedidos da cliente. */
  @Post('sugerir')
  sugerir(@Body() b: { jid: string }) {
    return this.ia.sugerir(b.jid);
  }

  /** Lista de conversas (mais recentes primeiro) — lê do nosso banco. */
  @Get('conversas')
  conversas() {
    return this.service.conversas();
  }

  /** Mensagens de uma conversa (por remoteJid). */
  @Get('mensagens')
  mensagens(@Query('jid') jid: string) {
    return this.service.mensagens(jid);
  }

  /** Responde a conversa. */
  @Post('responder')
  responder(@Body() b: { jid: string; texto: string }) {
    return this.service.responder(b.jid, b.texto);
  }

  /** Status do webhook (a instância está empurrando as mensagens pra nós?). */
  @Get('webhook-status')
  webhookStatus() {
    return this.service.statusWebhook();
  }

  /** Aponta o webhook do Evolution pra nós. `forcar` sobrescreve webhook de terceiro. */
  @Post('webhook-apontar')
  webhookApontar(@Body() b: { forcar?: boolean }) {
    return this.service.apontarWebhook(!!b?.forcar);
  }

  /** Importa o histórico do Evolution pro nosso banco (uma vez / sob demanda). */
  @Post('backfill')
  backfill(@Body() b: { limite?: number }) {
    return this.service.backfill(Number(b?.limite) || 200);
  }
}
