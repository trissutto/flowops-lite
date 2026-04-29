import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';

/**
 * WhatsappCobrancaService — instância DEDICADA pra cobrança.
 *
 * Idêntico ao WhatsappService (site) mas:
 *   - Sessão Baileys em diretório próprio (WA_COBRANCA_SESSION_DIR)
 *   - Browser identificado como "Lurd's Cobranca" pra distinguir no app
 *   - sendBulk respeita HORA INÍCIO / HORA FIM e INTERVALO configuráveis
 *     via SystemSetting (chaves cobranca_hora_inicio, _fim, _intervalo_seg)
 *   - Pausa 5min a cada 50 mensagens (anti-block aprendido na prática)
 *
 * Roda em paralelo com o WhatsappService do site sem interferir.
 */
@Injectable()
export class WhatsappCobrancaService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappCobrancaService.name);

  private sock: any = null;
  private lastQr: string | null = null;
  private ownNumber: string | null = null;
  private connecting = false;
  private connectedAt: Date | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private sessionDir(): string {
    const dir = process.env.WA_COBRANCA_SESSION_DIR || '/tmp/wa-cobranca-session';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async onModuleInit() {
    const dir = this.sessionDir();
    const hasSession = fs.existsSync(path.join(dir, 'creds.json'));
    if (hasSession) {
      this.logger.log('Sessão WhatsApp Cobrança encontrada — reconectando…');
      this.connect().catch((e) => this.logger.error(`Falha reconexão cobrança: ${e?.message}`));
    } else {
      this.logger.warn('Sem sessão WhatsApp Cobrança. Aguardando /whatsapp/cobranca/connect.');
    }
  }

  async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const makeWASocket = baileys.default;
      const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir());
      const { version } = await fetchLatestBaileysVersion();
      const pino = (await import('pino')).default;
      const silent = pino({ level: 'silent' });

      this.sock = makeWASocket({
        version,
        auth: state,
        logger: silent,
        printQRInTerminal: false,
        browser: ["Lurd's Cobranca", 'Chrome', '120'],
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            this.lastQr = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
            this.logger.log('QR cobrança gerado.');
          } catch (e: any) {
            this.logger.error(`Falha gerar QR cobrança: ${e?.message}`);
          }
        }
        if (connection === 'open') {
          this.lastQr = null;
          this.connectedAt = new Date();
          const me = this.sock?.user?.id || '';
          this.ownNumber = me.split('@')[0]?.split(':')[0] || null;
          this.logger.log(`WhatsApp Cobrança conectado. Número: ${this.ownNumber}`);
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;
          this.logger.warn(`Cobrança fechou (code=${code}). Reconnect=${shouldReconnect}`);
          this.connectedAt = null;
          this.ownNumber = null;
          this.sock = null;
          if (shouldReconnect) {
            setTimeout(() => {
              this.connecting = false;
              this.connect().catch((e) => this.logger.error(`Reconnect cobrança falhou: ${e?.message}`));
            }, 3000);
          } else {
            this.logger.warn('Sessão cobrança deslogada. Limpando disco.');
            this.wipeSession();
          }
        }
      });

      await new Promise((r) => setTimeout(r, 500));
    } finally {
      this.connecting = false;
    }
  }

  async logout(): Promise<void> {
    try { if (this.sock) await this.sock.logout(); } catch (e: any) { this.logger.warn(`Logout cobrança erro: ${e?.message}`); }
    this.sock = null;
    this.connectedAt = null;
    this.ownNumber = null;
    this.lastQr = null;
    this.wipeSession();
  }

  private wipeSession() {
    const dir = this.sessionDir();
    try {
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    } catch (e: any) {
      this.logger.error(`Erro limpando sessão cobrança: ${e?.message}`);
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

  private toJid(raw: string): string | null {
    if (!raw) return null;
    let n = String(raw).replace(/\D/g, '');
    if (!n) return null;
    if (n.startsWith('0')) n = n.slice(1);
    if (n.length === 10 || n.length === 11) n = '55' + n;
    if (n.length < 12) return null;
    return `${n}@s.whatsapp.net`;
  }

  async sendText(rawNumber: string, text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.sock || !this.connectedAt) {
      return { ok: false, error: 'WhatsApp Cobrança desconectado. Conecte em /config/whatsapp-cobranca.' };
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

  // ───────────────────────────────────────────────────────────────────────
  // CONFIG: HORÁRIO + INTERVALO (lê SystemSetting via Prisma)
  // ───────────────────────────────────────────────────────────────────────

  async readConfig(): Promise<{
    horaInicio: string;   // 'HH:MM'
    horaFim: string;
    intervaloSeg: number;
    pausaACada: number;
    pausaSeg: number;
  }> {
    const get = async (key: string, def: string) => {
      const r = await (this.prisma as any).systemSetting.findUnique({ where: { key } }).catch(() => null);
      return r?.value ?? def;
    };
    return {
      horaInicio: await get('cobranca_hora_inicio', '09:00'),
      horaFim:    await get('cobranca_hora_fim', '18:00'),
      intervaloSeg: Number(await get('cobranca_intervalo_seg', '45')),
      pausaACada:   Number(await get('cobranca_pausa_a_cada', '50')),
      pausaSeg:     Number(await get('cobranca_pausa_seg', '300')),
    };
  }

  async saveConfig(input: Partial<{
    horaInicio: string;
    horaFim: string;
    intervaloSeg: number;
    pausaACada: number;
    pausaSeg: number;
  }>): Promise<void> {
    const upsert = async (key: string, value: string) => {
      await (this.prisma as any).systemSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    };
    if (input.horaInicio !== undefined)  await upsert('cobranca_hora_inicio', String(input.horaInicio));
    if (input.horaFim !== undefined)     await upsert('cobranca_hora_fim', String(input.horaFim));
    if (input.intervaloSeg !== undefined) await upsert('cobranca_intervalo_seg', String(Math.max(15, Math.min(600, input.intervaloSeg)))); // 15s a 10min
    if (input.pausaACada !== undefined)   await upsert('cobranca_pausa_a_cada', String(Math.max(10, Math.min(200, input.pausaACada))));
    if (input.pausaSeg !== undefined)     await upsert('cobranca_pausa_seg', String(Math.max(60, Math.min(1800, input.pausaSeg))));
  }

  /** Verifica se o horário ATUAL está dentro da janela configurada. */
  async isWithinSchedule(date = new Date()): Promise<{ ok: boolean; reason?: string; cfg?: any }> {
    const cfg = await this.readConfig();
    const [hi, mi] = cfg.horaInicio.split(':').map(Number);
    const [hf, mf] = cfg.horaFim.split(':').map(Number);
    const nowMin = date.getHours() * 60 + date.getMinutes();
    const startMin = hi * 60 + (mi || 0);
    const endMin = hf * 60 + (mf || 0);
    if (nowMin < startMin) return { ok: false, reason: `antes de ${cfg.horaInicio}`, cfg };
    if (nowMin > endMin)   return { ok: false, reason: `depois de ${cfg.horaFim}`, cfg };
    return { ok: true, cfg };
  }

  /**
   * Bulk respeitando intervalo + pausas + horário.
   * Se sair da janela mid-bulk, ABORTA e retorna o que conseguiu enviar.
   */
  async sendBulkRespecting(
    items: Array<{ number: string; text: string; tag?: string }>,
  ): Promise<{
    total: number;
    sent: number;
    failed: Array<{ number: string; tag?: string; error: string }>;
    abortedReason?: string;
  }> {
    const cfg = await this.readConfig();
    const failed: Array<{ number: string; tag?: string; error: string }> = [];
    let sent = 0;

    for (let i = 0; i < items.length; i++) {
      // Re-check janela a cada mensagem (importante pra rodadas longas)
      const sched = await this.isWithinSchedule();
      if (!sched.ok) {
        return { total: items.length, sent, failed, abortedReason: `Fora do horário: ${sched.reason}` };
      }

      const it = items[i];
      const r = await this.sendText(it.number, it.text);
      if (r.ok) sent++;
      else failed.push({ number: it.number, tag: it.tag, error: r.error || 'erro' });

      // pausa de bloco (a cada N mensagens)
      if (sent > 0 && sent % cfg.pausaACada === 0 && i < items.length - 1) {
        this.logger.log(`Cobrança: pausa de ${cfg.pausaSeg}s após ${sent} envios (anti-block)`);
        await new Promise((r) => setTimeout(r, cfg.pausaSeg * 1000));
        continue;
      }

      // intervalo regular entre mensagens (com jitter ±20% pra parecer humano)
      if (i < items.length - 1) {
        const base = cfg.intervaloSeg * 1000;
        const jitter = (Math.random() * 0.4 - 0.2) * base; // ±20%
        await new Promise((r) => setTimeout(r, Math.max(800, base + jitter)));
      }
    }

    return { total: items.length, sent, failed };
  }
}
