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
import { EmailService } from '../email/email.service';
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
    private readonly email: EmailService,
  ) {
    this.WELCOME_BONUS_CENTS =
      this.cfg.get<number>('APP_WELCOME_BONUS_CENTS') ?? 2000;
  }

  /* ─────────────────── LIST (admin retaguarda) ─────────────────── */
  /**
   * Lista accounts pra autocomplete na tela /retaguarda/app-push.
   * Busca por nome OU CPF parcial.
   */
  async searchAccounts(query: string, limit = 20) {
    const q = (query || '').trim();
    if (q.length < 2) {
      // Retorna 10 mais recentes (default)
      const list = await this.prisma.customerAccount.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          pushSubscriptions: { where: { active: true }, select: { id: true } },
        },
      });
      return list.map((a) => ({
        id: a.id,
        name: a.name,
        cpf: maskCpfPublic(a.cpf),
        phone: a.phone,
        pushActive: a.pushSubscriptions.length > 0,
      }));
    }

    // Busca por nome (case insensitive) ou CPF parcial
    const cpfDigits = q.replace(/\D/g, '');
    const list = await this.prisma.customerAccount.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          cpfDigits.length >= 3 ? { cpf: { contains: cpfDigits } } : undefined,
          { phone: { contains: cpfDigits } },
        ].filter(Boolean) as any,
      },
      take: limit,
      include: {
        pushSubscriptions: { where: { active: true }, select: { id: true } },
      },
    });

    return list.map((a) => ({
      id: a.id,
      name: a.name,
      cpf: maskCpfPublic(a.cpf),
      phone: a.phone,
      pushActive: a.pushSubscriptions.length > 0,
    }));
  }

  /* ─────────────────── STATS (admin retaguarda) ─────────────────── */
  /**
   * Métricas do app cliente — pra dashboard admin no flowops.
   * Cobre todo o funil: cadastros, PWA instalado, push ativo, cashback.
   */
  async getAdminStats() {
    const [
      totalAccounts,
      pwaInstalled,
      pushOptIn,
      activeSubscriptions,
      cashbackTotal,
      welcomeBonusGiven,
      todayLogins,
    ] = await Promise.all([
      this.prisma.customerAccount.count(),
      this.prisma.customerAccount.count({ where: { pwaInstalledAt: { not: null } } }),
      this.prisma.customerAccount.count({ where: { pushOptIn: true } }),
      this.prisma.customerAppPushSubscription.count({ where: { active: true } }),
      this.prisma.customerAccount.aggregate({
        _sum: { cashbackBalanceCents: true, cashbackEarnedCents: true },
      }),
      this.prisma.customerAccount.count({ where: { welcomeBonusAt: { not: null } } }),
      this.prisma.customerAccount.count({
        where: { lastLoginAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);

    // Top vips com mais cashback
    const topCashback = await this.prisma.customerAccount.findMany({
      orderBy: { cashbackBalanceCents: 'desc' },
      take: 10,
      select: { id: true, name: true, cpf: true, cashbackBalanceCents: true },
    });

    // Últimos cadastros
    const recentAccounts = await this.prisma.customerAccount.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, name: true, cpf: true, createdAt: true,
        pwaInstalledAt: true, pushOptIn: true,
      },
    });

    return {
      summary: {
        totalAccounts,
        pwaInstalled,
        pushOptIn,
        activeSubscriptions,
        welcomeBonusGiven,
        todayLogins,
        cashbackBalanceTotalBrl: (cashbackTotal._sum.cashbackBalanceCents || 0) / 100,
        cashbackEarnedTotalBrl: Number(cashbackTotal._sum.cashbackEarnedCents || 0n) / 100,
        // Taxa de conversão funil
        pwaInstallRate: totalAccounts > 0 ? (pwaInstalled / totalAccounts) * 100 : 0,
        pushOptInRate: totalAccounts > 0 ? (pushOptIn / totalAccounts) * 100 : 0,
      },
      topCashback: topCashback.map((c) => ({
        id: c.id,
        name: c.name,
        cpf: maskCpfPublic(c.cpf),
        balance: c.cashbackBalanceCents / 100,
      })),
      recentAccounts: recentAccounts.map((c) => ({
        id: c.id,
        name: c.name,
        cpf: maskCpfPublic(c.cpf),
        createdAt: c.createdAt,
        pwaInstalled: !!c.pwaInstalledAt,
        pushOptIn: c.pushOptIn,
      })),
    };
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

    // Não tem app account, mas pode ter Customer no CRM (formatos variados)
    const customer = await this.prisma.customer.findFirst({
      where: { cpf: { in: cpfVariants(cpf) }, name: { not: null } },
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
      where: { cpf: { in: cpfVariants(cpf) } },
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

  /* ─────────────────── ENDEREÇOS — CRUD ─────────────────── */

  /**
   * Garante que o account tem PELO MENOS UM Customer linkado pra ser dono
   * dos endereços. Se cliente nova cadastrou via app sem ter Customer no CRM,
   * cria um Customer "virtual" com originStoreCode='SITE'.
   */
  private async ensureCustomerForAccount(accountId: string): Promise<string> {
    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      include: {
        links: { orderBy: { isPrimary: 'desc' }, take: 1 },
      },
    });
    if (!account) throw new BadRequestException('Conta não encontrada');

    if (account.links.length > 0) return account.links[0].customerId;

    // Cria Customer novo pro app — origin = Store com code='SITE' (se existir).
    // Se nao existir, fica null (não bloqueia o cadastro do endereço).
    const cpfRaw = account.cpf.replace(/\D/g, '');
    const siteStore = await this.prisma.store.findUnique({
      where: { code: 'SITE' },
      select: { id: true },
    });
    const newCustomer = await this.prisma.customer.create({
      data: {
        cpf: cpfRaw,
        name: account.name,
        phone: account.phone,
        email: account.email,
        originStoreId: siteStore?.id || null,
      },
    });
    await this.prisma.customerAccountLink.create({
      data: {
        accountId: account.id,
        customerId: newCustomer.id,
        isPrimary: true,
      },
    });
    return newCustomer.id;
  }

  /**
   * Cria endereço novo. Se isPrimary=true, despinata os outros automaticamente.
   */
  async createAddress(accountId: string, dto: {
    type?: string;
    cep?: string;
    street?: string;
    number?: string;
    complement?: string;
    district?: string;
    city?: string;
    state?: string;
    reference?: string;
    isPrimary?: boolean;
  }) {
    const customerId = await this.ensureCustomerForAccount(accountId);
    return this.prisma.$transaction(async (tx) => {
      // Se vai ser principal, desmarca os outros
      if (dto.isPrimary) {
        await tx.customerAddress.updateMany({
          where: { customerId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      const created = await tx.customerAddress.create({
        data: {
          customerId,
          type: dto.type || 'residential',
          cep: dto.cep || null,
          street: dto.street || null,
          number: dto.number || null,
          complement: dto.complement || null,
          district: dto.district || null,
          city: dto.city || null,
          state: dto.state ? dto.state.toUpperCase().slice(0, 2) : null,
          reference: dto.reference || null,
          isPrimary: !!dto.isPrimary,
          active: true,
        },
      });
      return { id: created.id };
    });
  }

  /**
   * Edita endereço existente. Só permite se o endereço pertence a um Customer
   * linkado a esse account (segurança).
   */
  async updateAddress(accountId: string, addressId: string, dto: {
    type?: string;
    cep?: string;
    street?: string;
    number?: string;
    complement?: string;
    district?: string;
    city?: string;
    state?: string;
    reference?: string;
    isPrimary?: boolean;
  }) {
    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      include: { links: { select: { customerId: true } } },
    });
    if (!account) throw new UnauthorizedException('Conta não encontrada');

    const addr = await this.prisma.customerAddress.findUnique({
      where: { id: addressId },
      select: { id: true, customerId: true },
    });
    if (!addr) throw new BadRequestException('Endereço não encontrado');

    const customerIds = account.links.map((l) => l.customerId);
    if (!customerIds.includes(addr.customerId)) {
      throw new UnauthorizedException('Endereço não pertence a você');
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.customerAddress.updateMany({
          where: { customerId: addr.customerId, isPrimary: true, id: { not: addressId } },
          data: { isPrimary: false },
        });
      }
      const data: any = {};
      if (dto.type !== undefined) data.type = dto.type;
      if (dto.cep !== undefined) data.cep = dto.cep;
      if (dto.street !== undefined) data.street = dto.street;
      if (dto.number !== undefined) data.number = dto.number;
      if (dto.complement !== undefined) data.complement = dto.complement;
      if (dto.district !== undefined) data.district = dto.district;
      if (dto.city !== undefined) data.city = dto.city;
      if (dto.state !== undefined) {
        data.state = dto.state ? dto.state.toUpperCase().slice(0, 2) : null;
      }
      if (dto.reference !== undefined) data.reference = dto.reference;
      if (dto.isPrimary !== undefined) data.isPrimary = dto.isPrimary;

      await tx.customerAddress.update({
        where: { id: addressId },
        data,
      });
      return { id: addressId };
    });
  }

  /** Desativa endereço (soft delete). Não apaga porque pode estar em Order. */
  async deleteAddress(accountId: string, addressId: string) {
    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      include: { links: { select: { customerId: true } } },
    });
    if (!account) throw new UnauthorizedException('Conta não encontrada');

    const addr = await this.prisma.customerAddress.findUnique({
      where: { id: addressId },
      select: { customerId: true },
    });
    if (!addr) throw new BadRequestException('Endereço não encontrado');

    const customerIds = account.links.map((l) => l.customerId);
    if (!customerIds.includes(addr.customerId)) {
      throw new UnauthorizedException('Endereço não pertence a você');
    }

    await this.prisma.customerAddress.update({
      where: { id: addressId },
      data: { active: false },
    });
    return { ok: true };
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

    // 3) Acha TODOS Customers com mesmo CPF (CRM tem com pontos OU só dígitos)
    const customers = await this.prisma.customer.findMany({
      where: { cpf: { in: cpfVariants(dto.cpf) } },
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
    // Parse birthDate (opcional) — aceita YYYY-MM-DD (input type=date)
    // Fallback: se cliente já tem Customer no CRM com birthDate, usa essa.
    let birthDate: Date | null = null;
    if (dto.birthDate) {
      const parsed = new Date(dto.birthDate);
      if (!isNaN(parsed.getTime())) birthDate = parsed;
    } else if (customers[0]) {
      // Puxa do Customer mais antigo se existe
      const c = await this.prisma.customer.findUnique({
        where: { id: customers[0].id },
        select: { birthDate: true },
      });
      if (c?.birthDate) birthDate = c.birthDate;
    }

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
            birthDate,
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

      // 🎁 Credita bônus de boas-vindas R$ 20 NA HORA (sem esperar PWA/compra)
      await this.creditWelcomeBonus(account.id).catch((err) =>
        this.logger.warn(`Welcome bonus falhou: ${err?.message || err}`),
      );

      // ✉️ Dispara email LGPD de boas-vindas (best-effort — não bloqueia)
      if (safeEmail) {
        this.email
          .sendWelcome({
            to: safeEmail,
            name: sourceName,
            cpfMasked: maskCpfPublic(dto.cpf),
          })
          .catch((err) => {
            this.logger.warn(`Email boas-vindas falhou: ${err?.message || err}`);
          });
      }

      const token = this.signToken(account);
      // Re-lê balance atualizado pós-bônus pra retornar pro frontend
      const updated = await this.prisma.customerAccount.findUnique({
        where: { id: account.id },
        select: { cashbackBalanceCents: true },
      });
      return {
        token,
        customer: {
          ...this.publicAccount(account),
          cashbackBalance: (updated?.cashbackBalanceCents || 0) / 100,
        },
        bonusPending: 0,  // já entrou
        bonusReceived: this.WELCOME_BONUS_CENTS / 100,
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

    // CRM tem CPF armazenado COM PONTOS (99% dos casos) e/ou só dígitos.
    // Geramos todas as variantes pra achar todos os matches.
    const variants = cpfVariants(cpf);

    const candidates = await this.prisma.customer.findMany({
      where: {
        cpf: { in: variants },
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

  /* ─────────────────── UPDATE PROFILE ─────────────────── */
  /**
   * Atualiza dados editáveis do CustomerAccount.
   * Cliente pode mudar: nome, whatsapp, email, data nascimento.
   * CPF NÃO é editável (é o identificador único).
   */
  async updateProfile(accountId: string, input: {
    name?: string;
    phone?: string;
    email?: string;
    birthDate?: string | null;
  }) {
    const data: any = {};

    if (input.name !== undefined) {
      const name = String(input.name || '').trim();
      if (name.length < 2) {
        throw new BadRequestException('Nome precisa ter pelo menos 2 caracteres');
      }
      if (name.length > 80) {
        throw new BadRequestException('Nome muito longo (máx 80)');
      }
      data.name = name;
    }

    if (input.phone !== undefined) {
      const phone = String(input.phone || '').replace(/\D/g, '');
      if (phone && (phone.length < 10 || phone.length > 11)) {
        throw new BadRequestException('WhatsApp inválido (use DDD + número)');
      }
      data.phone = phone || null;
    }

    if (input.email !== undefined) {
      const email = String(input.email || '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new BadRequestException('E-mail inválido');
      }
      data.email = email || null;
    }

    if (input.birthDate !== undefined) {
      if (input.birthDate === null || input.birthDate === '') {
        data.birthDate = null;
      } else {
        const d = new Date(input.birthDate);
        if (isNaN(d.getTime())) {
          throw new BadRequestException('Data de nascimento inválida');
        }
        const now = new Date();
        const age = (now.getTime() - d.getTime()) / (365.25 * 86400 * 1000);
        if (age < 13) {
          throw new BadRequestException('É necessário ter pelo menos 13 anos');
        }
        if (age > 120) {
          throw new BadRequestException('Data de nascimento inválida');
        }
        data.birthDate = d;
      }
    }

    if (Object.keys(data).length === 0) {
      return this.me(accountId);
    }

    try {
      await this.prisma.customerAccount.update({
        where: { id: accountId },
        data,
      });
    } catch (e: any) {
      // P2002 = unique constraint (email duplicado)
      if (e?.code === 'P2002') {
        throw new BadRequestException('Este e-mail já está em uso por outra conta');
      }
      throw e;
    }

    this.logger.log(`[customer-app] perfil atualizado: ${accountId.slice(0, 8)} (${Object.keys(data).join(',')})`);
    return this.me(accountId);
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
      pushOptIn: account.pushOptIn,
      whatsappOptIn: account.whatsappOptIn,
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

  /**
   * Toggle do fallback WhatsApp.
   * Cliente iPhone antigo que não consegue push pode receber por WhatsApp.
   */
  async setWhatsappOptIn(accountId: string, optIn: boolean) {
    await this.prisma.customerAccount.update({
      where: { id: accountId },
      data: { whatsappOptIn: optIn },
    });
    return { whatsappOptIn: optIn };
  }

  /* ─────────────────── BACKFILL (admin) ─────────────────── */

  /**
   * Aplica o bônus de boas-vindas RETROATIVAMENTE pra todas accounts criadas
   * que nunca receberam (welcomeBonusAt = null).
   * Chamado pelo /retaguarda manualmente — não roda automático.
   */
  async backfillWelcomeBonus(): Promise<{ credited: number; skipped: number }> {
    const accounts = await this.prisma.customerAccount.findMany({
      where: { welcomeBonusAt: null },
      select: { id: true },
    });
    let credited = 0;
    let skipped = 0;
    for (const a of accounts) {
      try {
        await this.creditWelcomeBonus(a.id);
        credited++;
      } catch {
        skipped++;
      }
    }
    this.logger.log(`Backfill welcome bonus: ${credited} creditadas, ${skipped} skip`);
    return { credited, skipped };
  }

  /* ─────────────────── WELCOME BONUS ─────────────────── */

  /**
   * Credita R$ 20 (configurável via APP_WELCOME_BONUS_CENTS) no cashback
   * da conta NA HORA do cadastro. Idempotente (welcomeBonusAt).
   * Não usa CustomerCashbackService pra evitar circular dep entre módulos.
   */
  private async creditWelcomeBonus(accountId: string): Promise<void> {
    const account = await this.prisma.customerAccount.findUnique({
      where: { id: accountId },
      select: { welcomeBonusAt: true, cashbackBalanceCents: true },
    });
    if (!account || account.welcomeBonusAt) return;

    const TTL_DAYS = Number(this.cfg.get('CASHBACK_TTL_DAYS') ?? 30);
    const amountCents = this.WELCOME_BONUS_CENTS;
    const expiresAt = new Date(Date.now() + TTL_DAYS * 86400 * 1000);
    const newBalance = account.cashbackBalanceCents + amountCents;

    await this.prisma.$transaction(async (tx) => {
      await tx.customerCashbackTx.create({
        data: {
          accountId,
          type: 'welcome',
          amountCents,
          balanceAfterCents: newBalance,
          description: '🎁 Bônus de boas-vindas R$ 20',
          expiresAt,
        },
      });
      await tx.customerAccount.update({
        where: { id: accountId },
        data: {
          cashbackBalanceCents: newBalance,
          cashbackEarnedCents: { increment: BigInt(amountCents) },
          welcomeBonusAt: new Date(),
        },
      });
    });

    this.logger.log(
      `🎁 Welcome bonus R$ ${(amountCents / 100).toFixed(2)} creditado: account=${accountId}`,
    );
  }

  /* ─────────────────── NOTIFICAÇÕES ─────────────────── */

  /**
   * Retorna últimas 50 notificações da cliente + contagem de não lidas.
   * Usado pela tela /notificacoes do app.
   */
  async getNotifications(accountId: string) {
    const [items, unreadCount] = await Promise.all([
      this.prisma.customerAppNotification.findMany({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true, title: true, body: true, url: true, image: true,
          category: true, readAt: true, createdAt: true,
        },
      }),
      this.prisma.customerAppNotification.count({
        where: { accountId, readAt: null },
      }),
    ]);
    return {
      notifications: items.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        url: n.url,
        image: n.image,
        category: n.category || 'promo',
        read: n.readAt !== null,
        createdAt: n.createdAt,
      })),
      unreadCount,
    };
  }

  /** Hit barato no DB pra mostrar bolinha no sino da home. */
  async getUnreadNotificationsCount(accountId: string) {
    const count = await this.prisma.customerAppNotification.count({
      where: { accountId, readAt: null },
    });
    return { count };
  }

  /** Marca todas as notificações da cliente como lidas. */
  async markAllNotificationsRead(accountId: string) {
    const r = await this.prisma.customerAppNotification.updateMany({
      where: { accountId, readAt: null },
      data: { readAt: new Date() },
    });
    return { marked: r.count };
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
    birthDate?: Date | null;
  }) {
    return {
      id: a.id,
      name: a.name,
      cpf: maskCpfPublic(a.cpf),
      phone: a.phone,
      email: a.email,
      birthDate: a.birthDate ? a.birthDate.toISOString().slice(0, 10) : null,
    };
  }
}

/**
 * Gera todas as variantes possíveis de um CPF pra match no banco.
 *
 * CRM Lurd's armazena 99% dos CPFs no formato 000.000.000-00 (com pontos),
 * mas o app sempre manda só dígitos. Pra achar Customer existente,
 * precisamos buscar pelas duas formas.
 *
 * Aceita input em qualquer formato e gera: [só dígitos, com pontuação].
 */
function cpfVariants(cpf: string): string[] {
  const digits = (cpf || '').replace(/\D/g, '');
  if (digits.length !== 11) return [cpf]; // dado inválido — devolve como veio
  const formatted = `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
  return [digits, formatted];
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
