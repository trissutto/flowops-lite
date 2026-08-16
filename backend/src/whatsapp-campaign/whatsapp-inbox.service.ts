import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionClient } from './evolution.client';

/**
 * INBOX DE WHATSAPP (dono, 15/08/2026) — WhatsApp Web da instância dentro do
 * FlowOps. O celular fica na loja; a operadora lê e responde do PC.
 *
 * ARQUITETURA (mudou 15/08): antes lia AO VIVO do Evolution (findChats), que
 * devolvia 42 MIL conversas de uma vez — lento, e às vezes nem trazia a nova.
 * Agora o Evolution EMPURRA cada mensagem por WEBHOOK; a gente indexa em
 * `whatsapp_conversations`/`whatsapp_messages` e o inbox lê do NOSSO banco:
 * instantâneo, tempo real e completo. O `backfill` importa o histórico uma vez.
 *
 * Mapeamento DEFENSIVO: o payload do Evolution muda entre versões, então cada
 * campo tem plano B em vez de estourar.
 */
@Injectable()
export class WhatsappInboxService {
  private readonly logger = new Logger(WhatsappInboxService.name);
  private backfilling = false;
  private sincronizando = false;
  private ultimoAcesso = 0;
  /** true quando o webhook do Evolution aponta pra NÓS (aí é tempo real, não precisa sync). */
  private webhookMeu = false;
  private notifiquei = false;

  constructor(
    private readonly evo: EvolutionClient,
    private readonly prisma: PrismaService,
  ) {}

  private p(): any {
    return this.prisma as any;
  }

  /** Callback avisado quando chega msg NOVA da CLIENTE (o auto-reply agenda na hora). */
  private aoReceberCb?: (jid: string) => void;
  aoReceber(cb: (jid: string) => void) {
    this.aoReceberCb = cb;
  }

  // ── helpers ────────────────────────────────────────────────────────
  private toMs(v: any): number {
    if (v == null) return 0;
    if (typeof v === 'object') v = v.low ?? v._seconds ?? v.seconds ?? 0; // Long/Timestamp
    if (typeof v === 'string') {
      const n = Date.parse(v);
      if (!isNaN(n)) return n;
      v = Number(v);
    }
    const n = Number(v);
    if (!n) return 0;
    return n < 1e12 ? n * 1000 : n; // segundos → ms
  }

  private statusDe(m: any): string {
    const s = String(m?.status || m?.update?.status || m?.key?.status || '').toUpperCase();
    if (s.includes('READ') || s.includes('PLAYED')) return 'lido';
    if (s.includes('DELIVERY')) return 'entregue';
    if (s) return 'enviado';
    return '';
  }

  private textoDaMsg(m: any): string {
    const msg = m?.message || m || {};
    if (msg.conversation) return String(msg.conversation);
    if (msg.extendedTextMessage?.text) return String(msg.extendedTextMessage.text);
    if (msg.imageMessage) return '📷 Foto' + (msg.imageMessage.caption ? `: ${msg.imageMessage.caption}` : '');
    if (msg.videoMessage) return '🎬 Vídeo' + (msg.videoMessage.caption ? `: ${msg.videoMessage.caption}` : '');
    if (msg.audioMessage) return '🎤 Áudio';
    if (msg.documentMessage) return '📄 ' + (msg.documentMessage.fileName || msg.documentMessage.caption || 'Documento');
    if (msg.stickerMessage) return 'Figurinha';
    if (msg.locationMessage) return '📍 Localização';
    if (msg.contactMessage || msg.contactsArrayMessage) return '👤 Contato';
    if (msg.reactionMessage) return `Reagiu ${msg.reactionMessage.text || ''}`.trim();
    if (msg.buttonsResponseMessage?.selectedDisplayText) return String(msg.buttonsResponseMessage.selectedDisplayText);
    if (msg.listResponseMessage?.title) return String(msg.listResponseMessage.title);
    return '';
  }

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

