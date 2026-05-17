import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetaService } from './meta.service';

/**
 * InboxService — gerencia caixa de entrada do atendente humano.
 *
 * Lista conversas de DM Instagram agrupadas por cliente, permite ver
 * histórico completo de cada conversa, e permite que atendente humano
 * responda manualmente usando tag HUMAN_AGENT da Meta (estende janela
 * de mensagens de 24h pra 7 dias).
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaService,
  ) {}

  /**
   * Lista conversas com última mensagem + contagem de não lidas.
   * Agrupa por customer, ordena pela mais recente.
   */
  async listConversations(filter?: 'all' | 'pending' | 'beyond24h') {
    const conversations = await this.prisma.$queryRaw<any[]>`
      SELECT
        c.id              AS customer_id,
        c.name,
        c.ig_username,
        c.vip_tier,
        latest.body       AS last_message,
        latest.direction  AS last_direction,
        latest.created_at AS last_at,
        latest.channel,
        EXTRACT(EPOCH FROM (NOW() - latest.created_at)) / 3600 AS hours_ago,
        (
          SELECT COUNT(*)::int FROM dm_messages dm
          WHERE dm.customer_id = c.id
            AND dm.direction = 'in'
            AND dm.status != 'read'
        ) AS unread_count
      FROM customers c
      JOIN LATERAL (
        SELECT body, direction, created_at, channel
        FROM dm_messages
        WHERE customer_id = c.id
        ORDER BY created_at DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE c.ig_username IS NOT NULL
      ORDER BY latest.created_at DESC
      LIMIT 100
    `;

    if (filter === 'pending') {
      return conversations.filter((c) => c.last_direction === 'in');
    }
    if (filter === 'beyond24h') {
      return conversations.filter(
        (c) => c.last_direction === 'in' && Number(c.hours_ago) > 24,
      );
    }
    return conversations;
  }

  /**
   * Histórico completo de mensagens de uma conversa.
   */
  async getConversation(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) throw new NotFoundException('Cliente não encontrada');

    const messages = await this.prisma.dmMessage.findMany({
      where: { customerId },
      orderBy: { createdAt: 'asc' },
    });

    // Marca mensagens não lidas como lidas
    await this.prisma.dmMessage.updateMany({
      where: {
        customerId,
        direction: 'in',
        status: { not: 'read' },
      },
      data: { status: 'read' },
    });

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        igUsername: customer.igUsername,
        vipTier: customer.vipTier,
        sizeDefault: customer.sizeDefault,
      },
      messages: messages.map((m) => ({
        id: m.id,
        body: m.body,
        direction: m.direction,
        channel: m.channel,
        aiGenerated: m.aiGenerated,
        createdAt: m.createdAt,
        status: m.status,
      })),
    };
  }

  /**
   * Atendente humano responde manualmente.
   * Salva no banco + envia via Meta com tag HUMAN_AGENT (estende janela 7d).
   */
  async sendReply(input: {
    customerId: string;
    body: string;
    agentName?: string;
  }) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: input.customerId },
    });
    if (!customer) throw new NotFoundException('Cliente não encontrada');
    if (!customer.igUserId) {
      throw new NotFoundException('Cliente sem ig_user_id — não dá pra enviar DM');
    }

    // 1. Salva mensagem como "queued" enquanto envia
    const msg = await this.prisma.dmMessage.create({
      data: {
        customerId: customer.id,
        direction: 'out',
        channel: 'ig_direct',
        body: input.body,
        template: 'human_agent_reply',
        aiGenerated: false,
        status: 'queued',
      },
    });

    // 2. Envia via Meta Graph API com tag HUMAN_AGENT (estende janela 24h → 7d)
    const result = await this.meta.sendDirectMessage({
      recipientIgId: customer.igUserId,
      text: input.body,
    });

    // 3. Atualiza status
    await this.prisma.dmMessage.update({
      where: { id: msg.id },
      data: {
        status: result.error ? 'failed' : 'sent',
        error: result.error,
        igMessageId: result.id,
        sentAt: new Date(),
      },
    });

    this.logger.log(
      `[Inbox] Human Agent reply enviada — customer=@${customer.igUsername} agent=${input.agentName || 'unknown'} ${result.error ? `ERRO: ${result.error}` : 'OK'}`,
    );

    return {
      ok: !result.error,
      messageId: msg.id,
      error: result.error,
    };
  }
}
