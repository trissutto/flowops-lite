import { Injectable, Logger } from '@nestjs/common';

/**
 * Cliente do Evolution API (WhatsApp não-oficial) — configurado 100% por ENV,
 * pra não repetir o erro do n8n órfão: a chave mora no Railway, não numa
 * ferramenta que ninguém sabe mexer.
 *
 *   EVOLUTION_URL      — base do servidor (ex.: https://evo.seudominio/ )
 *   EVOLUTION_KEY      — apikey global (header `apikey`)
 *   EVOLUTION_INSTANCE — nome da instância conectada (ex.: "Atendimento")
 *
 * Sem as três, `configurado()` é false e a tela avisa "falta ligar a chave".
 */
@Injectable()
export class EvolutionClient {
  private readonly logger = new Logger(EvolutionClient.name);

  private get base(): string {
    return (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');
  }
  private get key(): string {
    return process.env.EVOLUTION_KEY || '';
  }
  get instancia(): string {
    return process.env.EVOLUTION_INSTANCE || '';
  }

  configurado(): boolean {
    return Boolean(this.base && this.key && this.instancia);
  }

  private async call(path: string, body: unknown): Promise<any> {
    if (!this.configurado()) throw new Error('Evolution não configurado (faltam EVOLUTION_URL/KEY/INSTANCE)');
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.key },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`Evolution ${res.status}: ${txt.slice(0, 200)}`);
    try {
      return JSON.parse(txt);
    } catch {
      return {};
    }
  }

  /** Confere se a instância está CONECTADA (não só configurada). */
  async instanciaConectada(): Promise<{ ok: boolean; estado?: string }> {
    try {
      const res = await fetch(
        `${this.base}/instance/connectionState/${encodeURIComponent(this.instancia)}`,
        { headers: { apikey: this.key } },
      );
      if (!res.ok) return { ok: false };
      const j: any = await res.json().catch(() => ({}));
      const estado = j?.instance?.state || j?.state;
      return { ok: estado === 'open', estado };
    } catch {
      return { ok: false };
    }
  }

  /** `number` = só dígitos com DDI (ex.: 5513999999999). */
  async enviarTexto(number: string, text: string): Promise<any> {
    return this.call(`/message/sendText/${encodeURIComponent(this.instancia)}`, { number, text });
  }

  async enviarImagem(number: string, url: string, caption = ''): Promise<any> {
    return this.call(`/message/sendMedia/${encodeURIComponent(this.instancia)}`, {
      number,
      mediatype: 'image',
      media: url,
      caption,
      fileName: 'foto.jpg',
    });
  }

  /** Conversas recentes da instância (findChats). */
  async listarConversas(): Promise<any> {
    return this.call(`/chat/findChats/${encodeURIComponent(this.instancia)}`, {});
  }

  /** Mensagens de uma conversa por remoteJid (findMessages). */
  async listarMensagens(remoteJid: string): Promise<any> {
    return this.call(`/chat/findMessages/${encodeURIComponent(this.instancia)}`, {
      where: { key: { remoteJid } },
    });
  }

  /** Marca a conversa como lida (opcional; falha não é fatal). */
  async marcarLida(remoteJid: string, messageId: string): Promise<any> {
    return this.call(`/chat/markMessageAsRead/${encodeURIComponent(this.instancia)}`, {
      readMessages: [{ remoteJid, fromMe: false, id: messageId }],
    });
  }

  // ── WEBHOOK (o Evolution EMPURRA as mensagens pra gente) ────────────
  // v2.3.7: corpo ANINHADO em {webhook:{...}}; a chave é `byEvents` (NÃO
  // `webhookByEvents`) — o nome antigo é ignorado em silêncio.

  /** Lê o webhook configurado da instância (GET /webhook/find). */
  async verificarWebhook(): Promise<any> {
    try {
      const res = await fetch(
        `${this.base}/webhook/find/${encodeURIComponent(this.instancia)}`,
        { headers: { apikey: this.key } },
      );
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  }

  /** Aponta o webhook da instância pra `url` com os eventos dados. */
  async configurarWebhook(url: string, events: string[]): Promise<any> {
    return this.call(`/webhook/set/${encodeURIComponent(this.instancia)}`, {
      webhook: { enabled: true, url, byEvents: false, base64: false, events },
    });
  }
}
