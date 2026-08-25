import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionClient } from '../whatsapp-campaign/evolution.client';
import { usarAuthPostgres } from './auth-postgres';

/**
 * WhatsappService — integração via Baileys (WhatsApp Web multi-device).
 *
 * Fluxo:
 *   1. Ao subir o módulo, tenta restaurar sessão do disco (dir WA_SESSION_DIR).
 *   2. Se não tem sessão, emite QR code que o frontend exibe pra usuário escanear.
 *   3. Depois de logado, disparos viram chamadas ao socket.
 *
 * Sessão é persistida via useMultiFileAuthState do Baileys. Pra sobreviver
 * a redeploy no Railway é obrigatório apontar WA_SESSION_DIR pra um Volume.
 *
 * Limitações conhecidas:
 *   - Baileys é biblioteca não-oficial; risco de ban se usar como spam-blaster.
 *     No nosso caso (comunicação interna matriz→lojas conhecidas) o risco é baixo.
 *   - Sessão fica só numa instância do backend. Se escalar horizontal, um
 *     singleton externo (Redis/DB) seria necessário. Por enquanto 1 pod basta.
 *
 * ── 🚨 O TRANSPORTE MUDOU (25/08/2026, ordem do dono) ──
 *
 * O sistema tinha DOIS WhatsApps: esta sessão Baileys (avisos automáticos:
 * troca, pós-venda, crediário, leads, PDV) e a instância do **Evolution**, que
 * é o WhatsApp que a equipe usa no inbox e no Lulu. Mesmo aparelho, dois
 * pareamentos — e ninguém sabia disso ao olhar a tela.
 *
 * A Baileys caiu em ~14/08 e ficou 11 dias fora sem ninguém ver: o único sinal
 * era um WARN no log. Em 25/08 o cron de trocas drenou 18 códigos de postagem
 * **todos por e-mail**, porque o WhatsApp não respondia. Enquanto isso a
 * instância do Evolution mandava 284 mensagens no mesmo dia, sem falhar.
 *
 * Agora `sendText` fala pelo **Evolution primeiro** e só usa a sessão local se
 * o Evolution não estiver configurado ou recusar. Ninguém mais precisa
 * reescanear QR pra o aviso sair, e o aviso aparece no MESMO inbox onde a
 * operadora continua a conversa. Kill-switch: `AVISOS_VIA_EVOLUTION=0` volta a
 * mandar pela sessão local.
 */
