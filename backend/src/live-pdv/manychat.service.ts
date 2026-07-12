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
    const first = await this.sendRaw(subscriberId, text);
    if (first.ok) return first;
    // Fora da janela de 24h da Meta ("Notification Reason") → retenta UMA vez
    // com a tag HUMAN_AGENT, que estende a janela do Instagram pra 7 DIAS.
    // Funciona se a conta ManyChat tem a permissão Human Agent (contas Pro
    // costumam ter); se a Meta recusar, devolve o erro original e a cliente
    // cai na fila manual (Direct/WhatsApp) como antes.
    if (/24 hour|notification reason/i.test(first.error || '')) {
      const tagged = await this.sendRaw(subscriberId, text, 'HUMAN_AGENT');
      if (tagged.ok) {
        this.logger.log(`[manychat] sub=${subscriberId} fora das 24h — entregue com HUMAN_AGENT (janela de 7 dias)`);
        return tagged;
      }
      return { ok: false, error: String(first.error || 'fora da janela de 24h').slice(0, 200) };
    }
    return first;
  }

  private async sendRaw(
    subscriberId: string,
    text: string,
    messageTag?: string,
  ): Promise<{ ok: boolean; error?: string }> {
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
          ...(messageTag ? { message_tag: messageTag } : {}),
        }),
      });
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok && data?.status === 'success') return { ok: true };
      const err =
        data?.message ||
        data?.details?.messages?.[0]?.message ||
        `HTTP ${resp.status}`;
      this.logger.warn(
        `[manychat] envio falhou sub=${subscriberId}${messageTag ? ` tag=${messageTag}` : ''}: ${JSON.stringify(data).slice(0, 300)}`,
      );
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

  // ═══════════ WHATSAPP (cobrança automática da live — 11/07) ═══════════
  // O número WhatsApp da conta é de API — todo envio sai por aqui. Fluxo:
  // acha/cria o assinante pelo TELEFONE → grava custom fields (nome, valor,
  // link do carrinho) → dispara o flow que contém o TEMPLATE de utilidade
  // aprovado pela Meta (o template lê os fields). flow_ns vem da env
  // MANYCHAT_COBRANCA_FLOW_NS (ManyChat → automação → ⋮ → Set Flow NS).

  private authHeaders() {
    const token = (process.env.MANYCHAT_API_TOKEN || '').trim();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  /** Acha assinante pelo telefone (E.164 sem +). Retorna id ou null. */
  async findSubscriberByPhone(phoneDigits: string): Promise<string | null> {
    try {
      const resp = await fetch(
        `${this.BASE}/fb/subscriber/findBySystemField?phone=${encodeURIComponent('+' + phoneDigits)}`,
        { headers: this.authHeaders() },
      );
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok && data?.status === 'success' && data?.data?.id) return String(data.data.id);
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Cria assinante de WhatsApp pelo telefone (opt-in: a cliente forneceu o
   * celular no cadastro da live pra ser contatada sobre a compra).
   */
  async createWhatsAppSubscriber(phoneDigits: string, nome?: string): Promise<{ id: string | null; error?: string }> {
    try {
      const partes = String(nome || '').trim().split(/\s+/);
      const resp = await fetch(`${this.BASE}/fb/subscriber/createSubscriber`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          whatsapp_phone: '+' + phoneDigits,
          first_name: partes[0] || undefined,
          last_name: partes.slice(1).join(' ') || undefined,
          has_opt_in_sms: true,
          consent_phrase: 'Cadastro na live (celular fornecido pra contato da compra)',
        }),
      });
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok && data?.status === 'success' && data?.data?.id) return { id: String(data.data.id) };
      return { id: null, error: (data?.message || `HTTP ${resp.status}`).slice(0, 200) };
    } catch (e: any) {
      return { id: null, error: e?.message || 'falha de rede' };
    }
  }

  /** Grava um custom field por NOME (o template do flow lê esses campos). */
  async setCustomFieldByName(subscriberId: string, fieldName: string, value: string): Promise<boolean> {
    try {
      const resp = await fetch(`${this.BASE}/fb/subscriber/setCustomFieldByName`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          subscriber_id: Number(subscriberId) || subscriberId,
          field_name: fieldName,
          field_value: value,
        }),
      });
      const data: any = await resp.json().catch(() => ({}));
      return resp.ok && data?.status === 'success';
    } catch {
      return false;
    }
  }

  /** Dispara um flow (que contém o template WhatsApp) pro assinante. */
  async sendFlow(subscriberId: string, flowNs: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const resp = await fetch(`${this.BASE}/fb/sending/sendFlow`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          subscriber_id: Number(subscriberId) || subscriberId,
          flow_ns: flowNs,
        }),
      });
      const data: any = await resp.json().catch(() => ({}));
      if (resp.ok && data?.status === 'success') return { ok: true };
      const err = data?.message || data?.details?.messages?.[0]?.message || `HTTP ${resp.status}`;
      this.logger.warn(`[manychat] sendFlow falhou sub=${subscriberId}: ${JSON.stringify(data).slice(0, 300)}`);
      return { ok: false, error: String(err).slice(0, 200) };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'falha de rede' };
    }
  }
}
