import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EvolutionClient } from './evolution.client';

/**
 * INBOX DE WHATSAPP (dono, 15/08/2026) — WhatsApp Web da instância dentro do
 * FlowOps. O celular fica na loja; a operadora lê e responde do PC.
 *
 * Lê do Evolution (findChats/findMessages) e responde (sendText). O Evolution
 * guarda tudo, então não precisamos de banco: é uma janela pra ele.
 *
 * O mapeamento é DEFENSIVO de propósito: o formato de resposta do Evolution
 * muda entre versões (array cru, {records}, {messages:{records}}), então cada
 * campo tem plano B em vez de estourar.
 */
@Injectable()
export class WhatsappInboxService {
  private readonly logger = new Logger(WhatsappInboxService.name);

  constructor(private readonly evo: EvolutionClient) {}

  private toMs(v: any): number {
    if (!v) return 0;
    if (typeof v === 'string') {
      const n = Date.parse(v);
      return isNaN(n) ? 0 : n;
    }
    const n = Number(v);
    if (!n) return 0;
    return n < 1e12 ? n * 1000 : n; // segundos → ms
  }

  private textoDaMsg(m: any): string {
    const msg = m?.message || m || {};
    if (msg.conversation) return String(msg.conversation);
    if (msg.extendedTextMessage?.text) return String(msg.extendedTextMessage.text);
    if (msg.imageMessage) return '📷 Foto' + (msg.imageMessage.caption ? `: ${msg.imageMessage.caption}` : '');
    if (msg.videoMessage) return '🎬 Vídeo' + (msg.videoMessage.caption ? `: ${msg.videoMessage.caption}` : '');
    if (msg.audioMessage) return '🎤 Áudio';
    if (msg.documentMessage) return '📄 ' + (msg.documentMessage.fileName || 'Documento');
    if (msg.stickerMessage) return 'Figurinha';
    if (msg.locationMessage) return '📍 Localização';
    if (msg.contactMessage) return '👤 Contato';
    if (msg.reactionMessage) return `Reagiu ${msg.reactionMessage.text || ''}`.trim();
    return '';
  }

  async conversas() {
    if (!this.evo.configurado()) throw new BadRequestException('Evolution não configurado.');
    const raw = await this.evo.listarConversas();
    const arr: any[] = Array.isArray(raw) ? raw : raw?.chats || raw?.records || [];
    const lista = arr
      .map((c) => {
        const jid = c.remoteJid || c.id || c.jid || '';
        const numero = String(jid).split('@')[0];
        const last = c.lastMessage || c.last_message || null;
        return {
          jid,
          numero,
          nome: c.pushName || c.name || c.contact?.name || numero,
          texto: last ? this.textoDaMsg(last) : '',
          ts: this.toMs(c.updatedAt || last?.messageTimestamp || c.windowStart),
          fromMe: !!last?.key?.fromMe,
          naoLidas: Number(c.unreadMessages ?? c.unreadCount ?? 0),
        };
      })
      // 1:1 só (fora grupos @g.us e status)
      .filter((x) => x.jid.endsWith('@s.whatsapp.net'));
    lista.sort((a, b) => b.ts - a.ts);
    return lista.slice(0, 100);
  }

  async mensagens(jid: string) {
    if (!this.evo.configurado()) throw new BadRequestException('Evolution não configurado.');
    if (!jid) throw new BadRequestException('Conversa não informada.');
    const raw = await this.evo.listarMensagens(jid);
    const arr: any[] = Array.isArray(raw)
      ? raw
      : raw?.messages?.records || raw?.records || raw?.messages || [];
    const lista = arr
      .map((m) => ({
        id: m?.key?.id || null,
        fromMe: !!m?.key?.fromMe,
        texto: this.textoDaMsg(m),
        ts: this.toMs(m.messageTimestamp),
      }))
      .filter((m) => m.texto || m.id);
    lista.sort((a, b) => a.ts - b.ts);
    return lista.slice(-80);
  }

  async responder(jid: string, texto: string) {
    if (!this.evo.configurado()) throw new BadRequestException('Evolution não configurado.');
    const numero = String(jid || '').split('@')[0].replace(/\D/g, '');
    if (numero.length < 10) throw new BadRequestException('Conversa inválida.');
    if (!String(texto || '').trim()) throw new BadRequestException('Mensagem vazia.');
    await this.evo.enviarTexto(numero, texto);
    return { ok: true };
  }
}