  // ── LEITURA (do nosso banco — instantânea) ─────────────────────────
  async conversas() {
    this.ultimoAcesso = Date.now();
    let rows = await this.p().whatsappConversation.findMany({
      orderBy: { ultimaEm: 'desc' },
      take: 100,
    });
    // DEPLOY NOVO: banco ainda vazio. Enche AGORA (só a lista — 1 chamada) pra
    // não ficar em branco, e dispara o backfill das mensagens em background.
    if (!rows.length && this.evo.configurado()) {
      await this.sincronizarConversas(100).catch(() => 0);
      this.dispararBackfill();
      rows = await this.p().whatsappConversation.findMany({ orderBy: { ultimaEm: 'desc' }, take: 100 });
    }
    const nomes = await this.nomesDoCrm(rows.map((r: any) => r.numero));
    return rows.map((r: any) => ({
      jid: r.jid,
      numero: r.numero,
      nome: nomes[r.numero.slice(-8)] || r.nome || r.numero,
      texto: r.ultimaMsg || '',
      ts: r.ultimaEm ? new Date(r.ultimaEm).getTime() : 0,
      fromMe: r.fromMe,
      naoLidas: r.naoLidas,
    }));
  }

  private dispararBackfill() {
    if (this.backfilling) return;
    this.backfill(300).catch((e: any) => this.logger.warn(`[wa-inbox] backfill auto falhou: ${e?.message || e}`));
  }

  /**
   * Mensagens de uma conversa. `marcarLido=true` (padrão) zera o não-lidas —
   * é o caso de um HUMANO abrir a conversa. O cron de auto-resposta passa
   * `false`: ele lê pra decidir, mas NÃO pode apagar o badge de não-lida (senão
   * some a pendência de uma reclamação que ele mesmo recusou responder).
   */
  async mensagens(jid: string, marcarLido = true) {
    if (!jid) throw new BadRequestException('Conversa não informada.');
    let rows = await this.p().whatsappMessage.findMany({
      where: { conversationJid: jid },
      orderBy: { ts: 'asc' },
      take: 300,
    });
    // Conversa ainda sem mensagens no banco (backfill não chegou nela) → busca
    // do Evolution AGORA, só desta conversa (lazy), e guarda.
    if (!rows.length && this.evo.configurado()) {
      await this.carregarMensagensDe(jid).catch(() => undefined);
      rows = await this.p().whatsappMessage.findMany({
        where: { conversationJid: jid },
        orderBy: { ts: 'asc' },
        take: 300,
      });
    }
    // Abriu a conversa = zerou não-lidas (só quando um humano abre).
    if (marcarLido) {
      await this.p()
        .whatsappConversation.updateMany({ where: { jid }, data: { naoLidas: 0 } })
        .catch(() => undefined);
    }
    return rows.slice(-100).map((m: any) => ({
      id: m.waId || m.id,
      fromMe: m.fromMe,
      texto: m.texto || '',
      ts: new Date(m.ts).getTime(),
      status: m.fromMe ? m.status || '' : '',
      tipo: m.tipo || 'texto',
    }));
  }

