import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { WhatsappInboxService } from './whatsapp-inbox.service';

/**
 * INBOX DE WHATSAPP — retaguarda (`/retaguarda/whatsapp-inbox`).
 * WhatsApp Web da instância dentro do FlowOps; celular fica na loja.
 */
@Controller('whatsapp-inbox')
@UseGuards(JwtAuthGuard)
export class WhatsappInboxController {
  constructor(private readonly service: WhatsappInboxService) {}

  /** Lista de conversas (mais recentes primeiro). */
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
}
