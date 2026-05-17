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

  // ═══════════════════════════════════════════════════════════════════════
  // SEED DE DEMO — popula 6 conversas pra usar nos vídeos da App Review
  // ═══════════════════════════════════════════════════════════════════════
  async seedDemoData() {
    this.logger.warn('[Inbox] SEED DEMO sendo executado…');

    // ─── Customers (6 personas) ─────────────────────────────────────
    const customers = [
      { id: 'cccccccc-1111-1111-1111-aaaaaaaaaaaa', name: 'Maria Aparecida', igUserId: 'ig_demo_2001', igUsername: 'maria.aparecida', vipTier: 'gold',    sizeDefault: '54', phone: '11999990001' },
      { id: 'cccccccc-2222-2222-2222-aaaaaaaaaaaa', name: 'Carla Mendes',    igUserId: 'ig_demo_2002', igUsername: 'carla.mendes',    vipTier: 'silver',  sizeDefault: '56', phone: '13988887777' },
      { id: 'cccccccc-3333-3333-3333-aaaaaaaaaaaa', name: 'Roberta Lima',    igUserId: 'ig_demo_2003', igUsername: 'roberta.lima_',   vipTier: 'bronze',  sizeDefault: '52', phone: '19977776666' },
      { id: 'cccccccc-4444-4444-4444-aaaaaaaaaaaa', name: 'Fernanda Costa',  igUserId: 'ig_demo_2004', igUsername: 'fer.costa',       vipTier: 'diamond', sizeDefault: '58', phone: '11944443333' },
      { id: 'cccccccc-5555-5555-5555-aaaaaaaaaaaa', name: 'Patricia Souza',  igUserId: 'ig_demo_2005', igUsername: 'paty_souza',      vipTier: 'gold',    sizeDefault: '54', phone: '15966665555' },
      { id: 'cccccccc-6666-6666-6666-aaaaaaaaaaaa', name: 'Juliana Alves',   igUserId: 'ig_demo_2006', igUsername: 'juju.alves',      vipTier: 'silver',  sizeDefault: '50', phone: '13977778888' },
    ];

    let customersCreated = 0;
    for (const c of customers) {
      try {
        await this.prisma.customer.upsert({
          where: { igUserId: c.igUserId },
          update: {
            name: c.name,
            vipTier: c.vipTier,
            sizeDefault: c.sizeDefault,
            phone: c.phone,
          },
          create: c as any,
        });
        customersCreated++;
      } catch (err: any) {
        this.logger.error(`Falha criando customer ${c.name}: ${err.message}`);
      }
    }

    // ─── Limpa dm_messages antigas dos 6 customers (idempotência) ───
    await this.prisma.dmMessage.deleteMany({
      where: {
        customerId: { in: customers.map((c) => c.id) },
      },
    });

    // ─── DMs com timestamps relativos ───────────────────────────────
    const now = Date.now();
    const minutes = (n: number) => new Date(now - n * 60 * 1000);
    const hours = (n: number) => new Date(now - n * 60 * 60 * 1000);
    const days = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000);

    const messages = [
      // Maria — 3 dias (Human Agent!)
      { customerId: customers[0].id, direction: 'in',  channel: 'ig_direct', body: 'Oi! Tô interessada na calça 205. Vocês tem no 54? Tenho 92kg, será que vai servir?', aiGenerated: false, status: 'delivered', createdAt: days(3) },
      { customerId: customers[0].id, direction: 'in',  channel: 'ig_direct', body: 'Outra coisa, tem desconto pra primeira compra?', aiGenerated: false, status: 'delivered', createdAt: new Date(days(3).getTime() + 2 * 60 * 1000) },
      // Carla — 2 dias (Human Agent!)
      { customerId: customers[1].id, direction: 'in',  channel: 'ig_direct', body: 'Boa tarde! Meu pedido #45678 já saiu pra entrega? Faz 5 dias que comprei.', aiGenerated: false, status: 'delivered', createdAt: days(2) },
      // Roberta — 5h
      { customerId: customers[2].id, direction: 'in',  channel: 'ig_direct', body: 'Amei o vestido que recebi ontem!! 😍 Vocês tem o mesmo modelo em outra cor?', aiGenerated: false, status: 'delivered', createdAt: hours(5) },
      { customerId: customers[2].id, direction: 'in',  channel: 'ig_direct', body: 'Mandei foto no story marcando vocês ❤️', aiGenerated: false, status: 'delivered', createdAt: hours(4) },
      // Fernanda VIP Diamond — conversa ativa
      { customerId: customers[3].id, direction: 'in',  channel: 'ig_direct', body: 'Oi Lurds! Posso reservar 3 peças pra eu provar na loja de Moema sábado?', aiGenerated: false, status: 'delivered', createdAt: hours(2) },
      { customerId: customers[3].id, direction: 'out', channel: 'ig_direct', body: 'Oi Fernanda! 💖 Claro que pode, como cliente Diamond você tem prioridade. Me manda os códigos das peças que reservo na hora ✨', aiGenerated: false, status: 'sent', createdAt: minutes(110), sentAt: minutes(110) },
      { customerId: customers[3].id, direction: 'in',  channel: 'ig_direct', body: '205, 312 e 528 — todos no 58. Pode ser?', aiGenerated: false, status: 'delivered', createdAt: minutes(30) },
      // Patricia — 4 dias (Human Agent!)
      { customerId: customers[4].id, direction: 'in',  channel: 'ig_direct', body: 'Bom dia! Tem loja em São José dos Campos? Vou tar aí no fim de semana 🙌', aiGenerated: false, status: 'delivered', createdAt: days(4) },
      // Juliana — 18h
      { customerId: customers[5].id, direction: 'in',  channel: 'ig_direct', body: 'Comprei a blusa floral ontem na loja, ela pode ser usada na máquina ou só lavagem a mão?', aiGenerated: false, status: 'delivered', createdAt: hours(18) },
    ];

    let messagesCreated = 0;
    for (const m of messages) {
      try {
        await this.prisma.dmMessage.create({ data: m as any });
        messagesCreated++;
      } catch (err: any) {
        this.logger.error(`Falha criando mensagem: ${err.message}`);
      }
    }

    this.logger.warn(
      `[Inbox] SEED concluído — customers=${customersCreated} messages=${messagesCreated}`,
    );

    return { customersCreated, messagesCreated };
  }

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
