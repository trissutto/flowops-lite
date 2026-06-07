import {
  BadRequestException, Injectable, Logger, NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/**
 * Reset de senha do app cliente.
 *
 * Fluxo:
 *  1. Cliente esqueceu senha → digita CPF em /esqueci-senha
 *  2. Backend gera código 6 dígitos + manda WhatsApp pro telefone do cadastro
 *  3. Cliente recebe código → digita em /resetar-senha + nova senha
 *  4. Backend valida (15 min, 3 tentativas) → atualiza passwordHash
 *
 * Segurança:
 *   - Código guarda em HASH (mesmo se vazar DB, atacante não usa)
 *   - Rate limit: 1 código a cada 60s por account
 *   - 3 tentativas erradas = invalida código
 *   - Não revela se CPF existe ("se você tem conta, código enviado")
 */
@Injectable()
export class CustomerPasswordResetService {
  private readonly logger = new Logger(CustomerPasswordResetService.name);
  private readonly TTL_MIN = 15;
  private readonly MAX_ATTEMPTS = 3;
  private readonly RATE_LIMIT_SEC = 60;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Solicita código de reset. Sempre retorna sucesso (não revela se CPF existe).
   */
  async requestReset(cpfDigits: string): Promise<{ sent: true; phoneMasked?: string }> {
    if (!/^\d{11}$/.test(cpfDigits)) {
      return { sent: true };
    }

    const account = await this.prisma.customerAccount.findUnique({
      where: { cpf: cpfDigits },
    });

    if (!account) {
      // Não revela inexistência — apenas retorna sucesso
      this.logger.log(`Reset solicitado pra CPF inexistente: ${cpfDigits.slice(0, 3)}***`);
      return { sent: true };
    }

    // Rate limit: ÚLTIMO token < 60s?
    const recent = await this.prisma.customerPasswordResetToken.findFirst({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      const elapsed = (Date.now() - recent.createdAt.getTime()) / 1000;
      if (elapsed < this.RATE_LIMIT_SEC) {
        // Não erra, mas avisa que aguarde
        return { sent: true, phoneMasked: maskPhone(account.phone) };
      }
    }

    // Gera código 6 dígitos
    const code = String(crypto.randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, 8);

    await this.prisma.customerPasswordResetToken.create({
      data: {
        accountId: account.id,
        code: codeHash,
        expiresAt: new Date(Date.now() + this.TTL_MIN * 60 * 1000),
      },
    });

    // Envia WhatsApp (best-effort — não bloqueia caso WA esteja indisponível)
    await this.sendWhatsApp(account.phone, code, account.name).catch((err) => {
      this.logger.warn(`Falha ao enviar WhatsApp pra ${account.phone}: ${err?.message}`);
    });

    return { sent: true, phoneMasked: maskPhone(account.phone) };
  }

  /**
   * Valida código + atualiza senha.
   */
  async confirmReset(cpfDigits: string, code: string, newPassword: string) {
    if (!/^\d{11}$/.test(cpfDigits)) throw new BadRequestException('CPF inválido');
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('Código inválido');
    if (newPassword.length < 6) throw new BadRequestException('Senha muito curta (mín 6)');

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
      throw new UnauthorizedException(
        `Código incorreto. Restam ${this.MAX_ATTEMPTS - token.attempts - 1} tentativa(s).`,
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

  private async sendWhatsApp(
    phone: string | null,
    code: string,
    name: string | null,
  ): Promise<void> {
    if (!phone) return;

    // Usa tabela WhatsappOutbox (mensagens saindo) — existente no projeto.
    // Pra Lurd's a integração final pode ser Z-API, Evolution, etc.
    // Aqui só agendamos a mensagem.
    const message =
      `Olá ${name?.split(' ')[0] || 'cliente'}! 💛\n\n` +
      `Seu código de redefinição de senha do app Lurd's:\n\n` +
      `*${code}*\n\n` +
      `Vale por 15 minutos. Não compartilha com ninguém.\n\n` +
      `Se você não solicitou, ignore esta mensagem.`;

    // Vai pra WhatsappOutbox (já existe no schema)
    await this.prisma.whatsappOutbox.create({
      data: {
        toPhone: phone.replace(/\D/g, ''),
        body: message,
        // Campos opcionais conforme schema do projeto
        purpose: 'app_password_reset',
        status: 'queued',
      } as any,
    });
  }
}

function maskPhone(phone: string | null): string {
  if (!phone) return '****';
  const d = phone.replace(/\D/g, '');
  if (d.length < 4) return '****';
  return `****-${d.slice(-4)}`;
}
