import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionClient } from './evolution.client';
import { WhatsappInboxService } from './whatsapp-inbox.service';
import { WhatsappIaService } from './whatsapp-ia.service';

/**
 * AUTO-RESPOSTA da Lulú (dono, 16/08): a IA responde SOZINHA no WhatsApp, com
 * trava dura. Kill-switch por env `WHATSAPP_AUTO_REPLY`: off · fora · sempre.
 *
 * ARQUITETURA POR EVENTO (16/08, meta 5-8s): a mensagem que chega no webhook
 * AGENDA a resposta com um respiro curto (~4s, debounce — se a cliente manda de
 * novo, reinicia). Passado o respiro → classifica (Haiku) → envia. ~6-8s no total.
 * O CRON virou só REDE DE SEGURANÇA pro que o caminho por-evento perdeu.
 *
 * Travas (valem nos DOIS caminhos, em `tentarResponder`):
 *  - só conversa cuja ÚLTIMA msg é da CLIENTE (`fromMe=false`);
 *  - não mexe em conversa > 30min;
 *  - throttle 3s/conversa (ping-pong; env WHATSAPP_AUTO_THROTTLE_MS) — a Lulú só fica
 *    FORA quando um HUMANO respondeu nos últimos 10min;
 *  - dedup: não repete o MESMO texto pra mesma conversa em < 30min;
 *  - CLAIM atômico idempotente POR MENSAGEM (autoRepliedAt ≥ ultimaEm) → 1 só envio;
 *  - teto de 15 auto-respostas/hora por conversa (contado em memória);
 *  - a IA decide (allowlist) e o texto é template — tudo com tarja `auto-ia`.
 */
