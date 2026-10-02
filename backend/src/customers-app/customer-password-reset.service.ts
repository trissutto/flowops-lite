import {
  BadRequestException, Injectable, Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { EmailService } from '../email/email.service';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/**
 * Reset de senha da conta da cliente (app e site — a conta é a mesma).
 *
 * Fluxo:
 *  1. Cliente esqueceu senha → digita CPF
 *  2. Backend gera código 6 dígitos e manda no WhatsApp E no e-mail do cadastro
 *  3. Cliente recebe código → digita código + nova senha
 *  4. Backend valida (15 min, 3 tentativas) → atualiza passwordHash
 *
 * Segurança:
 *   - Código guarda em HASH (mesmo se vazar DB, atacante não usa)
 *   - Rate limit: 1 código a cada 60s por account
 *   - 3 tentativas erradas = invalida código
 *
 * ── A RESPOSTA CONTA A VERDADE (02/10/2026) ──
 *
 * Até aqui o pedido de código respondia `sent: true` SEMPRE: sem conta, sem
 * telefone, WhatsApp fora do ar. A ideia era não revelar se o CPF tem conta —
 * mas o cadastro já responde 409 "CPF já cadastrado" e o `lookup` é público,
 * então o silêncio não protegia nada e prendia a cliente: a tela dizia
 * "enviamos um código" e ele nunca chegava (caso real de 02/10, atendimento
 * sem saída). Agora quem pede sabe o que aconteceu:
 *
 *   · `sem_conta`    → este CPF não tem conta; o caminho é criar uma.
 *   · `sem_contato`  → a conta não tem WhatsApp nem e-mail; só o atendimento.
 *   · `falha_envio`  → tinha pra onde mandar e nenhum canal entregou.
 *   · `aguarde`      → já saiu um código há menos de 60s; ele continua valendo.
 *
 * E o código que não saiu por NENHUM canal é apagado na hora: token que
 * ninguém recebeu só serviria pra travar o próximo pedido no limite de 60s.
 */

export type MotivoPedidoCodigo = 'sem_conta' | 'sem_contato' | 'falha_envio' | 'aguarde';

export interface PedidoCodigoResultado {
  sent: boolean;
  motivo?: MotivoPedidoCodigo;
  /** Só vem quando o código SAIU por aquele canal. */
  phoneMasked?: string;
  emailMasked?: string;
}

@Injectable()
export class CustomerPasswordResetService {
  private readonly logger = new Logger(CustomerPasswordResetService.name);
  private readonly TTL_MIN = 15;
  private readonly MAX_ATTEMPTS = 3;
  private readonly RATE_LIMIT_SEC = 60;
  /** Mesmo piso do cadastro e do login (`AppRegisterDto`/`AppLoginDto`). */
  private readonly SENHA_MIN = 4;

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
    private readonly email: EmailService,
  ) {}

  /** Pede o código. Ver o cabeçalho: a resposta diz o que de fato aconteceu. */
  async requestReset(cpfDigits: string): Promise<PedidoCodigoResultado> {
    if (!/^\d{11}$/.test(cpfDigits)) {
      return { sent: false, motivo: 'sem_conta' };
    }

    const account = await this.prisma.customerAccount.findUnique({
      where: { cpf: cpfDigits },
    });

    if (!account) {
      this.logger.log(`Reset solicitado pra CPF sem conta: ${cpfDigits.slice(0, 3)}***`);
      return { sent: false, motivo: 'sem_conta' };
    }

    const telefone = String(account.phone || '').replace(/\D/g, '');
    const email = String(account.email || '').trim();
    if (!telefone && !email) {
      this.logger.warn(`Reset: account ${account.id} não tem WhatsApp nem e-mail — sem pra onde mandar`);
      return { sent: false, motivo: 'sem_contato' };
    }

    // Rate limit: ÚLTIMO token < 60s? Token só sobrevive se saiu por algum
    // canal (ver abaixo), então "aguarde" quer dizer "o anterior chegou".
    const recent = await this.prisma.customerPasswordResetToken.findFirst({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      const elapsed = (Date.now() - recent.createdAt.getTime()) / 1000;
      if (elapsed < this.RATE_LIMIT_SEC) {
        return {
          sent: true,
          motivo: 'aguarde',
          ...(telefone ? { phoneMasked: maskPhone(telefone) } : {}),
          ...(email ? { emailMasked: maskEmail(email) } : {}),
        };
      }
    }

    // Gera código 6 dígitos
    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, 8);

    const token = await this.prisma.customerPasswordResetToken.create({
      data: {
        accountId: account.id,
        code: codeHash,
        expiresAt: new Date(Date.now() + this.TTL_MIN * 60 * 1000),
      },
    });

    // Os dois canais em paralelo: o WhatsApp do cadastro pode ser um número
    // antigo (a conta herda o telefone do CRM da loja), e boa parte das
    // clientes espera o código no e-mail. Um não espera o outro.
    const [zap, mail] = await Promise.all([
      telefone ? this.sendWhatsApp(telefone, code, account.name) : Promise.resolve('sem destino'),
      email ? this.sendEmail(email, code, account.name) : Promise.resolve('sem destino'),
    ]);
    const saiuZap = zap === null;
    const saiuMail = mail === null;

    if (!saiuZap && !saiuMail) {
      this.logger.error(
        `Reset: código da account ${account.id} NÃO SAIU por nenhum canal — ` +
          `WhatsApp: ${zap} · e-mail: ${mail}`,
      );
      await this.prisma.customerPasswordResetToken
        .delete({ where: { id: token.id } })
        .catch(() => undefined);
      return { sent: false, motivo: 'falha_envio' };
    }

    if (!saiuZap && telefone) this.logger.warn(`Reset: WhatsApp falhou (${zap}) — código saiu só por e-mail`);
    if (!saiuMail && email) this.logger.warn(`Reset: e-mail falhou (${mail}) — código saiu só por WhatsApp`);

    return {
      sent: true,
      ...(saiuZap ? { phoneMasked: maskPhone(telefone) } : {}),
      ...(saiuMail ? { emailMasked: maskEmail(email) } : {}),
    };
  }

  /**
   * Valida código + atualiza senha.
   */
  async confirmReset(cpfDigits: string, code: string, newPassword: string) {
    if (!/^\d{11}$/.test(cpfDigits)) throw new BadRequestException('CPF inválido');
    if (!/^\d{6}$/.test(String(code || ''))) {
      throw new BadRequestException('O código tem 6 números. Confira e tente de novo.');
    }
    // O piso era 6 aqui e 4 no cadastro/login: a cliente que escolhia de novo
    // uma senha de 4 ou 5 dígitos (o costume da conta de loja) era recusada —
    // e o site traduzia a recusa como "código inválido".
    if (String(newPassword || '').length < this.SENHA_MIN) {
      throw new BadRequestException(`A senha precisa ter ao menos ${this.SENHA_MIN} dígitos.`);
    }

    const account = await this.prisma.customerAccount.findUnique({
      where: { cpf: cpfDigits },
    });
    if (!account) throw new UnauthorizedException('CPF não encontrado');

    const token = await this.prisma.customerPasswordResetToken.findFirst({
      where: {
        accountId: account.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: this.MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      throw new UnauthorizedException(
        'Código expirado ou inválido. Solicite um novo.',
      );
    }

    const ok = await bcrypt.compare(code, token.code);
    if (!ok) {
      await this.prisma.customerPasswordResetToken.update({
        where: { id: token.id },
        data: { attempts: { increment: 1 } },
      });
      const restam = this.MAX_ATTEMPTS - token.attempts - 1;
      throw new UnauthorizedException(
        restam > 0
          ? `Código incorreto. Restam ${restam} tentativa(s).`
          : 'Código incorreto. Peça um código novo.',
      );
    }

    // Atualiza senha + invalida token
    const newHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.$transaction([
      this.prisma.customerAccount.update({
        where: { id: account.id },
        data: { passwordHash: newHash },
      }),
      this.prisma.customerPasswordResetToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      }),
    ]);

    this.logger.log(`Senha resetada com sucesso pra account ${account.id}`);
    return { success: true };
  }

  /* ─────────────────────── Helpers ─────────────────────── */

  /** Devolve `null` quando saiu, ou o motivo da falha (nunca lança). */
  private async sendWhatsApp(phone: string, code: string, name: string | null): Promise<string | null> {
    const message =
      `Olá ${name?.split(' ')[0] || 'cliente'}! 💛\n\n` +
      `Seu código pra trocar a senha da sua conta Lurd's:\n\n` +
      `*${code}*\n\n` +
      `Vale por 15 minutos. Não compartilhe com ninguém.\n\n` +
      `Se você não pediu, ignore esta mensagem.`;

    try {
      // Evolution primeiro, sessão local de reserva — quem decide é o WhatsappService.
      const result = await this.whatsapp.sendText(phone, message);
      return result.ok ? null : result.error || 'WhatsApp recusou';
    } catch (e: any) {
      return e?.message || String(e);
    }
  }

  /** Devolve `null` quando saiu, ou o motivo da falha (nunca lança). */
  private async sendEmail(to: string, code: string, name: string | null): Promise<string | null> {
    const primeiroNome = name?.split(' ')[0] || 'Olá';
    try {
      const ok = await this.email.send(
        to,
        `${code} é o seu código da Lurd's`,
        `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#2A2620">
          <h2 style="color:#8C7325">Trocar a senha da sua conta</h2>
          <p>${primeiroNome}, use o código abaixo pra escolher uma senha nova:</p>
          <p style="font-size:30px;font-weight:bold;background:#FBF6E6;border:2px dashed #B8912B;border-radius:12px;padding:16px;text-align:center;letter-spacing:6px">${code}</p>
          <p>Vale por 15 minutos. Não compartilhe com ninguém.</p>
          <p style="font-size:12px;color:#777">Se você não pediu, é só ignorar este e-mail — sua senha continua a mesma.</p>
        </div>`,
        `${primeiroNome}, seu código pra trocar a senha da conta Lurd's: ${code}. Vale por 15 minutos. Se você não pediu, ignore.`,
      );
      return ok ? null : 'SMTP não configurado ou envio recusado';
    } catch (e: any) {
      return e?.message || String(e);
    }
  }
}

function maskPhone(phone: string | null): string {
  if (!phone) return '****';
  const d = phone.replace(/\D/g, '');
  if (d.length < 4) return '****';
  return `****-${d.slice(-4)}`;
}

/** `maria.silva@gmail.com` → `ma***@gmail.com`. */
function maskEmail(email: string): string {
  const [usuario, dominio] = String(email).split('@');
  if (!usuario || !dominio) return '***';
  return `${usuario.slice(0, 2)}***@${dominio}`;
}