@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evo: EvolutionClient,
  ) {}

  /**
   * A instância do Evolution respondeu "conectada" da última vez que olhamos?
   *
   * `getStatus()` é síncrono (a tela do QR faz polling nele), então o estado
   * do Evolution vive aqui em cache: um cron de 5min atualiza, e todo envio
   * carimba o resultado real — envio que passa é a melhor prova de que o canal
   * está de pé.
   */
  private evoConectado = false;
  private evoConferidoEm: Date | null = null;

  /** Socket Baileys ativo, ou null se desconectado */
  private sock: any = null;
  /** Último QR code emitido (data URL base64), ou null se não precisa mais */
  private lastQr: string | null = null;
  /** Número próprio logado (ex: 5513999998888), ou null */
  private ownNumber: string | null = null;
  /** Flag pra evitar múltiplas conexões simultâneas */
  private connecting = false;
  /** Timestamp da última reconexão bem-sucedida */
  private connectedAt: Date | null = null;

  private sessionDir(): string {
    const dir = process.env.WA_SESSION_DIR || '/tmp/wa-session';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }


  /**
   * TEM SESSÃO SALVA? Pergunta ao POSTGRES primeiro, disco depois.
   *
   * A ordem importa: assim que a sessão migra pro banco, o volume pode sumir —
   * e se esta checagem continuasse olhando só o disco, o serviço acharia que
   * nunca houve sessão e ficaria esperando alguém escanear um QR que não é
   * necessário.
   *
   * O disco segue como segunda opção só enquanto o volume existir, pra cobrir
   * a primeira subida (antes da importação acontecer).
   */
  private async temSessaoSalva(): Promise<boolean> {
    try {
      const n = await (this.prisma as any).waAuth.count({
        where: { sessao: 'principal', chave: 'creds' },
      });
      if (n > 0) return true;
    } catch {
      // Banco fora do ar no boot não pode impedir a reconexão pelo disco.
    }
    try {
      return fs.existsSync(path.join(this.sessionDir(), 'creds.json'));
    } catch {
      return false;
    }
  }

  async onModuleInit() {
    // Estado do Evolution ANTES de qualquer coisa: sem isto o cache fica
    // `false` por até 5 minutos depois do deploy e a barra de alarme grita
    // "WhatsApp desconectado" com o canal perfeitamente de pé.
    this.conferirEvolution().catch(() => {});

    // Só tenta reconectar auto se já existe uma sessão salva. Senão espera
    // o usuário clicar "conectar" na tela frontend pra gerar QR novo.
    const dir = this.sessionDir();
    const hasSession = fs.existsSync(path.join(dir, 'creds.json'));
    if (hasSession) {
      this.logger.log('Sessão WhatsApp encontrada no disco — reconectando…');
      this.connect().catch((e) => this.logger.error(`Falha reconexão: ${e?.message}`));
    } else {
      this.logger.warn('Sem sessão WhatsApp salva. Aguardando /whatsapp/connect.');
    }
  }

  /** Inicia (ou reinicia) a conexão Baileys. Idempotente. */
  async connect(): Promise<void> {
    if (this.connecting) {
      this.logger.log('connect() já em andamento, ignorando.');
      return;
    }
    this.connecting = true;

    try {
      // Lazy-require pra não carregar Baileys no boot se o módulo não for usado
      const baileys = await import('@whiskeysockets/baileys');
      const makeWASocket = baileys.default;
      const { DisconnectReason, fetchLatestBaileysVersion } = baileys;

      const { state, saveCreds } = await usarAuthPostgres(
        this.prisma, 'principal', this.logger, this.sessionDir(),
      );
      const { version } = await fetchLatestBaileysVersion();

      const pino = (await import('pino')).default;
      const silentLogger = pino({ level: 'silent' });

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: silentLogger,
        printQRInTerminal: false,
        browser: ['Lurds Order One', 'Chrome', '120'],
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Converte QR (string) em data URL pra renderizar <img> no frontend
          try {
            this.lastQr = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
            this.logger.log('QR code gerado. Escaneie pelo app do WhatsApp.');
          } catch (e: any) {
            this.logger.error(`Falha gerar QR: ${e?.message}`);
          }
        }

        if (connection === 'open') {
          this.lastQr = null;
          this.connectedAt = new Date();
          const me = this.sock?.user?.id || '';
          // formato do id: 5513999998888:xx@s.whatsapp.net
          this.ownNumber = me.split('@')[0]?.split(':')[0] || null;
          this.logger.log(`WhatsApp conectado. Número: ${this.ownNumber}`);
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          this.logger.warn(
            `Conexão fechada (code=${statusCode}). Reconnect=${shouldReconnect}`,
          );
          this.connectedAt = null;
          this.ownNumber = null;
          this.sock = null;

          if (shouldReconnect) {
            // Delay pra não entrar em loop rápido se o erro for persistente
            setTimeout(() => {
              this.connecting = false;
              this.connect().catch((e) =>
                this.logger.error(`Reconexão falhou: ${e?.message}`),
              );
            }, 3000);
          } else {
            // loggedOut → limpa disco pra próxima conexão ser QR novo
            this.logger.warn('Sessão deslogada. Limpando disco.');
            this.wipeSession();
          }
        }
      });

      // Dá uns 500ms pro socket se estabilizar antes de liberar o lock
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      this.connecting = false;
    }
  }

  /** Desloga e apaga sessão. Próxima conexão vai exigir QR novo. */
  async logout(): Promise<void> {
    try {
      if (this.sock) await this.sock.logout();
    } catch (e: any) {
      this.logger.warn(`Logout com erro: ${e?.message}`);
    }
    this.sock = null;
    this.connectedAt = null;
    this.ownNumber = null;
    this.lastQr = null;
    this.wipeSession();
  }

  private wipeSession() {
    const dir = this.sessionDir();
    try {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          fs.rmSync(path.join(dir, f), { recursive: true, force: true });
        }
      }
    } catch (e: any) {
      this.logger.error(`Erro limpando sessão: ${e?.message}`);
    }
  }

  /**
   * `connected` continua significando **a sessão local (QR)** — é o que a tela
   * de pareamento precisa saber, e trocar esse sentido faria o QR sumir de
   * quem quer reconectar.
   *
   * Quem pergunta "dá pra avisar a cliente agora?" olha `podeEnviar`/`canal`:
   * era o `connected` que fazia a barra da /separacao gritar "WhatsApp
   * desconectado" enquanto a instância do Evolution mandava 284 mensagens no
   * mesmo dia.
   */
  getStatus() {
    const localOk = !!this.sock && !!this.connectedAt;
    const evoOk = this.evolutionPreferido() && this.evoConectado;
    return {
      connected: localOk,
      phoneNumber: this.ownNumber,
      connectedAt: this.connectedAt?.toISOString() ?? null,
      qr: this.lastQr,
      /** Por onde o próximo aviso sai. */
      canal: evoOk ? 'evolution' : localOk ? 'baileys' : 'nenhum',
      podeEnviar: evoOk || localOk,
      evolution: {
        ligado: this.evolutionPreferido(),
        conectado: evoOk,
        instancia: this.evo.instancia || null,
        conferidoEm: this.evoConferidoEm?.toISOString() ?? null,
      },
    };
  }

  /**
   * Normaliza número brasileiro pro formato WhatsApp (JID).
   * Usa normalizeBrPhone (suporta 8/9 dígitos sem DDD → adiciona padrão 13).
   */
  private toJid(raw: string): string | null {
    // Lazy require pra evitar circular import em alguns paths
    const { normalizeBrPhone } = require('../lib/phone-br');
    const n = normalizeBrPhone(raw);
    if (!n) return null;
    return `${n}@s.whatsapp.net`;
  }

  /**
   * Valida em batch se números têm WhatsApp ativo. Usa Baileys onWhatsApp.
   *
   * Retorna Map<numeroNormalizado, { exists, jid? }>.
   * - exists=true: tem WhatsApp
   * - exists=false: número não está no WhatsApp (cadastro errado, fixo, etc)
   * - exists=null: erro de rede / não foi possível verificar
   *
   * Limita a 200 números por chamada (Baileys aceita batch mas com cautela).
   */
  async validateNumbers(rawNumbers: string[]): Promise<Map<string, { exists: boolean | null; jid?: string }>> {
    const out = new Map<string, { exists: boolean | null; jid?: string }>();
    if (!this.sock || !this.connectedAt) {
      for (const n of rawNumbers) out.set(String(n).replace(/\D/g, ''), { exists: null });
      return out;
    }
    // dedup + normaliza
    const norm = new Map<string, string>(); // jidPlano → original
    for (const raw of rawNumbers) {
      const jid = this.toJid(raw);
      if (!jid) {
        out.set(String(raw).replace(/\D/g, ''), { exists: false });
        continue;
      }
      // chave plana sem @s.whatsapp.net pra Baileys
      const plain = jid.split('@')[0];
      norm.set(plain, String(raw).replace(/\D/g, ''));
    }
    if (norm.size === 0) return out;
    const unique = Array.from(norm.keys());
    // Limita lote
    const slice = unique.slice(0, 200);
    try {
      // onWhatsApp aceita array de números E2E. Retorna [{ jid, exists }]
      const res = await this.sock.onWhatsApp(...slice);
      const byPlain = new Map<string, any>();
      if (Array.isArray(res)) {
        for (const r of res) {
          const plain = String(r?.jid || '').split('@')[0];
          if (plain) byPlain.set(plain, r);
        }
      }
      for (const plain of slice) {
        const r = byPlain.get(plain);
        const original = norm.get(plain) || plain;
        if (r) {
          out.set(original, { exists: !!r.exists, jid: r.jid });
        } else {
          // Baileys às vezes só retorna os que existem
          out.set(original, { exists: false });
        }
      }
      // marca os que não couberam no slice como erro
      for (const plain of unique.slice(200)) {
        const original = norm.get(plain) || plain;
        out.set(original, { exists: null });
      }
    } catch (e: any) {
      this.logger.warn(`validateNumbers falhou: ${e?.message}`);
      for (const plain of slice) {
        const original = norm.get(plain) || plain;
        out.set(original, { exists: null });
      }
    }
    return out;
  }

  /**
   * Dispara 1 mensagem. Retorna `{ ok, error? }`.
   *
   * Ordem: **Evolution primeiro** (é a instância que a equipe usa e que não
   * cai), sessão Baileys como reserva. Quem chama não sabe — e não precisa
   * saber — por qual dos dois saiu.
   */
  async sendText(rawNumber: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const jid = this.toJid(rawNumber);
    if (!jid) return { ok: false, error: `Número inválido: ${rawNumber}` };
    const numero = jid.split('@')[0];

    let erroEvolution: string | null = null;
    if (this.evolutionPreferido()) {
      try {
        await this.evo.enviarTexto(numero, text);
        this.evoConectado = true;
        this.evoConferidoEm = new Date();
        return { ok: true };
      } catch (e: any) {
        // Não desiste: a sessão local ainda pode estar de pé. Mas marca o
        // Evolution como suspeito pro `getStatus` não mentir pra tela.
        erroEvolution = e?.message || String(e);
        this.evoConectado = false;
        this.evoConferidoEm = new Date();
        this.logger.warn(`[whatsapp] Evolution recusou (${erroEvolution}) — tentando a sessão local`);
      }
    }

    if (!this.sock || !this.connectedAt) {
      return {
        ok: false,
        error: erroEvolution
          ? `WhatsApp fora nos dois canais. Evolution: ${erroEvolution}. Sessão local: desconectada (QR em /config/whatsapp).`
          : 'WhatsApp desconectado. Conecte primeiro em /config/whatsapp.',
      };
    }

    try {
      await this.sock.sendMessage(jid, { text });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /** O Evolution está ligado (env) e não desligado pela flag? */
  private evolutionPreferido(): boolean {
    if (String(process.env.AVISOS_VIA_EVOLUTION ?? '1') === '0') return false;
    return this.evo.configurado();
  }

  /**
   * Confere o estado da instância do Evolution de tempos em tempos.
   *
   * 5 minutos porque a única coisa que depende disso é a BARRA de alarme na
   * tela (que já recarrega sozinha a cada minuto) — envio não espera este
   * cron: ele tenta e o resultado carimba o cache na hora.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'whatsapp-evolution-estado' })
  async conferirEvolution(): Promise<void> {
    if (!this.evolutionPreferido()) return;
    try {
      const r = await this.evo.instanciaConectada();
      this.evoConectado = !!r.ok;
      this.evoConferidoEm = new Date();
    } catch {
      this.evoConectado = false;
      this.evoConferidoEm = new Date();
    }
  }

  /**
   * Dispara lote sequencial com delay anti-spam entre mensagens.
   * Delay padrão 2500ms. Nunca fala em paralelo — Baileys trava se fizer.
   */
  async sendBulk(
    items: Array<{ number: string; text: string; tag?: string }>,
    opts: { delayMs?: number } = {},
  ): Promise<{
    total: number;
    sent: number;
    failed: Array<{ number: string; tag?: string; error: string }>;
  }> {
    const delay = Math.max(800, opts.delayMs ?? 2500);
    const failed: Array<{ number: string; tag?: string; error: string }> = [];
    let sent = 0;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = await this.sendText(it.number, it.text);
      if (r.ok) sent++;
      else failed.push({ number: it.number, tag: it.tag, error: r.error || 'erro' });

      // delay só se não for a última mensagem
      if (i < items.length - 1) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    return { total: items.length, sent, failed };
  }
}
