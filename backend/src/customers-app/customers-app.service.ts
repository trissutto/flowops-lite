import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AppLoginDto, AppRegisterDto } from './dto/app-auth.dto';

/**
 * Service do app cliente final (PWA app.lurds.com.br).
 *
 * ARQUITETURA — Opção C:
 *   - CustomerAccount   → IDENTIDADE DO APP (1 por pessoa, chave = CPF)
 *   - Customer          → CADASTRO POR LOJA (1 por loja Giga onde comprou)
 *   - CustomerAccountLink → vínculo N:1
 *
 * No register, vinculamos automaticamente o novo CustomerAccount a TODOS os
 * Customer existentes com mesmo CPF (de N lojas Giga diferentes). Cashback
 * fica unificado no account.
 */
@Injectable()
export class CustomersAppService {
  private readonly logger = new Logger(CustomersAppService.name);

  // Bônus de boas-vindas — em centavos. Configurável via env.
  private readonly WELCOME_BONUS_CENTS: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cfg: ConfigService,
  ) {
    this.WELCOME_BONUS_CENTS =
      this.cfg.get<number>('APP_WELCOME_BONUS_CENTS') ?? 2000;
  }

  /* ─────────────────── REGISTER ─────────────────── */
  /**
   * Cria CustomerAccount (1 por CPF). Se a pessoa já tem N Customer no banco
   * (do ETL Giga), vincula AUTOMATICAMENTE todos a esse account.
   *
   * Erros tratados:
   *   - 409 Conflict: CPF já tem CustomerAccount → cliente deve fazer login.
   *   - 400 Bad Request: email duplicado entre accounts.
   */
  async register(dto: AppRegisterDto) {
    // 1) Conflito por CPF
    const existing = await this.prisma.customerAccount.findUnique({
      where: { cpf: dto.cpf },
    });
    if (existing) {
      throw new ConflictException(
        'CPF já cadastrado no app. Faça login ou recupere sua senha.',
      );
    }

    // 2) Email opcional — verifica se já está em outro account
    let safeEmail: string | undefined = dto.email || undefined;
    if (safeEmail) {
      const taken = await this.prisma.customerAccount.findUnique({
        where: { email: safeEmail },
        select: { id: true },
      });
      if (taken) {
        // Não bloqueia — cliente pode setar depois em /conta/dados
        this.logger.warn(
          `Email ${safeEmail} já em outro account; criando sem email.`,
        );
        safeEmail = undefined;
      }
    }

    // 3) Acha TODOS Customers com mesmo CPF (vamos linkar todos)
    const customers = await this.prisma.customer.findMany({
      where: { cpf: dto.cpf },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        whatsapp: true,
        email: true,
      },
    });

    // Pega dados "melhor disponível" se Customer já existir (Giga ETL).
    // Pessoa de loja física pode ter cadastro mais rico que o que digita aqui.
    const sourceName = customers[0]?.name || dto.name;
    const sourcePhone = customers[0]?.phone || dto.phone;

    const hash = await bcrypt.hash(dto.password, 10);

    // 4) Cria CustomerAccount + links em UMA transação
    try {
      const account = await this.prisma.$transaction(async (tx) => {
        const acc = await tx.customerAccount.create({
          data: {
            cpf: dto.cpf,
            name: sourceName,
            phone: sourcePhone,
            email: safeEmail,
            passwordHash: hash,
            lastLoginAt: new Date(),
          },
        });

        // Vincula a todos Customer encontrados — o mais antigo vira primary
        if (customers.length > 0) {
          await tx.customerAccountLink.createMany({
            data: customers.map((c, idx) => ({
              accountId: acc.id,
              customerId: c.id,
              isPrimary: idx === 0,
            })),
          });
          this.logger.log(
            `Account ${acc.id} (CPF ${dto.cpf}) vinculado a ${customers.length} Customer(s) existente(s)`,
          );
        } else {
          this.logger.log(
            `Account ${acc.id} (CPF ${dto.cpf}) criado sem Customer vinculado (cliente novo na rede)`,
          );
        }

        return acc;
      });

      const token = this.signToken(account);
      return {
        token,
        customer: this.publicAccount(account),
        bonusPending: this.WELCOME_BONUS_CENTS / 100,
        linkedCustomers: customers.length,
      };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const fields = (err.meta?.target as string[] | undefined)?.join(', ');
        throw new ConflictException(
          `Cadastro duplicado em: ${fields || 'campo único'}. Tente fazer login.`,
        );
      }
      this.logger.error(`register falhou: ${err?.message || err}`);
      throw err;
    }
  }

  /* ─────────────────── LOGIN ─────────────────── */

  async login(dto: AppLoginDto) {
    const account = await this.prisma.customerAccount.findUnique({
      where: { cpf: dto.cpf },
    });
    if (!account) {
      throw new UnauthorizedException('CPF não cadastrado no app');
    }

    const ok = await bcrypt.compare(dto.password, account.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Senha incorreta');
    }

    await this.prisma.customerAccount.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() },
    });

    const token = this.signToken(account);
    return {
      token,
      customer: this.publicAccount(account),
    };
  }

  /* ─────────────────── ME ─────────────────── */
  /**
   * Retorna dados consolidados: account + soma de TODOS Customer linkados.
   */
  async me(accountId: string) {
    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      include: {
        links: {
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                ltvCents: true,
                orderCount: true,
                lastOrderAt: true,
                vipTier: true,
                originStoreId: true,
              },
            },
          },
        },
      },
    });
    if (!account) throw new UnauthorizedException('Conta não encontrada');

    // Consolida ltv, pedidos, última compra de todos os Customer vinculados
    let ltvCents = 0n;
    let orderCount = 0;
    let lastOrderAt: Date | null = null;
    for (const link of account.links) {
      ltvCents += link.customer.ltvCents;
      orderCount += link.customer.orderCount;
      if (
        link.customer.lastOrderAt &&
        (!lastOrderAt || link.customer.lastOrderAt > lastOrderAt)
      ) {
        lastOrderAt = link.customer.lastOrderAt;
      }
    }

    return {
      ...this.publicAccount(account),
      cashback: {
        balance: account.cashbackBalanceCents / 100,
        earned: Number(account.cashbackEarnedCents) / 100,
        spent: Number(account.cashbackSpentCents) / 100,
      },
      stats: {
        ltvBrl: Number(ltvCents) / 100,
        orderCount,
        lastOrderAt,
        linkedStoresCount: account.links.length,
      },
      pwaInstalled: !!account.pwaInstalledAt,
      welcomeBonusReceived: !!account.welcomeBonusAt,
    };
  }

  /* ─────────────────── PWA INSTALLED ─────────────────── */

  async markPwaInstalled(accountId: string) {
    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { pwaInstalledAt: true },
    });
    if (!account) throw new UnauthorizedException('Conta não encontrada');

    if (account.pwaInstalledAt) {
      return { alreadyMarked: true, pwaInstalledAt: account.pwaInstalledAt };
    }

    const now = new Date();
    await this.prisma.customerAccount.update({
      where: { id: accountId },
      data: { pwaInstalledAt: now },
    });

    this.logger.log(`Account ${accountId} instalou o PWA`);
    return { alreadyMarked: false, pwaInstalledAt: now };
  }

  /* ─────────────────── PUSH OPT-IN ─────────────────── */

  async setPushOptIn(accountId: string, optIn: boolean) {
    await this.prisma.customerAccount.update({
      where: { id: accountId },
      data: { pushOptIn: optIn },
    });
    return { optIn };
  }

  /* ─────────────────── HELPERS ─────────────────── */

  private signToken(account: {
    id: string;
    cpf: string;
    name: string | null;
  }) {
    return this.jwt.sign(
      {
        sub: account.id,
        cpf: account.cpf,
        name: account.name,
        scope: 'customer',
      },
      { expiresIn: '30d' },
    );
  }

  private publicAccount(a: {
    id: string;
    cpf: string;
    name: string | null;
    phone: string | null;
    email: string | null;
  }) {
    return {
      id: a.id,
      name: a.name,
      cpf: maskCpfPublic(a.cpf),
      phone: a.phone,
      email: a.email,
    };
  }
}

/** Mascarar CPF na resposta pública: 123.***.***-45 */
function maskCpfPublic(cpf: string): string {
  if (!cpf || cpf.length !== 11) return cpf;
  return `${cpf.slice(0, 3)}.***.***-${cpf.slice(9, 11)}`;
}
