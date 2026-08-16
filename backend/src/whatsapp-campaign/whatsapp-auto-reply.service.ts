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
  /** jid → ultimaEm(ms) já avaliado. Evita re-chamar o Claude pro MESMO estado
   *  (inclusive quando a IA recusa — a conversa recusada não muda fromMe). */
  private avaliadas = new Map<string, number>();
  /** jid → ts da última chamada à IA. Throttle: no máx 1 chamada / 90s por conversa
   *  (mesmo que a cliente mande várias mensagens novas seguidas). */
  private ultimaChamadaIA = new Map<string, number>();

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

  /**
   * Loja aberta AGORA (Brasília)? Janela global conservadora: Seg–Sex
   * LOJA_ABRE..LOJA_FECHA (9..18), Sáb LOJA_ABRE..LOJA_FECHA_SAB (9..13), Dom
   * fechado. É só o gate do modo 'fora'; horário fino por loja está em lojas-info.
   */
  private lojaAberta(): boolean {
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date());
    const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
    const dia = partes.find((p) => p.type === 'weekday')?.value ?? '';
    if (dia === 'Sun') return false; // domingo: todas fechadas
    // UNIÃO da rede: como há UM só WhatsApp e algumas lojas vão até 19h (Itanhaém,
    // Praia Grande, inclusive sábado), o gate do modo 'fora' usa a janela MAIS
    // AMPLA — só considera "fora" quando NENHUMA loja pode estar aberta.
    const abre = Number(process.env.LOJA_ABRE ?? '9');
    const fecha = Number(process.env.LOJA_FECHA ?? '19');
    return hora >= abre && hora < fecha;
  }

  // A cada 20s. A janela de espera abaixo é que dá o debounce da rajada.
  @Cron('*/20 * * * * *', { name: 'wa-auto-reply' })
  async ciclo() {
    const modo = this.modo();
    if (modo === 'off' || !this.evo.configurado() || this.rodando) return;
    const fora = !this.lojaAberta();
    if (modo === 'fora' && !fora) return; // dentro do horário: humanos atendem

    this.rodando = true;
    try {
      if (this.avaliadas.size > 1000) this.avaliadas.clear(); // não vaza memória
      if (this.ultimaChamadaIA.size > 1000) this.ultimaChamadaIA.clear();
      const agora = Date.now();
      const desde = new Date(agora - 30 * 60 * 1000); // não mexe em conversa velha
      const ate = new Date(agora - 12 * 1000); // espera 12s (deixa a rajada assentar)
      // 'asc': atende primeiro quem está mais perto de EXPIRAR (30min) — senão,
      // num disparo em massa à noite, as conversas antigas nunca subiam ao topo
      // e saíam da janela sem acolhida nenhuma.
      const convs = await this.p().whatsappConversation.findMany({
        where: { fromMe: false, ultimaEm: { gte: desde, lte: ate } },
        orderBy: { ultimaEm: 'asc' },
        take: 25,
      });
      if (!convs.length) return;
      if (convs.length === 25) this.logger.warn('[wa-auto] fila cheia (25+) — pode haver conversa represada');

      for (const c of convs) {
        try {
          const ultimaEmMs = c.ultimaEm ? new Date(c.ultimaEm).getTime() : 0;
          // Já avaliei ESTE estado (acerto OU recusa de conteúdo)? Não re-chama o Claude.
          if (this.avaliadas.get(c.jid) === ultimaEmMs) continue;
          // Cooldown: a LOJA já respondeu (Lulú OU humano) nos últimos 20min? Pula.
          // Conta qualquer msg fromMe recente (não depende do tag 'auto-ia', que o
          // webhook re-grava como 'texto') — resposta humana também segura o bot.
          const respondeuRecente = await this.p().whatsappMessage.findFirst({
            where: { conversationJid: c.jid, fromMe: true, ts: { gte: new Date(agora - 20 * 60 * 1000) } },
          });
          if (respondeuRecente) {
            this.avaliadas.set(c.jid, ultimaEmMs);
            continue;
          }
          // Throttle por conversa: no máx 1 chamada à IA / 90s (cliente pode
          // mandar várias mensagens seguidas, cada uma com ultimaEm diferente).
          if (agora - (this.ultimaChamadaIA.get(c.jid) || 0) < 90 * 1000) continue;

          this.ultimaChamadaIA.set(c.jid, agora);
          const dec = await this.ia.decidirAutoResposta(c.jid, { fora });
          // Falha TRANSITÓRIA (IA/DB fora): NÃO cacheia — o próximo ciclo reavalia
          // (o throttle de 90s evita martelar). Não perde a mensagem no silêncio.
          if (dec.erro && !dec.responder) {
            this.logger.warn(`[wa-auto] ${c.numero}: erro transitório — ${dec.motivo} (reavalia)`);
            continue;
          }
          if (!dec.responder || !dec.resposta.trim()) {
            this.avaliadas.set(c.jid, ultimaEmMs); // recusa de CONTEÚDO → não re-billa
            this.logger.log(`[wa-auto] ${c.numero}: NÃO respondeu — ${dec.motivo}`);
            continue;
          }
          // CLAIM ATÔMICO no banco: garante UM só envio mesmo com 2 processos
          // (rolling deploy do Railway) e trava de uma vez o TOCTOU (a `ultimaEm`
          // tem que ser a MESMA — se chegou msg nova, não casa) e o cooldown de
          // 20min. Só quem atualizar exatamente 1 linha ganha o direito de enviar.
          const claim = await this.p().whatsappConversation.updateMany({
            where: {
              jid: c.jid,
              ultimaEm: c.ultimaEm,
              OR: [{ autoRepliedAt: null }, { autoRepliedAt: { lt: new Date(agora - 20 * 60 * 1000) } }],
            },
            data: { autoRepliedAt: new Date(agora) },
          });
          if (claim.count !== 1) {
            // outro processo ganhou, ou o estado mudou (msg nova), ou cooldown.
            this.avaliadas.set(c.jid, ultimaEmMs);
            continue;
          }
          // Claim feito ANTES do envio: se o Evolution der timeout mas entregar,
          // o autoRepliedAt já está gravado → o próximo ciclo NÃO reenvia (sem duplicar).
          await this.inbox.responder(c.jid, dec.resposta.trim(), 'auto-ia');
          this.avaliadas.set(c.jid, ultimaEmMs);
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
