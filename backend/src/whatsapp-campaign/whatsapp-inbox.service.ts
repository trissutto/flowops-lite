import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
  private cacheConversas: { at: number; data: any[] } | null = null;

  constructor(
    private readonly evo: EvolutionClient,
    private readonly prisma: PrismaService,
  ) {}

  /** Status de leitura da msg (só interessa nas que a LOJA mandou). */
  private statusDe(m: any): string {
    const s = String(m?.status || m?.key?.status || '').toUpperCase();
    if (s.includes('READ') || s.includes('PLAYED')) return 'lido';
    if (s.includes('DELIVERY')) return 'entregue';
    if (s) return 'enviado';
    return '';
  }

  /** Enriquece os números com o NOME do nosso CRM (pelo telefone). */
  private async nomesDoCrm(numeros: string[]): Promise<Record<string, string>> {
    const l8s = [...new Set(numeros.map((n) => n.slice(-8)).filter((x) => x.length === 8))];
    if (!l8s.length) return {};
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ l8: string; name: string }>>(
        `SELECT RIGHT(regexp_replace(COALESCE(whatsapp, phone, ''), '\\D', '', 'g'), 8) l8, name
           FROM "customers"
          WHERE name IS NOT NULL
            AND RIGHT(regexp_replace(COALESCE(whatsapp, phone, ''), '\\D', '', 'g'), 8) = ANY($1::text[])`,
        l8s,
      );
      const map: Record<string, string> = {};
      for (const r of rows) if (r.l8 && r.name && !map[r.l8]) map[r.l8] = r.name.trim();
      return map;
    } catch (e: any) {
      this.logger.warn(`[wa-inbox] falha ao cruzar nomes do CRM: ${e?.message || e}`);
      return {};
    }
  }

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
    // CACHE curto (dono, 15/08): o findChats do Evolution devolve a lista
    // INTEIRA (25 mil+ contatos), lento. O poll de 12s da tela quase sempre
    // bate no cache — carrega na hora depois da 1ª vez.
    if (this.cacheConversas && Date.now() - this.cacheConversas.at < 15000) {
      return this.cacheConversas.data;
    }
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
    const top = lista.slice(0, 100);
    // NOME DO CRM (dono, 15/08): o WhatsApp mostra só o número quando o contato
    // não está salvo — mas a gente TEM o nome no CRM pelo telefone.
    const nomes = await this.nomesDoCrm(top.map((c) => c.numero));
    for (const c of top) {
      const doCrm = nomes[c.numero.slice(-8)];
      if (doCrm) c.nome = doCrm;
    }
    this.cacheConversas = { at: Date.now(), data: top };
    return top;
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
        status: m?.key?.fromMe ? this.statusDe(m) : '',
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