  /**
   * Envia uma resposta pela loja e grava no banco. `tipo` marca a origem:
   * 'texto' (operadora), 'auto-ia' (a Lulú respondeu sozinha) — pra tela poder
   * mostrar a tarja e pro cron de auto-resposta não repetir.
   */
  async responder(jid: string, texto: string, tipo: 'texto' | 'auto-ia' = 'texto') {
    if (!this.evo.configurado()) throw new BadRequestException('Evolution não configurado.');
    const numero = String(jid || '').split('@')[0].replace(/\D/g, '');
    if (numero.length < 10) throw new BadRequestException('Conversa inválida.');
    if (!String(texto || '').trim()) throw new BadRequestException('Mensagem vazia.');
    const r = await this.evo.enviarTexto(numero, texto);
    const waId = r?.key?.id || null;
    const ts = new Date();
    // A auto-resposta da Lulú NÃO zera o não-lidas: a acolhida ("uma pessoa te
    // responde") não é atendimento humano — o badge tem que continuar sinalizando
    // a pendência (ex.: reclamação) até uma pessoa ABRIR a conversa. Só resposta
    // humana ('texto') marca como lida.
    const zerarNaoLidas = tipo !== 'auto-ia';
    // Otimista: já grava no nosso banco pra aparecer NA HORA (o webhook depois
    // repete com o mesmo waId e é ignorado).
    try {
      await this.p().whatsappConversation.upsert({
        where: { jid },
        create: { jid, numero, ultimaMsg: texto, ultimaEm: ts, fromMe: true, naoLidas: 0 },
        update: { ultimaMsg: texto, ultimaEm: ts, fromMe: true, ...(zerarNaoLidas ? { naoLidas: 0 } : {}) },
      });
      // Só grava a mensagem otimista se veio o waId. Sem ele, o webhook do
      // próprio envio cria a linha (com o waId real) — gravar aqui um waId null
      // faria a idempotência-por-waId não casar e duplicar a linha no inbox.
      if (waId) {
        await this.p().whatsappMessage.create({
          data: { conversationJid: jid, waId, fromMe: true, texto, tipo, status: 'enviado', ts },
        });
      }
    } catch (e: any) {
      this.logger.warn(`[wa-inbox] resposta não gravou local (${e?.message || e}) — o webhook cobre`);
    }
    return { ok: true };
  }

  // ── WEBHOOK (o Evolution empurra; a gente indexa) ──────────────────
  async receberWebhook(body: any) {
    const event = String(body?.event || body?.type || '').toLowerCase().replace(/_/g, '.');
    const data = body?.data ?? body;
    try {
      if (event.includes('messages.upsert') || event.includes('send.message') || event.includes('messages.set')) {
        const msgs = Array.isArray(data) ? data : data?.messages || [data];
        for (const m of msgs) await this.indexarMensagem(m);
      } else if (event.includes('messages.update') || event.includes('message.update')) {
        const ups = Array.isArray(data) ? data : data?.updates || [data];
        for (const u of ups) await this.atualizarStatus(u);
      }
      // outros eventos (contacts/chats) são ignorados — a conversa nasce da 1ª msg
    } catch (e: any) {
      this.logger.warn(`[wa-inbox] webhook (${event}) falhou: ${e?.message || e}`);
    }
    return { ok: true };
  }

  private async indexarMensagem(m: any) {
    const key = m?.key || m || {};
    const jid = key.remoteJid || m?.remoteJid || '';
    if (!jid || !String(jid).endsWith('@s.whatsapp.net')) return; // 1:1 só
    const waId = key.id || m?.id || null;
    const fromMe = !!key.fromMe;
    const texto = this.textoDaMsg(m);
    const ts = new Date(this.toMs(m?.messageTimestamp) || Date.now());
    const numero = String(jid).split('@')[0];
    const nome = m?.pushName || m?.verifiedBizName || null;
    const status = fromMe ? this.statusDe(m) : null;

    // Idempotência: se já temos esse waId, no máximo atualiza o status e sai.
    if (waId) {
      const existe = await this.p().whatsappMessage.findUnique({ where: { waId } }).catch(() => null);
      if (existe) {
        if (status && status !== existe.status) {
          await this.p().whatsappMessage.update({ where: { waId }, data: { status } }).catch(() => undefined);
        }
        return;
      }
    }

    // Não deixar a conversa RETROCEDER: os webhooks do Evolution podem chegar
    // FORA DE ORDEM (a msg antiga da cliente depois da resposta da loja). Só
    // avança direção/timestamp/preview quando ESTA msg é a mais nova. Mensagem
    // recebida conta em não-lidas de qualquer jeito (a trava do auto-reply
    // depende de fromMe/ultimaEm refletirem a msg realmente mais recente).
    const conv = await this.p().whatsappConversation.findUnique({ where: { jid } }).catch(() => null);
    const maisNova = !conv?.ultimaEm || ts >= new Date(conv.ultimaEm);
    if (!conv) {
      await this.p()
        .whatsappConversation.create({
          data: { jid, numero, nome, ultimaMsg: texto, ultimaEm: ts, fromMe, naoLidas: fromMe ? 0 : 1 },
        })
        .catch(() => undefined); // corrida de criação → o outro webhook cobre
    } else {
      const upd: any = { nome: nome ?? undefined };
      if (!fromMe) upd.naoLidas = { increment: 1 }; // recebida sempre conta
      if (maisNova) {
        upd.ultimaMsg = texto;
        upd.ultimaEm = ts;
        upd.fromMe = fromMe;
        if (fromMe) upd.naoLidas = 0; // loja respondeu a msg mais nova → lida
      }
      await this.p().whatsappConversation.update({ where: { jid }, data: upd }).catch(() => undefined);
    }
    await this.p()
      .whatsappMessage.create({
        data: { conversationJid: jid, waId, fromMe, texto, tipo: 'texto', status: status || undefined, ts },
      })
      .catch((e: any) => {
        // corrida de webhook duplicado (mesmo waId) → ignora
        if (!String(e?.message || '').includes('Unique')) throw e;
      });
    // Msg NOVA da cliente (chegamos aqui = não é duplicada por waId) → avisa o
    // auto-reply pra agendar na hora (caminho por-evento, ~5-8s).
    if (!fromMe) {
      try {
        this.aoReceberCb?.(jid);
      } catch {
        /* callback nunca derruba o webhook */
      }
    }
  }