@Injectable()
export class WhatsappAutoReplyService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappAutoReplyService.name);
  private rodando = false;
  /** jid → ultimaEm(ms) já avaliado. Evita re-chamar o Claude pro MESMO estado. */
  private avaliadas = new Map<string, number>();
  /** jid → ts da última chamada à IA (throttle: máx 1 chamada / 3s por conversa). */
  private ultimaChamadaIA = new Map<string, number>();
  /** jid → texto+ts da última auto-resposta ENVIADA (dedup: não repete o mesmo texto <30min). */
  private ultimaAutoResp = new Map<string, { texto: string; ts: number }>();
  /** jid → timestamps das auto-respostas na última hora (teto anti-flood; independe do
   *  waId do Evolution, que o DB usa e às vezes não volta). */
  private autoRespTs = new Map<string, number[]>();
  /** jid → timer de debounce do caminho por-evento. */
  private timers = new Map<string, NodeJS.Timeout>();
  /** ms de quando a Lulú foi LIGADA (0 = desligada). A rede de segurança não pega
   *  backlog anterior a isso — senão, ao ligar, dispararia acolhida pra todo mundo
   *  que mandou msg nos últimos 30min. */
  private ligadoDesde = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly evo: EvolutionClient,
    private readonly inbox: WhatsappInboxService,
    private readonly ia: WhatsappIaService,
  ) {}

  onModuleInit() {
    // Assim que chega mensagem NOVA da cliente, agenda a resposta na hora.
    this.inbox.aoReceber((jid) => this.agendar(jid));
  }

  private p(): any {
    return this.prisma as any;
  }

  private modo(): 'off' | 'fora' | 'sempre' {
    const v = String(process.env.WHATSAPP_AUTO_REPLY || 'off').toLowerCase();
    return v === 'fora' || v === 'sempre' ? v : 'off';
  }

  /** Loja aberta AGORA (Brasília)? União da rede (Seg-Sáb 9..19, Dom fechado). */
  private lojaAberta(): boolean {
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date());
    const hora = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
    const dia = partes.find((p) => p.type === 'weekday')?.value ?? '';
    if (dia === 'Sun') return false;
    const abre = Number(process.env.LOJA_ABRE ?? '9');
    // Sábado a maioria da rede fecha 13h (só Itanhaém/Praia Grande vão até 19h). Default
    // 13 pra Lulú COBRIR a tarde de sábado no modo 'fora' (acolher > silêncio até segunda).
    // Se o WhatsApp central for atendido sábado à tarde, subir LOJA_FECHA_SAB=19.
    const fecha =
      dia === 'Sat' ? Number(process.env.LOJA_FECHA_SAB ?? '13') : Number(process.env.LOJA_FECHA ?? '19');
    return hora >= abre && hora < fecha;
  }

  /** Caminho POR EVENTO: agenda a resposta com debounce curto (reinicia a cada msg). */
  agendar(jid: string) {
    if (this.modo() === 'off' || !jid) return;
    const antigo = this.timers.get(jid);
    if (antigo) clearTimeout(antigo);
    const debounce = Math.max(1000, Number(process.env.WHATSAPP_AUTO_DEBOUNCE_MS ?? '3000'));
    const t = setTimeout(() => {
      this.timers.delete(jid);
      void this.tentarResponder(jid);
    }, debounce);
    // `unref` pra não segurar o processo; nunca deixa a fila de timers explodir.
    if (typeof t.unref === 'function') t.unref();
    if (this.timers.size > 2000) {
      const primeiro = this.timers.keys().next().value;
      if (primeiro) {
        clearTimeout(this.timers.get(primeiro)!);
        this.timers.delete(primeiro);
      }
    }
    this.timers.set(jid, t);
  }

  /** Tenta responder UMA conversa (usado pelo evento E pela rede de segurança). */
  private async tentarResponder(jid: string) {
    try {
      const modo = this.modo();
      if (modo === 'off' || !this.evo.configurado()) return;
      const fora = !this.lojaAberta();
      if (modo === 'fora' && !fora) return; // dentro do horário: humanos atendem

      const agora = Date.now();
      const c = await this.p().whatsappConversation.findUnique({ where: { jid } });
      if (!c || c.fromMe) return; // sumiu, ou a última já é da loja
      const ultimaEmMs = c.ultimaEm ? new Date(c.ultimaEm).getTime() : 0;
      if (agora - ultimaEmMs > 30 * 60 * 1000) return; // velho demais
      if (this.avaliadas.get(jid) === ultimaEmMs) return; // já avaliei este estado
      // Throttle: no máx 1 chamada à IA a cada 3s por conversa (ping-pong; env).
      const throttleMs = Math.max(1000, Number(process.env.WHATSAPP_AUTO_THROTTLE_MS ?? 3000));
      if (agora - (this.ultimaChamadaIA.get(jid) || 0) < throttleMs) return;
      // Marca a chamada JÁ AQUI (antes dos awaits) — fecha a corrida evento×rede-de-
      // segurança sobre o MESMO estado (senão as duas passam o throttle e chamam o Haiku
      // em dobro; o claim só evita o ENVIO duplo, não a chamada extra).
      this.ultimaChamadaIA.set(jid, agora);

      // Se um HUMANO respondeu nos últimos N min (env WHATSAPP_AUTO_HUMANO_MIN, default
      // 10), a Lulú fica FORA — é ela "parando porque um humano entrou". Conta resposta
      // humana (tipo 'texto'), MAS descarta o ECO da própria Lulú: quando o Evolution não
      // devolve waId, o webhook do envio dela entra como 'texto' e passaria por humano —
      // travaria a Lulú achando que assumiram. Filtra pelo texto da última auto-resposta.
      const humanoMin = Math.max(1, Number(process.env.WHATSAPP_AUTO_HUMANO_MIN ?? 10));
      const ultAuto = this.ultimaAutoResp.get(jid);
      const fromMeRecentes = await this.p().whatsappMessage.findMany({
        where: { conversationJid: jid, fromMe: true, tipo: 'texto', ts: { gte: new Date(agora - humanoMin * 60 * 1000) } },
        orderBy: { ts: 'desc' },
        take: 5,
      });
      const humanoRecente = fromMeRecentes.some(
        (m: any) => !(ultAuto && String(m.texto || '').trim() === ultAuto.texto),
      );
      if (humanoRecente) {
        this.avaliadas.set(jid, ultimaEmMs);
        return;
      }
      // Teto anti-runaway: no máx 15 auto-respostas por conversa por hora. Contado em
      // MEMÓRIA — o DB só grava a linha 'auto-ia' quando o Evolution devolve waId, então
      // contar no banco deixaria o teto FURADO justo quando o Evolution não devolve id.
      const desdeHora = agora - 60 * 60 * 1000;
      const autoNaHora = (this.autoRespTs.get(jid) || []).filter((t) => t >= desdeHora).length;
      if (autoNaHora >= 15) {
        this.avaliadas.set(jid, ultimaEmMs);
        this.logger.warn(`[wa-auto] ${c.numero}: teto de 15 auto-respostas/hora atingido`);
        return;
      }

      const dec = await this.ia.decidirAutoResposta(jid, { fora });
      if (dec.erro && !dec.responder) {
        this.logger.warn(`[wa-auto] ${c.numero}: erro transitório — ${dec.motivo} (reavalia)`);
        return; // transitório → não cacheia (o throttle de 3s evita martelar)
      }
      if (!dec.responder || !dec.resposta.trim()) {
        this.avaliadas.set(jid, ultimaEmMs); // recusa de CONTEÚDO → não re-billa
        this.logger.log(`[wa-auto] ${c.numero}: NÃO respondeu — ${dec.motivo}`);
        return;
      }
      const texto = dec.resposta.trim();
      // DEDUP: se a última auto-resposta desta conversa (há < 30min) é IDÊNTICA ao que
      // íamos mandar, não manda de novo — evita eco da mesma acolhida/template quando a
      // cliente dispara várias mensagens seguidas. O ping-pong de 3s segue valendo pra
      // respostas DIFERENTES (o que o dono pediu). Memória local, não depende do waId.
      const ult = this.ultimaAutoResp.get(jid);
      if (ult && ult.texto === texto && agora - ult.ts < 30 * 60 * 1000) {
        this.avaliadas.set(jid, ultimaEmMs);
        this.logger.log(`[wa-auto] ${c.numero}: pulou (resposta idêntica à última auto)`);
        return;
      }
      // CLAIM ATÔMICO idempotente POR MENSAGEM: uma vez respondida ESTA mensagem
      // (autoRepliedAt passa a ficar ≥ ultimaEm), nunca re-clama a mesma — só uma
      // mensagem NOVA da cliente (ultimaEm maior) libera de novo. Não depende de
      // fromMe nem da memória em processo. Trava TOCTOU: ultimaEm tem que ser a MESMA.
      const claim = await this.p().whatsappConversation.updateMany({
        where: {
          jid,
          ultimaEm: c.ultimaEm,
          OR: [{ autoRepliedAt: null }, { autoRepliedAt: { lt: c.ultimaEm } }],
        },
        data: { autoRepliedAt: new Date(agora) },
      });
      if (claim.count !== 1) {
        this.avaliadas.set(jid, ultimaEmMs);
        return;
      }
      try {
        await this.inbox.responder(jid, texto, 'auto-ia');
      } catch (e: any) {
        // Envio falhou DEPOIS do claim → DEVOLVE o claim (autoRepliedAt=null) pra rede
        // de segurança RETENTAR; senão a acolhida se perderia. NOTA: o enviarTexto PODE
        // ter entregado a msg e mesmo assim lançar (timeout de rede). Nesse caso o ECO
        // (fromMe=true) do próprio envio chega pelo webhook e flipa a conversa, então a
        // rede de segurança (query fromMe:false) não a repega → não duplica. Favorecemos
        // "não perder" sobre o raro duplicado (o modo webhook padrão cobre; o dedup por
        // conteúdo pega o resto na mesma instância).
        await this.p()
          .whatsappConversation.updateMany({ where: { jid, autoRepliedAt: new Date(agora) }, data: { autoRepliedAt: null } })
          .catch(() => undefined);
        throw e; // cai no catch externo (loga); NÃO cacheia avaliadas → reavalia no próximo ciclo
      }
      this.ultimaAutoResp.set(jid, { texto, ts: agora });
      const tsHora = (this.autoRespTs.get(jid) || []).filter((t) => t >= agora - 60 * 60 * 1000);
      tsHora.push(agora);
      this.autoRespTs.set(jid, tsHora);
      this.avaliadas.set(jid, ultimaEmMs);
      this.logger.log(`[wa-auto] ${c.numero}: Lulú respondeu (fora=${fora}) — ${dec.motivo}`);
    } catch (e: any) {
      this.logger.warn(`[wa-auto] ${jid} falhou: ${e?.message || e}`);
    }
  }

  // REDE DE SEGURANÇA: pega o que o caminho por-evento perdeu (processo caiu, msg
  // que não passou pelo webhook). Só mexe no que está parado > 45s.
  @Cron('*/30 * * * * *', { name: 'wa-auto-reply-safety' })
  async ciclo() {
    const modo = this.modo();
    if (modo === 'off') {
      this.ligadoDesde = 0; // desligou → próxima ativação começa do zero (sem backlog)
      return;
    }
    if (!this.evo.configurado() || this.rodando) return;
    if (modo === 'fora' && this.lojaAberta()) {
      this.ligadoDesde = 0; // loja aberta → zera; ao fechar, re-marca (não pega backlog do comercial)
      return;
    }
    if (!this.ligadoDesde) this.ligadoDesde = Date.now(); // acabou de ligar / acabou de fechar

    this.rodando = true;
    try {
      if (this.avaliadas.size > 2000) this.avaliadas.clear();
      if (this.ultimaChamadaIA.size > 2000) this.ultimaChamadaIA.clear();
      if (this.ultimaAutoResp.size > 2000) this.ultimaAutoResp.clear();
      if (this.autoRespTs.size > 2000) this.autoRespTs.clear();
      const agora = Date.now();
      // desde = o mais recente entre "30min atrás" e "quando ligou" — não pega backlog anterior à ativação.
      const desde = new Date(Math.max(agora - 30 * 60 * 1000, this.ligadoDesde));
      const convs = await this.p().whatsappConversation.findMany({
        where: {
          fromMe: false,
          ultimaEm: { gte: desde, lte: new Date(agora - 45 * 1000) },
        },
        orderBy: { ultimaEm: 'asc' }, // atende primeiro quem vai expirar
        take: 25,
      });
      for (const c of convs) await this.tentarResponder(c.jid);
    } catch (e: any) {
      this.logger.warn(`[wa-auto] rede de segurança falhou: ${e?.message || e}`);
    } finally {
      this.rodando = false;
    }
  }
}
