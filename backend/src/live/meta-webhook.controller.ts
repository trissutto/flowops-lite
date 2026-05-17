import {
  Body, Controller, Get, Headers, HttpCode, Logger, Post, Query, Req, UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { MetaService } from './meta.service';
import { CommentParserService } from './comment-parser.service';
import { ReservationService } from './reservation.service';
import { AiAgentService } from './ai-agent.service';
// @TODO_VALIDATE_VS_LOJA — caminho do Prisma
import { PrismaService } from '../prisma/prisma.service';
import { LiveBroadcasterService } from './live-broadcaster.service';

/**
 * Webhook receiver da Meta Graph API.
 *
 * GET  /webhooks/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 *   → handshake inicial. Retorna o challenge se token bate.
 *
 * POST /webhooks/meta
 *   → eventos (comments, live_comments, messages). HMAC obrigatório.
 *
 * Resposta tem que vir em < 5s ou Meta marca como falha e retira do feed.
 * Por isso processamos em "fire-and-forget" — schedula trabalho assíncrono
 * e responde 200 imediato.
 */
@Controller('webhooks/meta')
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly meta: MetaService,
    private readonly parser: CommentParserService,
    private readonly reservation: ReservationService,
    private readonly aiAgent: AiAgentService,
    private readonly prisma: PrismaService,
    private readonly broadcaster: LiveBroadcasterService,
  ) {}

  // ─────────── Verify (handshake inicial Meta) ───────────
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const expected = this.config.get<string>('META_VERIFY_TOKEN');
    if (mode === 'subscribe' && token === expected) {
      this.logger.log('Meta webhook handshake OK');
      return challenge;
    }
    throw new UnauthorizedException('verify_token inválido');
  }

  // ─────────── Eventos ───────────
  @Post()
  @HttpCode(200)
  async receive(
    @Headers('x-hub-signature-256') signature: string,
    @Req() req: any,
    @Body() body: any,
  ) {
    // 1. Validar HMAC
    this.validateSignature(signature, req.rawBody ?? JSON.stringify(body));

    // 2. Responder 200 imediato; trabalho roda em background
    this.handleAsync(body).catch((err) =>
      this.logger.error(`Erro processando webhook Meta: ${err?.message}`),
    );

    return { ok: true };
  }

  private validateSignature(signature: string, rawBody: string | Buffer) {
    const secret = this.config.get<string>('META_APP_SECRET');
    if (!secret) {
      this.logger.error('META_APP_SECRET não configurado');
      throw new UnauthorizedException();
    }
    if (!signature || !signature.startsWith('sha256=')) {
      throw new UnauthorizedException('signature ausente');
    }
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      )
    ) {
      throw new UnauthorizedException('signature inválida');
    }
  }

  private async handleAsync(payload: any) {
    if (payload.object !== 'instagram') {
      this.logger.warn(`Payload Meta não-Instagram: object=${payload.object}`);
      return;
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const field = change.field;
        const value = change.value ?? {};

        if (field === 'comments' || field === 'live_comments') {
          await this.handleComment(value, field === 'live_comments');
        } else if (field === 'messages') {
          await this.handleDirectMessage(value);
        } else {
          this.logger.debug(`Field Meta ignorado: ${field}`);
        }
      }
    }
  }

  private async handleComment(value: any, isLive: boolean) {
    const igCommentId = value.id;
    const text = value.text || value.message || '';
    const igUserId = value.from?.id;
    const igUsername = value.from?.username || 'desconhecida';
    const igMediaId = value.media?.id;

    if (!igCommentId || !text || !igUserId) {
      this.logger.warn(
        `Comentário Meta com payload incompleto: ${JSON.stringify(value)}`,
      );
      return;
    }

    // Dedup por ig_comment_id (unique index protege)
    const existing = await this.prisma.comment.findUnique({
      where: { igCommentId },
      select: { id: true },
    });
    if (existing) return;

    // Localiza live ativa pela media_id (fallback: única live com status='live')
    const live = igMediaId
      ? await this.prisma.live.findUnique({ where: { igMediaId } })
      : await this.prisma.live.findFirst({ where: { status: 'live' } });

    // ─── Sem live ativa → roteia pra "Lú Posts" ─────────────────────
    if (!live) {
      this.logger.log(
        `[Lú Posts] @${igUsername}: "${text}" (sem live ativa)`,
      );
      await this.aiAgent
        .replyToPostComment({ igCommentId, igUsername, question: text })
        .catch((err) =>
          this.logger.warn(`Lú Posts falhou: ${err?.message}`),
        );
      return;
    }

    // Find or create customer
    const customer = await this.prisma.customer.upsert({
      where: { igUserId },
      update: { igUsername },
      create: {
        igUserId,
        igUsername,
        name: igUsername, // placeholder até atendimento humano completar
      } as any,
      // @TODO_VALIDATE_VS_LOJA: modelo Customer pode ter mais campos
      // obrigatórios (cpf, email, etc.) que aqui são nullable. Se for o
      // caso, ajustar create acima.
    });

    // Produto ao vivo do momento — fonte de contexto pro parser
    const currentProduct = await this.prisma.liveProduct.findFirst({
      where: { liveId: live.id, isCurrent: true },
    });

    const parsed = await this.parser.parse(text, {
      liveId: live.id,
      currentRefCode: currentProduct?.refCode ?? null,
      aiFallbackEnabled: live.aiEnabled,
    });

    // Match produto: se parser encontrou refCode, busca o LiveProduct
    let matchedProduct = null as any;
    if (parsed.code) {
      matchedProduct = await this.prisma.liveProduct.findUnique({
        where: {
          liveId_refCode: { liveId: live.id, refCode: parsed.code },
        },
      });
    }
    if (!matchedProduct && parsed.intent === 'buy' && currentProduct) {
      matchedProduct = currentProduct;
    }

    const comment = await this.prisma.comment.create({
      data: {
        liveId: live.id,
        igCommentId,
        igUserId,
        igUsername,
        rawText: text,
        normalizedText: parsed.normalized,
        detectedIntent: parsed.intent,
        detectedCode: parsed.code ?? null,
        detectedSize: parsed.size ?? null,
        confidence: parsed.confidence as any,
        liveProductId: matchedProduct?.id ?? null,
        customerId: customer.id,
        processedAt: new Date(),
      },
    });

    this.broadcaster.emitNewComment(live.id, comment);

    // Reação automática conforme intenção
    if (parsed.intent === 'buy' && matchedProduct) {
      await this.reservation.tryCreateFromComment({
        liveId: live.id,
        liveProductId: matchedProduct.id,
        customerId: customer.id,
        commentId: comment.id,
        size: parsed.size ?? null,
      });
    } else if (
      live.aiEnabled &&
      ['size_query', 'price_query', 'fabric_query', 'color_query'].includes(
        parsed.intent ?? '',
      )
    ) {
      await this.aiAgent.replyToCommentInPublic({
        liveId: live.id,
        commentId: comment.id,
        igCommentId,
        productContext: matchedProduct ?? currentProduct ?? null,
        question: text,
      });
    }
  }

  private async handleDirectMessage(value: any) {
    // Estrutura Meta varia: usar value.sender, value.message, value.messages...
    // Por enquanto: registrar no banco e deixar pra atendente humano + IA
    this.logger.log(`DM recebida: ${JSON.stringify(value).slice(0, 200)}`);

    // @TODO V1.1: roteamento DM → IA Lú
  }
}