  private async atualizarStatus(u: any) {
    const waId = u?.key?.id || u?.keyId || u?.id || null;
    const status = this.statusDe(u);
    if (!waId || !status) return;
    await this.p().whatsappMessage.updateMany({ where: { waId }, data: { status } }).catch(() => undefined);
  }

  // ── SYNC via findChats/findMessages (fallback + backfill) ──────────

  /** findChats → upserta só as LINHAS de conversa (1 chamada, sem mensagens). */
  private async sincronizarConversas(limite = 100): Promise<number> {
    const raw = await this.evo.listarConversas();
    const arr: any[] = Array.isArray(raw) ? raw : raw?.chats || raw?.records || [];
    const chats = arr
      .map((c) => {
        const jid = c.remoteJid || c.id || c.jid || '';
        const last = c.lastMessage || c.last_message || null;
        return {
          jid,
          numero: String(jid).split('@')[0],
          nome: c.pushName || c.name || c.contact?.name || null,
          texto: last ? this.textoDaMsg(last) : '',
          ts: this.toMs(c.updatedAt || last?.messageTimestamp || c.windowStart),
          fromMe: !!last?.key?.fromMe,
        };
      })
      .filter((c) => c.jid.endsWith('@s.whatsapp.net'))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, Math.min(Math.max(limite, 1), 500));
    for (const c of chats) {
      const ultimaEm = c.ts ? new Date(c.ts) : null;
      await this.p()
        .whatsappConversation.upsert({
          where: { jid: c.jid },
          create: { jid: c.jid, numero: c.numero, nome: c.nome, ultimaMsg: c.texto, ultimaEm, fromMe: c.fromMe, naoLidas: 0 },
          // sync NÃO mexe em naoLidas (isso é do webhook / de abrir a conversa).
          update: { nome: c.nome ?? undefined, ultimaMsg: c.texto || undefined, ultimaEm: ultimaEm ?? undefined, fromMe: c.fromMe },
        })
        .catch(() => undefined);
    }
    return chats.length;
  }

  /** findMessages de UMA conversa → upserta as mensagens (lazy, por waId). */
  private async carregarMensagensDe(jid: string): Promise<number> {
    const rawMsgs = await this.evo.listarMensagens(jid);
    const ms: any[] = Array.isArray(rawMsgs)
      ? rawMsgs
      : rawMsgs?.messages?.records || rawMsgs?.records || rawMsgs?.messages || [];
    let n = 0;
    for (const m of ms.slice(-60)) {
      const waId = m?.key?.id || null;
      if (!waId) continue;
      await this.p()
        .whatsappMessage.upsert({
          where: { waId },
          create: {
            conversationJid: jid,
            waId,
            fromMe: !!m?.key?.fromMe,
            texto: this.textoDaMsg(m),
            tipo: 'texto',
            status: m?.key?.fromMe ? this.statusDe(m) || null : null,
            ts: new Date(this.toMs(m.messageTimestamp) || Date.now()),
          },
          update: {},
        })
        .then(() => {
          n++;
        })
        .catch(() => undefined);
    }
    return n;
  }

  /** BACKFILL (uma vez): lista + mensagens recentes de cada conversa. */
  async backfill(limite = 200) {
    if (this.backfilling) return { ok: false, motivo: 'já rodando' };
    if (!this.evo.configurado()) throw new BadRequestException('Evolution não configurado.');
    this.backfilling = true;
    let mensagens = 0;
    try {
      const conversas = await this.sincronizarConversas(limite);
      const rows = await this.p().whatsappConversation.findMany({
        orderBy: { ultimaEm: 'desc' },
        take: Math.min(Math.max(limite, 1), 500),
      });
      for (const r of rows) {
        try {
          mensagens += await this.carregarMensagensDe(r.jid);
        } catch (e: any) {
          this.logger.warn(`[wa-inbox] backfill de ${r.jid} falhou: ${e?.message || e}`);
        }
      }
      this.logger.log(`[wa-inbox] backfill: ${conversas} conversas, ${mensagens} mensagens`);
      return { ok: true, conversas, mensagens };
    } finally {
      this.backfilling = false;
    }
  }

  // ── WEBHOOK self-config + freshness (crons) ────────────────────────

  /** URL pública deste backend que o Evolution vai chamar. */
  private urlPublica(): string {
    const raw =
      process.env.WHATSAPP_WEBHOOK_BASE ||
      process.env.APP_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
      'https://flowops-lite-production.up.railway.app';
    const base = raw.replace(/\/+$/, '');
    const token = process.env.WHATSAPP_WEBHOOK_TOKEN || '';
    return `${base}/api/whatsapp-inbox/webhook${token ? '/' + encodeURIComponent(token) : ''}`;
  }

  /**
   * A cada 10min: garante que o Evolution EMPURRA as mensagens pra nós.
   * NUNCA sobrescreve webhook de terceiro (ex.: n8n) — só configura se estiver
   * vazio ou já for o nosso. Se for de outro, loga e deixa quieto (aí o inbox
   * segue no modo sync/findChats).
   */
  @Cron('20 */10 * * * *', { name: 'wa-inbox-ensure-webhook' })
  async ensureWebhook() {
    if (!this.evo.configurado()) return;
    try {
      const url = this.urlPublica();
      const atual = await this.evo.verificarWebhook();
      const urlAtual = String(atual?.url || '');
      if (atual?.enabled && urlAtual === url) {
        this.webhookMeu = true;
        return;
      }
      if (atual?.enabled && urlAtual && !/flowops/i.test(urlAtual)) {
        this.webhookMeu = false;
        this.logger.warn(
          `[wa-inbox] instância já tem webhook em ${urlAtual}; NÃO sobrescrevo. Aponte manualmente pra ${url} pra ter tempo real.`,
        );
        return;
      }
      await this.evo.configurarWebhook(url, ['MESSAGES_UPSERT', 'MESSAGES_UPDATE']);
      this.webhookMeu = true;
      this.logger.log(`[wa-inbox] webhook apontado pra ${url}`);
    } catch (e: any) {
      this.logger.warn(`[wa-inbox] não configurei o webhook: ${e?.message || e}`);
    }
  }

  /** Status do webhook (pra tela admin). */
  async statusWebhook() {
    const atual = await this.evo.verificarWebhook().catch(() => null);
    return {
      esperado: this.urlPublica(),
      atual: atual?.url || null,
      ativo: !!atual?.enabled,
      meu: this.webhookMeu,
    };
  }

  /**
   * Aponta o webhook pra nós. `forcar=false` (padrão) respeita webhook de
   * terceiro; `forcar=true` sobrescreve — é uma AÇÃO EXPLÍCITA do admin (clicar
   * o botão), a decisão de assumir a instância é humana, nunca do cron.
   */
  async apontarWebhook(forcar = false) {
    if (!this.evo.configurado()) throw new BadRequestException('Evolution não configurado.');
    const url = this.urlPublica();
    const atual = await this.evo.verificarWebhook().catch(() => null);
    const urlAtual = String(atual?.url || '');
    if (!forcar && atual?.enabled && urlAtual && urlAtual !== url && !/flowops/i.test(urlAtual)) {
      return { ok: false, motivo: 'webhook de terceiro', atual: urlAtual, url };
    }
    await this.evo.configurarWebhook(url, ['MESSAGES_UPSERT', 'MESSAGES_UPDATE']);
    this.webhookMeu = true;
    this.logger.log(`[wa-inbox] webhook apontado (forcar=${forcar}) pra ${url}`);
    return { ok: true, url };
  }

  /**
   * A cada 2min: mantém a lista fresca por findChats (1 chamada) — mas SÓ quando
   * NÃO temos o webhook (senão é tempo real e isto nem roda) E o inbox foi usado
   * nos últimos 5min (sem ninguém olhando, não martela o Evolution).
   */
  @Cron('50 */2 * * * *', { name: 'wa-inbox-sync' })
  async sincronizar() {
    if (this.webhookMeu) return;
    if (!this.evo.configurado()) return;
    if (Date.now() - this.ultimoAcesso > 5 * 60 * 1000) return;
    if (this.sincronizando || this.backfilling) return;
    this.sincronizando = true;
    try {
      await this.sincronizarConversas(100);
    } catch (e: any) {
      this.logger.warn(`[wa-inbox] sync falhou: ${e?.message || e}`);
    } finally {
      this.sincronizando = false;
    }
  }

  /**
   * Avisa o dono UMA vez (WhatsApp) que o inbox novo subiu. Ligado por env
   * `WHATSAPP_NOTIFY_ON_READY` (= número com DDI, ex.: 5513996218277). Idempotente
   * de verdade: marca a mensagem com `tipo:'notify-pronto'` e não repete mesmo
   * depois de um redeploy. Manda pela PRÓPRIA instância (chave do backend).
   */
  @Cron('40 * * * * *', { name: 'wa-inbox-notify-ready' })
  async notificarPronto() {
    if (this.notifiquei) return;
    const alvo = (process.env.WHATSAPP_NOTIFY_ON_READY || '').replace(/\D/g, '');
    if (alvo.length < 10 || !this.evo.configurado()) return;
    const jid = `${alvo}@s.whatsapp.net`;
    try {
      const ja = await this.p().whatsappMessage.findFirst({ where: { conversationJid: jid, tipo: 'notify-pronto' } });
      if (ja) {
        this.notifiquei = true;
        return;
      }
      const texto =
        '✅ Inbox de WhatsApp NOVO no ar (tempo real).\n\n' +
        'As conversas agora carregam do nosso banco (rápido) e a mensagem que ' +
        'chega do celular aparece na hora — sem depender do findChats. Abra ' +
        '/retaguarda/whatsapp-inbox no PC.\n\n— FlowOps';
      const r = await this.evo.enviarTexto(alvo, texto);
      const ts = new Date();
      await this.p().whatsappConversation.upsert({
        where: { jid },
        create: { jid, numero: alvo, ultimaMsg: texto, ultimaEm: ts, fromMe: true, naoLidas: 0 },
        update: { ultimaMsg: texto, ultimaEm: ts, fromMe: true },
      });
      await this.p().whatsappMessage.create({
        data: { conversationJid: jid, waId: r?.key?.id || null, fromMe: true, texto, tipo: 'notify-pronto', status: 'enviado', ts },
      });
      this.notifiquei = true;
      this.logger.log(`[wa-inbox] avisei o dono em ${alvo} que o inbox subiu`);
    } catch (e: any) {
      this.logger.warn(`[wa-inbox] notify-pronto falhou: ${e?.message || e}`);
    }
  }
}
