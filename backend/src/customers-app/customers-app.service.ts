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
import {
  AppLoginDto,
  AppRegisterDto,
} from './dto/app-auth.dto';

/**
 * Service do app cliente final (PWA app.lurds.com.br).
 *
 * Responsabilidades:
 *  - Cadastro com hash de senha (bcrypt)
 *  - Login com verificação de senha
 *  - Emissão de JWT scope='customer'
 *  - Marcação de instalação PWA + crédito de bônus R$ 20 (1 vez por customer)
 *
 * Integração com Customer existente: se já tem cadastro (do Giga ETL),
 * "ativa" o app no cadastro existente. Senão cria customer novo.
 */
@Injectable()
export class CustomersAppService {
  private readonly logger = new Logger(CustomersAppService.name);

  // Bônus de boas-vindas — em centavos. Configurável via env.
  // IMPORTANTE: inicializado no constructor porque `this.cfg` não existe
  // durante a avaliação de field initializers (TS strict mode).
  private readonly WELCOME_BONUS_CENTS: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cfg: ConfigService,
  ) {
    this.WELCOME_BONUS_CENTS = this.cfg.get<number>('APP_WELCOME_BONUS_CENTS') ?? 2000;
  }

  /* ─────────────────── REGISTER ─────────────────── */

  async register(dto: AppRegisterDto) {
    // Customer já existe (do Giga ETL)? Se tiver appPasswordHash, conflito.
    const existing = await this.prisma.customer.findFirst({
      where: { cpf: dto.cpf },
      orderBy: { createdAt: 'asc' },
    });

    if (existing?.appPasswordHash) {
      throw new ConflictException(
        'CPF já cadastrado no app. Faça login ou recupere sua senha.',
      );
    }

    const hash = await bcrypt.hash(dto.password, 10);

    // Email é OPCIONAL no app — mas tem @unique no schema. Se o email
    // do form já pertence a OUTRO Customer (vindo do CRM/Giga), prefere
    // NÃO setar nesse cadastro pra evitar P2002. Cliente pode confirmar
    // o email depois em /conta/dados.
    let safeEmail: string | undefined = dto.email || undefined;
    if (safeEmail) {
      const otherWithEmail = await this.prisma.customer.findFirst({
        where: {
          email: safeEmail,
          NOT: existing?.id ? { id: existing.id } : undefined,
        },
        select: { id: true },
      });
      if (otherWithEmail) {
        // Não bloqueia o cadastro — só ignora o email pra não violar UNIQUE.
        // (Cliente pode atualizar depois no perfil)
        this.logger.warn(
          `Email ${safeEmail} já está em outro Customer (${otherWithEmail.id}); criando sem email.`,
        );
        safeEmail = undefined;
      }
    }

    let customer;
    try {
      customer = existing
        ? await this.prisma.customer.update({
            where: { id: existing.id },
            data: {
              appPasswordHash: hash,
              // Preenche dados básicos se Giga não tinha
              name: existing.name || dto.name,
              phone: existing.phone || dto.phone,
              whatsapp: existing.whatsapp || dto.phone,
              email: existing.email || safeEmail,
              appLastLoginAt: new Date(),
            },
          })
        : await this.prisma.customer.create({
            data: {
              cpf: dto.cpf,
              name: dto.name,
              phone: dto.phone,
              whatsapp: dto.phone,
              email: safeEmail,
              appPasswordHash: hash,
              appLastLoginAt: new Date(),
              // Origem = SITE (cadastrou direto pelo app, não veio de loja física)
            },
          });
    } catch (err: any) {
      // P2002 = Prisma unique constraint violation
      // Pode acontecer mesmo com a checagem acima (race condition).
      if (err?.code === 'P2002') {
        const fields = (err.meta?.target as string[] | undefined)?.join(', ') || 'campo único';
        throw new ConflictException(
          `Cadastro duplicado em: ${fields}. Tente fazer login ou use outro e-mail.`,
        );
      }
      this.logger.error(`register falhou: ${err?.message || err}`);
      throw err;
    }

    const token = this.signToken(customer);
    return {
      token,
      customer: this.publicCustomer(customer),
      bonusPending: this.WELCOME_BONUS_CENTS / 100, // R$ 20 — ainda não creditado
    };
  }

  /* ─────────────────── LOGIN ─────────────────── */

  async login(dto: AppLoginDto) {
    const customer = await this.prisma.customer.findFirst({
      where: { cpf: dto.cpf, appPasswordHash: { not: null } },
    });

    if (!customer || !customer.appPasswordHash) {
      throw new UnauthorizedException('CPF não cadastrado no app');
    }

    const ok = await bcrypt.compare(dto.password, customer.appPasswordHash);
    if (!ok) {
      throw new UnauthorizedException('Senha incorreta');
    }

    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { appLastLoginAt: new Date() },
    });

    const token = this.signToken(customer);
    return {
      token,
      customer: this.publicCustomer(customer),
    };
  }

  /* ─────────────────── ME ─────────────────── */

  async me(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { cashbackBalance: true },
    });
    if (!customer) throw new UnauthorizedException('Conta não encontrada');

    return {
      ...this.publicCustomer(customer),
      cashback: {
        balance: (customer.cashbackBalance?.balanceCents ?? 0) / 100,
        accumulated: Number(customer.cashbackBalance?.accumulatedTotalCents ?? 0n) / 100,
      },
      pwaInstalled: !!customer.pwaInstalledAt,
      welcomeBonusReceived: !!customer.welcomeBonusAt,
    };
  }

  /* ─────────────────── PWA INSTALLED ─────────────────── */
  /**
   * Marca que cliente instalou o PWA (Android beforeinstallprompt accepted
   * ou iOS Add to Home Screen detectado via display-mode: standalone).
   *
   * Pode ser chamado várias vezes — só marca a primeira.
   * Se ainda não recebeu welcome bonus, NÃO credita aqui — bônus só
   * cai DEPOIS da 1ª compra confirmada (regra do CEO Thiago).
   */
  async markPwaInstalled(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { pwaInstalledAt: true },
    });
    if (!customer) throw new UnauthorizedException('Conta não encontrada');

    if (customer.pwaInstalledAt) {
      return { alreadyMarked: true, pwaInstalledAt: customer.pwaInstalledAt };
    }

    const now = new Date();
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { pwaInstalledAt: now },
    });

    this.logger.log(`Cliente ${customerId} instalou o PWA`);
    return { alreadyMarked: false, pwaInstalledAt: now };
  }

  /* ─────────────────── PUSH OPT-IN ─────────────────── */

  async setPushOptIn(customerId: string, optIn: boolean) {
    await this.prisma.customer.update({
      where: { id: customerId },
      data: { appPushOptIn: optIn },
    });
    return { optIn };
  }

  /* ─────────────────── HELPERS ─────────────────── */

  private signToken(customer: { id: string; cpf: string | null; name: string | null }) {
    return this.jwt.sign(
      {
        sub: customer.id,
        cpf: customer.cpf,
        name: customer.name,
        scope: 'customer',
      },
      { expiresIn: '30d' }, // App cliente: TTL longo (mês), reduz fricção
    );
  }

  private publicCustomer(c: {
    id: string;
    name: string | null;
    cpf: string | null;
    phone: string | null;
    email: string | null;
  }) {
    return {
      id: c.id,
      name: c.name,
      cpf: c.cpf ? maskCpfPublic(c.cpf) : null,
      phone: c.phone,
      email: c.email,
    };
  }
}

/** Mascarar CPF na resposta pública: 123.***.***-45 */
function maskCpfPublic(cpf: string): string {
  if (!cpf || cpf.length !== 11) return cpf;
  return `${cpf.slice(0, 3)}.***.***-${cpf.slice(9, 11)}`;
}
