import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionClient } from './evolution.client';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappIaService } from './whatsapp-ia.service';

/**
 * AUTO-RESPOSTA da Lulú (dono, 16/08): a IA responde SOZINHA no WhatsApp, com
 * trava dura. Kill-switch por env `WHATSAPP_AUTO_REPLY`:
 *   off (padrão) · fora (só fora do horário da loja) · sempre.
 *
 * Arquitetura por CRON (não no webhook) — igual ao reconcile da Live: dá o
 * DEBOUNCE natural (só age quando a cliente para de digitar) e não trava o
 * caminho da mensagem. Travas:
 *  - só conversa cuja ÚLTIMA mensagem é da CLIENTE (ninguém — humano ou IA —
 *    respondeu ainda; `fromMe=false` na conversa);
 *  - janela: chegou entre 45s e 30min atrás (espera a rajada; ignora antigo);
 *  - cooldown: nada de 2ª auto-resposta na mesma conversa em 20min (sem ping-pong);
 *  - a própria IA decide se responde (REGRAS_AUTO: só o simples e seguro);
 *  - tudo gravado como `tipo:'auto-ia'` → aparece no inbox com tarja.
 */
@Injectable()
export class WhatsappAutoReplyService {
  private readonly logger = new Logger(WhatsappAutoReplyService.name);
  private rodando = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evo: EvolutionClient,
    private readonly inbox: WhatsappInboxService,
    private readonly ia: WhatsappIaService,
  ) {}

  private p(): any {
    return this.prisma as any;
  }

  private modo(): 'off' | 'fora' | 'sempre' {
    const v = String(process.env.WHATSAPP_AUTO_REPLY || 'off').toLowerCase();
    return v === 'fora' || v === 'sempre' ? v : 'off';
  }

  /** Loja aberta AGORA (Brasília)? Seg–Sáb, faixa LOJA_ABRE..LOJA_FECHA (9..18). */
  private lojaAberta(): boolean {
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date());
    const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
    const dia = partes.find((p) => p.type === 'weekday')?.value ?? '';
    const abre = Number(process.env.LOJA_ABRE ?? '9');
    const fecha = Number(process.env.LOJA_FECHA ?? '18');
    if (dia === 'Sun') return false;
    return hora >= abre && hora < fecha;
  }

  @Cron('15 * * * * *', { name: 'wa-auto-reply' })
  async ciclo() {
    const modo = this.modo();
    if (modo === 'off' || !this.evo.configurado() || this.rodando) return;
    const fora = !this.lojaAberta();
    if (modo === 'fora' && !fora) return; // dentro do horário: humanos atendem

    this.rodando = true;
    try {
      const agora = Date.now();
      const desde = new Date(agora - 30 * 60 * 1000); // não mexe em conversa velha
      const ate = new Date(agora - 45 * 1000); // espera 45s (rajada)
      const convs = await this.p().whatsappConversation.findMany({
        where: { fromMe: false, ultimaEm: { gte: desde, lte: ate } },
        orderBy: { ultimaEm: 'desc' },
        take: 10,
      });
      if (!convs.length) return;

      for (const c of convs) {
        try {
          // Cooldown: já respondeu no automático nos últimos 20min? Pula (sem loop).
          const jaAuto = await this.p().whatsappMessage.findFirst({
            where: { conversationJid: c.jid, tipo: 'auto-ia', ts: { gte: new Date(agora - 20 * 60 * 1000) } },
          });
          if (jaAuto) continue;

          const dec = await this.ia.decidirAutoResposta(c.jid, { fora });
          if (!dec.responder || !dec.resposta.trim()) {
            this.logger.log(`[wa-auto] ${c.numero}: NÃO respondeu — ${dec.motivo}`);
            continue;
          }
          await this.inbox.responder(c.jid, dec.resposta.trim(), 'auto-ia');
          this.logger.log(`[wa-auto] ${c.numero}: Lulú respondeu (fora=${fora}) — ${dec.motivo}`);
        } catch (e: any) {
          this.logger.warn(`[wa-auto] ${c.jid} falhou: ${e?.message || e}`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[wa-auto] ciclo falhou: ${e?.message || e}`);
    } finally {
      this.rodando = false;
    }
  }
}
