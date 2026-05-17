import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { InboxService } from './inbox.service';
import { MetaService } from './meta.service';

/**
 * /api/inbox — Caixa de entrada da equipe de atendimento humano.
 *
 * Telas:
 *  GET  /api/inbox/conversations              → lista de clientes com DMs
 *  GET  /api/inbox/conversations/:customerId  → histórico da conversa
 *  POST /api/inbox/conversations/:customerId/reply → atendente responde
 *
 * Esses endpoints alimentam a tela /retaguarda/inbox do flowops, usada
 * pela equipe de atendimento humano da Lurd's Plus Size pra responder
 * dúvidas de clientes que vêm via Instagram Direct dentro da janela
 * Human Agent (até 7 dias).
 */
@Controller('inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly meta: MetaService,
  ) {}

  // ─── Conta Instagram (instagram_business_basic) ─────────────
  @Get('instagram/account')
  async accountInfo() {
    return this.meta.getAccountInfo();
  }

  @Get('instagram/media')
  async recentMedia(@Query('limit') limit?: string) {
    return this.meta.getRecentMedia(limit ? Number(limit) : 12);
  }

  @Get('conversations')
  async listConversations(@Query('filter') filter?: string) {
    return this.inbox.listConversations(filter as any);
  }

  @Get('conversations/:customerId')
  async getConversation(@Param('customerId') customerId: string) {
    return this.inbox.getConversation(customerId);
  }

  @Post('conversations/:customerId/reply')
  async reply(
    @Param('customerId') customerId: string,
    @Body() body: { body: string; agentName?: string },
  ) {
    return this.inbox.sendReply({
      customerId,
      body: body.body,
      agentName: body.agentName,
    });
  }

  /**
   * SEED demo — popula 6 conversas pra videos da App Review.
   * Pode chamar pelo navegador (GET) ou via curl POST.
   */
  @Get('dev/seed')
  async seedGet() {
    return this.inbox.seedDemoData();
  }

  @Post('dev/seed')
  async seedPost() {
    return this.inbox.seedDemoData();
  }

  @Get('dev/seed-live')
  async seedLiveGet() {
    return this.inbox.seedLiveData();
  }

  @Post('dev/seed-live')
  async seedLivePost() {
    return this.inbox.seedLiveData();
  }
}
