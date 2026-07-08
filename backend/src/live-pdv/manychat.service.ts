import { BadRequestException, Injectable, Logger } from '@nestjs/common';

/**
 * Cliente mínimo da API do ManyChat — envio de DM (Instagram) pra assinante.
 *
 * Token via env MANYCHAT_API_TOKEN (painel ManyChat → Configurações → API).
 * Sem a env, o envio automático fica desligado (a fila manual segue normal).
 *
 * Janela de 24h da Meta: o ManyChat só entrega DM pra quem interagiu nas
 * últimas 24h — quem comentou CARRINHO durante a live está dentro.
 */
@Injectable()
export class ManychatService {
  private readonly logger = new Logger(ManychatService.name);
  private readonly BASE = 'https://api.manychat.com';

  get enabled(): boolean {
    return !!(process.env.MANYCHAT_API_TOKEN || '').trim();
  }

  async sendText(subscriberId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const token = (process.env.MANYCHAT_API_TOKEN || '').trim();
    if (!token) {
      throw new BadRequestException(
        'Envio automático não configurado — crie a env MANYCHAT_API_TOKEN no Railway.',
      );
    }
    try {
      const resp = await fetch(`${this.BASE}/fb/sending/sendContent`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subscriber_id: Number(subscriberId) || subscriberId,
          data: {
            version: 'v2',
            content: {
              type: 'instagram',
              messages: [{ type: 'text', text }],
            },
          },
        }),
      });
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok && data?.status === 'success') return { ok: true };
      const err =
        data?.message ||
        data?.details?.messages?.[0]?.message ||
        `HTTP ${resp.status}`;
      this.logger.warn(`[manychat] envio falhou sub=${subscriberId}: ${JSON.stringify(data).slice(0, 300)}`);
      return { ok: false, error: String(err).slice(0, 200) };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'falha de rede' };
    }
  }

  /**
   * Busca assinantes por nome (API oficial). Retorna a lista crua — cada item
   * traz id, name e ig_username (contas Instagram). Usado pelo backfill que
   * casa carrinho ↔ assinante pelo @ (o ManyChat não exporta contatos em CSV).
   */
  async findSubscribersByName(name: string): Promise<any[]> {
    const token = (process.env.MANYCHAT_API_TOKEN || '').trim();
    const q = String(name || '').trim();
    if (!token || q.length < 2) return [];
    try {
      const resp = await fetch(
        `${this.BASE}/fb/subscriber/findByName?name=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok && data?.status === 'success' && Array.isArray(data.data)) return data.data;
      return [];
    } catch {
      return [];
    }
  }
}
