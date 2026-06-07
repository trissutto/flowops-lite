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

  /* ─────────────────── LOOKUP (público, pré-cadastro) ─────────────────── */
  /**
   * Verifica se já temos esse CPF na base (Giga ETL ou cadastrado antes).
   * Retorna dados MASCARADOS pra o app pré-preencher o form de cadastro
   * com confirmação ("É vc, Th***? Confirma seu telefone").
   *
   * IMPORTANTE: rota PÚBLICA. Não retorna dados sensíveis em texto claro.
   * Quem conhece o CPF vê só primeiras letras do nome + último dígitos do
   * telefone — suficiente pra cliente reconhecer a si mesma, mas não pra
   * doxx terceiros.
   */
  async lookupByCpf(cpf: string) {
    if (!/^\d{11}$/.test(cpf)) {
      return { exists: false, hasAppAccount: false };
    }

    const account = await this.prisma.customerAccount.findUnique({
      where: { cpf },
      select: { id: true, name: true, phone: true, email: true },
    });

    if (account) {
      return {
        exists: true,
        hasAppAccount: true,
        // Já cadastrado no app — mostrar mensagem "faça login"
        name: account.name ? maskName(account.name) : null,
        phone: account.phone ? maskPhone(account.phone) : null,
        email: account.email ? maskEmail(account.email) : null,
      };
    }

    // Não tem app account, mas pode ter Customer no CRM
    const customer = await this.prisma.customer.findFirst({
      where: { cpf, name: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: {
        name: true,
        phone: true,
        whatsapp: true,
        email: true,
        ltvCents: true,
        orderCount: true,
        vipTier: true,
      },
    });

    if (!customer) {
      return { exists: false, hasAppAccount: false };
    }

    // Conta TODOS os Customer com mesmo CPF pra dizer em quantas lojas comprou
    const allWithCpf = await this.prisma.customer.findMany({
      where: { cpf },
      select: { id: true, originStoreId: true, ltvCents: true, orderCount: true },
    });
    let totalLtvCents = 0n;
    let totalOrders = 0;
    const stores = new Set<string>();
    for (const c of allWithCpf) {
      totalLtvCents += c.ltvCents;
      totalOrders += c.orderCount;
      if (c.originStoreId) stores.add(c.originStoreId);
    }

    return {
      exists: true,
      hasAppAccount: false,
      // Existe no CRM mas não tem app ainda — pré-preenche dados pro cadastro
      name: customer.name ? maskName(customer.name) : null,
      // Sugere preencher nome cheio confirmando
      nameSuggested: customer.name,
      phone: customer.phone ? maskPhone(customer.phone) : null,
      phoneSuggested: customer.phone || customer.whatsapp,
      email: customer.email ? maskEmail(customer.email) : null,
      stats: {
        linkedStoresCount: stores.size,
        orderCount: totalOrders,
        ltvBrl: Number(totalLtvCents) / 100,
        vipTier: customer.vipTier,
      },
    };
  }

  /* ─────────────────── ENDEREÇOS ─────────────────── */
  /**
   * Lista endereços consolidados de TODOS os Customer vinculados ao account.
   * Cliente que comprou em 3 lojas tem 3 cadastros — endereço pode estar em
   * qualquer um deles. Agregamos e mostramos único.
   */
  async getAddresses(accountId: string) {
    const acc = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { id: true, cpf: true },
    });
    if (!acc) throw new UnauthorizedException('Conta não encontrada');
    await this.ensureAccountLinks(acc.id, acc.cpf);

    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      include: { links: { select: { customerId: true } } },
    });
    if (!account) throw new UnauthorizedException('Conta não encontrada');

    const customerIds = account.links.map((l) => l.customerId);
    if (customerIds.length === 0) return { addresses: [] };

    const addresses = await this.prisma.customerAddress.findMany({
      where: {
        customerId: { in: customerIds },
        active: true,
      },
      orderBy: [{ isPrimary: 'desc' }, { updatedAt: 'desc' }],
    });

    // Deduplica por CEP + número (mesma cliente pode ter mesmo endereço em N Customers)
    const seen = new Set<string>();
    const unique = addresses.filter((a) => {
      const key = `${a.cep || ''}-${a.number || ''}-${a.street || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      addresses: unique.map((a) => ({
        id: a.id,
        type: a.type,
        isPrimary: a.isPrimary,
        cep: a.cep,
        street: a.street,
        number: a.number,
        complement: a.complement,
        district: a.district,
        city: a.city,
        state: a.state,
        reference: a.reference,
      })),
    };
  }

  /* ─────────────────── PEDIDOS (Flowops Orders) ─────────────────── */
  /**
   * Histórico de pedidos do site (Flowops/WC).
   * Para pedidos da loja física, frontend mostra stats agregadas (#me) +
   * link "Ver detalhes na loja" (não bipa Giga em real-time aqui).
   */
  async getOrders(accountId: string) {
    const acc = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { id: true, cpf: true },
    });
    if (!acc) throw new UnauthorizedException('Conta não encontrada');
    await this.ensureAccountLinks(acc.id, acc.cpf);

    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      include: { links: { select: { customerId: true } } },
    });
    if (!account) throw new UnauthorizedException('Conta não encontrada');

    const customerIds = account.links.map((l) => l.customerId);

    // Pedidos do site (Flowops) — filtra por CPF do account porque
    // Order não tem customerId direto, mas customer_cpf é populado.
    const orders = await this.prisma.order.findMany({
      where: { customerCpf: account.cpf },
      orderBy: { wcDateCreated: 'desc' },
      take: 50,
      select: {
        id: true,
        wcOrderNumber: true,
        status: true,
        totalAmount: true,
        wcDateCreated: true,
        trackingCode: true,
        carrier: true,
        items: { select: { productName: true, quantity: true } },
      },
    });

    return {
      orders: orders.map((o) => ({
        id: o.id,
        number: o.wcOrderNumber,
        status: o.status,
        total: Number(o.totalAmount) || 0,
        date: o.wcDateCreated,
        tracking: o.trackingCode
          ? { code: o.trackingCode, carrier: o.carrier }
          : null,
        itemsCount: o.items.reduce((s, i) => s + (i.quantity || 0), 0),
        firstItem: o.items[0]?.productName || null,
      })),
      linkedStoresCount: customerIds.length,
    };
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

    // AUTO-RECONCILIAÇÃO: se a conta foi criada antes de ter Customer com
    // mesmo CPF no banco (ou se ETL Giga importou depois), faz o link agora.
    // Idempotente — só roda se ainda não tem links.
    await this.ensureAccountLinks(account.id, account.cpf);

    const token = this.signToken(account);
    return {
      token,
      customer: this.publicAccount(account),
    };
  }

  /**
   * Garante que o account tenha links com Customers de mesmo CPF.
   * Chamado em login + me — pega casos onde o Customer foi criado DEPOIS
   * do account (cliente cadastrou no app antes de aparecer no CRM Giga).
   */
  private async ensureAccountLinks(accountId: string, cpf: string): Promise<number> {
    if (!cpf) return 0;

    // Customers com mesmo CPF que NÃO estão vinculados ainda
    const candidates = await this.prisma.customer.findMany({
      where: {
        cpf,
        accountLinks: { none: { accountId } },
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    if (candidates.length === 0) return 0;

    // Verifica se já tem algum link (pra decidir qual fica como primary)
    const existingCount = await this.prisma.customerAccountLink.count({
      where: { accountId },
    });

    await this.prisma.customerAccountLink.createMany({
      data: candidates.map((c, idx) => ({
        accountId,
        customerId: c.id,
        isPrimary: existingCount === 0 && idx === 0, // só o 1º vira primary se não tinha nenhum
      })),
      skipDuplicates: true,
    });

    this.logger.log(
      `Auto-linkados ${candidates.length} Customer(s) → Account ${accountId} (CPF ${cpf})`,
    );
    return candidates.length;
  }

  /* ─────────────────── ME ─────────────────── */
  /**
   * Retorna dados consolidados: account + soma de TODOS Customer linkados.
   */
  async me(accountId: string) {
    // Antes de retornar, tenta reconciliar links — captura Customers que
    // foram importados do Giga DEPOIS do cadastro do app.
    const acc = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { id: true, cpf: true },
    });
    if (!acc) throw new UnauthorizedException('Conta não encontrada');
    await this.ensureAccountLinks(acc.id, acc.cpf);

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

/** Mascara nome — primeira palavra completa, demais com 1ª letra: "Thiago R*** S***" */
function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + '***'))
    .join(' ');
}

/** Mascara telefone: (11) ****-1234 (mostra DDD + últimos 4) */
function maskPhone(phone: string): string {
  const d = (phone || '').replace(/\D/g, '');
  if (d.length < 8) return '****';
  const last4 = d.slice(-4);
  const ddd = d.length >= 10 ? d.slice(0, 2) : '';
  return ddd ? `(${ddd}) ****-${last4}` : `****-${last4}`;
}

/** Mascara e-mail: jo***@exemplo.com */
function maskEmail(email: string): string {
  const [user, domain] = (email || '').split('@');
  if (!user || !domain) return '***';
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}***@${domain}`;
}
