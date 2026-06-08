import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * EmailService — envio de emails transacionais (boas-vindas, reset, etc).
 *
 * Configuração via env (Railway):
 *   SMTP_HOST     = smtp.gmail.com (ou outro)
 *   SMTP_PORT     = 587 (TLS) ou 465 (SSL)
 *   SMTP_USER     = email@lurds.com.br
 *   SMTP_PASS     = senha-de-app
 *   SMTP_FROM     = "Lurd's Plus Size <noreply@lurds.com.br>"
 *   SMTP_SECURE   = "false" pra 587 STARTTLS, "true" pra 465 SSL
 *
 * Se SMTP_HOST não estiver setado, o service loga warn mas NÃO bloqueia o
 * cadastro do cliente — email é best-effort.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private fromAddress = 'Lurd\'s Plus Size <noreply@lurds.com.br>';

  constructor(private readonly cfg: ConfigService) {}

  onModuleInit() {
    const host = this.cfg.get<string>('SMTP_HOST');
    const port = Number(this.cfg.get<string>('SMTP_PORT') || 587);
    const user = this.cfg.get<string>('SMTP_USER');
    const pass = this.cfg.get<string>('SMTP_PASS');
    const secure = this.cfg.get<string>('SMTP_SECURE') === 'true';

    if (!host || !user || !pass) {
      this.logger.warn(
        '[email] SMTP_HOST/USER/PASS não configurados — emails desativados',
      );
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
      this.fromAddress = this.cfg.get<string>('SMTP_FROM') || this.fromAddress;
      this.logger.log(`[email] SMTP configurado (${host}:${port})`);
    } catch (e: any) {
      this.logger.error(`[email] falha ao configurar SMTP: ${e?.message || e}`);
    }
  }

  /** Envia um email. Retorna true se OK, false se falhou ou não configurado. */
  async send(to: string, subject: string, html: string, text?: string): Promise<boolean> {
    if (!this.transporter) return false;
    if (!to || !to.includes('@')) return false;

    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        html,
        text: text || stripHtml(html),
      });
      this.logger.log(`[email] enviado pra ${to}: "${subject}"`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[email] falha pra ${to}: ${e?.message || e}`);
      return false;
    }
  }

  /**
   * Email de boas-vindas LGPD-compliant.
   * Lista dados coletados, direitos do titular, e CTA pro app.
   */
  async sendWelcome(opts: {
    to: string;
    name: string | null;
    cpfMasked?: string | null;
  }): Promise<boolean> {
    const firstName = (opts.name?.split(/\s+/)[0]) || 'Cliente';
    const subject = `Bem-vinda à Lurd's, ${firstName}! 💛`;
    const appUrl =
      this.cfg.get<string>('APP_PUBLIC_URL') || 'https://app.lurds.com.br';
    const siteUrl = 'https://lurds.com.br';

    const html = buildWelcomeHtml({
      firstName,
      cpfMasked: opts.cpfMasked || null,
      email: opts.to,
      appUrl,
      siteUrl,
    });
    return this.send(opts.to, subject, html);
  }
}

/* ─────────────────── Template HTML ─────────────────── */

