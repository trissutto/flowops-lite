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
    });
  }
}
