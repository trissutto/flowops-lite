import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';

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
 */
@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);

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

  async onModuleInit() {
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
      const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir());
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

  getStatus() {
    return {
      connected: !!this.sock && !!this.connectedAt,
      phoneNumber: this.ownNumber,
      connectedAt: this.connectedAt?.toISOString() ?? null,
      qr: this.lastQr,
    };
  }

  /**
   * Normaliza número brasileiro pro formato WhatsApp (JID):
   *   - Remove tudo que não é dígito
   *   - Se começa com 0, remove
   *   - Se tem 10 ou 11 dígitos (sem 55), prefixa 55
   *   - Resultado: 55 + DDD + número → JID "55XXXXXXXXXXX@s.whatsapp.net"
   */
  private toJid(raw: string): string | null {
    if (!raw) return null;
    let n = String(raw).replace(/\D/g, '');
    if (!n) return null;
    if (n.startsWith('0')) n = n.slice(1);
    // 10 (fixo sem 55) ou 11 (celular sem 55) → prefixa 55
    if (n.length === 10 || n.length === 11) n = '55' + n;
    // 12 ou 13 já deve ter 55 na frente
    if (n.length < 12) return null;
    return `${n}@s.whatsapp.net`;
  }

  /** Dispara 1 mensagem. Retorna `{ ok, error? }`. */
  async sendText(rawNumber: string, text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.sock || !this.connectedAt) {
      return { ok: false, error: 'WhatsApp desconectado. Conecte primeiro em /retaguarda/whatsapp.' };
    }
    const jid = this.toJid(rawNumber);
    if (!jid) return { ok: false, error: `Número inválido: ${rawNumber}` };

    try {
      await this.sock.sendMessage(jid, { text });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
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