function buildWelcomeHtml(p: {
  firstName: string;
  cpfMasked: string | null;
  email: string;
  appUrl: string;
  siteUrl: string;
}): string {
  return /* html */ `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bem-vinda à Lurd's</title>
</head>
<body style="margin:0;padding:0;background:#f5f2ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0a0a0a;">

<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f5f2ec;">
  <tr><td align="center" style="padding:40px 16px;">

    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.06);">

      <!-- Hero -->
      <tr>
        <td style="background:#0a0a0a;padding:40px 32px;text-align:center;">
          <div style="color:#C9A961;font-family:Georgia,'Playfair Display',serif;font-size:42px;font-weight:900;letter-spacing:1px;font-style:italic;">
            Lurd's
          </div>
          <div style="color:#fff;opacity:0.6;font-size:11px;text-transform:uppercase;letter-spacing:4px;margin-top:4px;">
            Plus Size
          </div>
        </td>
      </tr>

      <!-- Saudação -->
      <tr>
        <td style="padding:32px 32px 16px 32px;">
          <h1 style="margin:0;font-family:Georgia,'Playfair Display',serif;font-size:28px;color:#0a0a0a;line-height:1.2;">
            Bem-vinda, <span style="color:#C9A961;font-style:italic;">${escape(p.firstName)}</span> 💛
          </h1>
          <p style="margin:16px 0 0 0;font-size:16px;color:#444;line-height:1.5;">
            Que alegria ter você no nosso app! Seu cadastro foi confirmado com sucesso.
          </p>
        </td>
      </tr>

      <!-- Bônus R$20 -->
      <tr>
        <td style="padding:0 32px;">
          <div style="background:linear-gradient(135deg,#C9A961,#E0C589);border-radius:12px;padding:24px;text-align:center;">
            <div style="font-size:11px;color:#0a0a0a;opacity:0.7;font-weight:bold;text-transform:uppercase;letter-spacing:3px;">
              🎁 Boas-vindas
            </div>
            <div style="font-family:Georgia,'Playfair Display',serif;font-size:36px;font-weight:900;color:#0a0a0a;margin:4px 0;">
              R$ 20 grátis
            </div>
            <div style="font-size:13px;color:#0a0a0a;opacity:0.85;">
              caem no seu cashback após a primeira compra
            </div>
          </div>
        </td>
      </tr>

      <!-- CTA -->
      <tr>
        <td style="padding:24px 32px 8px 32px;text-align:center;">
          <a href="${escape(p.appUrl)}"
             style="display:inline-block;background:#0a0a0a;color:#C9A961;text-decoration:none;font-weight:bold;text-transform:uppercase;letter-spacing:2px;font-size:13px;padding:14px 32px;border-radius:999px;">
            Abrir o app
          </a>
        </td>
      </tr>

      <!-- Divider -->
      <tr><td style="padding:24px 32px 0 32px;">
        <div style="height:1px;background:linear-gradient(to right,transparent,#C9A961,transparent);"></div>
      </td></tr>

      <!-- LGPD: dados coletados -->
      <tr>
        <td style="padding:24px 32px;">
          <h2 style="margin:0;font-family:Georgia,serif;font-size:18px;color:#0a0a0a;">
            🛡 Seus dados estão seguros
          </h2>
          <p style="margin:8px 0 0 0;font-size:14px;color:#555;line-height:1.6;">
            Conforme a <strong>Lei Geral de Proteção de Dados (LGPD)</strong>,
            informamos os dados que armazenamos:
          </p>
          <ul style="margin:12px 0 0 0;padding-left:20px;font-size:13px;color:#555;line-height:1.7;">
            ${p.cpfMasked ? `<li>CPF: <code style="background:#f5f2ec;padding:2px 6px;border-radius:4px;">${escape(p.cpfMasked)}</code></li>` : ''}
            <li>Email: <code style="background:#f5f2ec;padding:2px 6px;border-radius:4px;">${escape(p.email)}</code></li>
            <li>Nome, telefone (WhatsApp) — pra contato</li>
            <li>Histórico de compras — pra creditar cashback</li>
            <li>Preferências de notificação — só se você ativar</li>
          </ul>
        </td>
      </tr>

      <!-- LGPD: direitos -->
      <tr>
        <td style="padding:0 32px 24px 32px;">
          <h2 style="margin:0;font-family:Georgia,serif;font-size:18px;color:#0a0a0a;">
            ⚖️ Seus direitos
          </h2>
          <p style="margin:8px 0 0 0;font-size:14px;color:#555;line-height:1.6;">
            Você pode, a qualquer momento:
          </p>
          <ul style="margin:12px 0 0 0;padding-left:20px;font-size:13px;color:#555;line-height:1.7;">
            <li><strong>Acessar</strong> seus dados (em "Minha conta" no app)</li>
            <li><strong>Corrigir</strong> informações desatualizadas</li>
            <li><strong>Excluir</strong> sua conta (envie email pra <a href="mailto:contato@lurds.com.br" style="color:#C9A961;">contato@lurds.com.br</a>)</li>
            <li><strong>Revogar consentimento</strong> de notificações nas configurações</li>
            <li><strong>Portabilidade</strong> de dados — peça por email</li>
          </ul>
        </td>
      </tr>

      <!-- O que esperar -->
      <tr>
        <td style="padding:0 32px 24px 32px;">
          <h2 style="margin:0;font-family:Georgia,serif;font-size:18px;color:#0a0a0a;">
            ✨ O que esperar
          </h2>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:12px;">
            <tr>
              <td width="33%" align="center" style="padding:8px;">
                <div style="font-size:24px;">💰</div>
                <div style="font-size:11px;color:#0a0a0a;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">10% Cashback</div>
                <div style="font-size:11px;color:#666;margin-top:2px;">em todas as compras</div>
              </td>
              <td width="33%" align="center" style="padding:8px;">
                <div style="font-size:24px;">🔔</div>
                <div style="font-size:11px;color:#0a0a0a;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Promoções</div>
                <div style="font-size:11px;color:#666;margin-top:2px;">em primeira mão</div>
              </td>
              <td width="33%" align="center" style="padding:8px;">
                <div style="font-size:24px;">📺</div>
                <div style="font-size:11px;color:#0a0a0a;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-top:4px;">Lives</div>
                <div style="font-size:11px;color:#666;margin-top:2px;">aviso antes de começar</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f5f2ec;padding:24px 32px;text-align:center;border-top:1px solid #ebe4d4;">
          <p style="margin:0;font-size:11px;color:#888;line-height:1.6;">
            Você recebeu este email porque se cadastrou em <a href="${escape(p.appUrl)}" style="color:#C9A961;">${escape(stripScheme(p.appUrl))}</a>.<br>
            <a href="${escape(p.siteUrl)}/termos-de-uso" style="color:#888;">Termos de Uso</a> ·
            <a href="${escape(p.siteUrl)}/politica-de-privacidade" style="color:#888;">Privacidade</a> ·
            <a href="mailto:contato@lurds.com.br" style="color:#888;">Contato</a>
          </p>
          <p style="margin:12px 0 0 0;font-size:10px;color:#aaa;">
            © Lurd's Plus Size — Moda Plus<br>
            Brasil
          </p>
        </td>
      </tr>

    </table>

  </td></tr>
</table>

</body>
</html>
  `.trim();
}

function escape(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}
