import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/**
 * MetaService — cliente HTTP para Graph API do Instagram.
 *
 * Responsabilidades:
 *  - Enviar mensagem privada (DM) na janela 24h
 *  - Responder comentário público
 *  - Buscar informações da live (media_id)
 *  - Rate limit interno (80 req/min como margem segura — Meta permite 100)
 *
 * NÃO faz: validação de webhook (isso é no controller),
 * persistência (controllers e services chamam).
 */
@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);
  private readonly graphBase = 'https://graph.facebook.com/v19.0';

  // Token bucket simples
  private tokens = 80;
  private lastRefill = Date.now();
  private readonly maxTokens = 80;
  private readonly refillPerMs = 80 / 60_000; // 80 por minuto

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  private get pageToken(): string | null {
    const t = this.config.get<string>('META_PAGE_ACCESS_TOKEN');
    return t && t.trim() ? t.trim() : null;
  }

  private get igUserId(): string | null {
    const v = this.config.get<string>('META_IG_USER_ID');
    return v && v.trim() ? v.trim() : null;
  }

  isConfigured(): boolean {
    return !!this.pageToken && !!this.igUserId;
  }

  /**
   * Busca dados básicos da conta Instagram conectada via Graph API.
   * Demonstra o uso da permissão `instagram_business_basic`.
   */
  async getAccountInfo(): Promise<any> {
    if (!this.isConfigured()) return { error: 'Meta não configurada' };
    await this.acquireToken();
    const fields =
      'id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website';
    const url = `${this.graphBase}/${this.igUserId}?fields=${fields}`;
    try {
      const resp = await firstValueFrom(
        this.http.get(url, {
          params: { access_token: this.pageToken },
          timeout: 10_000,
        }),
      );
      return resp.data;
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      this.logger.error(`getAccountInfo falhou: ${msg}`);
      return { error: msg };
    }
  }

  /**
   * Lista as últimas mídias (posts/reels) da conta.
   */
  async getRecentMedia(limit = 12): Promise<any> {
    if (!this.isConfigured()) return { error: 'Meta não configurada' };
    await this.acquireToken();
    const fields =
      'id,media_type,caption,permalink,media_url,thumbnail_url,timestamp,like_count,comments_count';
    const url = `${this.graphBase}/${this.igUserId}/media?fields=${fields}&limit=${limit}`;
    try {
      const resp = await firstValueFrom(
        this.http.get(url, {
          params: { access_token: this.pageToken },
          timeout: 10_000,
        }),
      );
      return resp.data;
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      this.logger.error(`getRecentMedia falhou: ${msg}`);
      return { error: msg };
    }
  }

  private async acquireToken(): Promise<void> {
    // Refill baseado em tempo
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillPerMs,
    );
    this.lastRefill = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Espera até liberar
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise((r) => setTimeout(r, waitMs));
    return this.acquireToken();
  }

  /**
   * Envia DM ao usuário Instagram. Respeita janela 24h da Meta — quem chama
   * deve garantir isso (cliente interagiu < 24h).
   */
  async sendDirectMessage(opts: {
    recipientIgId: string;
    text: string;
  }): Promise<{ id?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { error: 'Meta não configurada' };
    }
    await this.acquireToken();

    const url = `${this.graphBase}/${this.igUserId}/messages`;
    try {
      const resp = await firstValueFrom(
        this.http.post(
          url,
          {
            recipient: { id: opts.recipientIgId },
            message: { text: opts.text },
            messaging_type: 'RESPONSE',
          },
          {
            params: { access_token: this.pageToken },
            timeout: 15_000,
          },
        ),
      );
      return { id: resp.data?.message_id ?? resp.data?.recipient_id };
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || err.message || 'erro Meta';
      this.logger.error(`sendDirectMessage falhou: ${msg}`);
      return { error: msg };
    }
  }

  /**
   * Responde comentário público no Instagram (na thread).
   */
  async replyToComment(opts: {
    igCommentId: string;
    text: string;
  }): Promise<{ id?: string; error?: string }> {
    if (!this.isConfigured()) return { error: 'Meta não configurada' };
    await this.acquireToken();

    const url = `${this.graphBase}/${opts.igCommentId}/replies`;
    try {
      const resp = await firstValueFrom(
        this.http.post(
          url,
          { message: opts.text },
          {
            params: { access_token: this.pageToken },
            timeout: 15_000,
          },
        ),
      );
      return { id: resp.data?.id };
    } catch (err: any) {
      const msg =
        err.response?.data?.error?.message || err.message || 'erro Meta';
      this.logger.error(`replyToComment falhou: ${msg}`);
      return { error: msg };
    }
  }

  /**
   * Esconde / mostra comentário (moderação).
   */
  async hideComment(igCommentId: string, hide: boolean) {
    if (!this.isConfigured()) return { error: 'Meta não configurada' };
    await this.acquireToken();
    const url = `${this.graphBase}/${igCommentId}`;
    try {
      await firstValueFrom(
        this.http.post(
          url,
          { hide },
          { params: { access_token: this.pageToken } },
        ),
      );
      return { ok: true };
    } catch (err: any) {
      return { error: err.message };
    }
  }
}
