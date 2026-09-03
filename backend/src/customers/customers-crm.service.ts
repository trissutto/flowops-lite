import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { comPedidoPago } from '../common/pedido-pago';

/**
 * CustomersCrmService — operações DIRETAS sobre a tabela `customers`.
 *
 * Diferença pro CustomersService antigo: aqui é o CRM real (mestre de clientes),
 * com cadastro manual, perfil Plus Size, endereços, consentimentos LGPD,
 * tags e cashback. O service antigo deriva clientes dos pedidos WC e
 * continua funcionando até o ETL completo popular esta tabela.
 *
 * Endpoints expostos em /customers-crm (ver customers-crm.controller).
 */

// === Tiers e parâmetros de cashback ===
// Hardcoded por enquanto. Quando o módulo de config-cashback nascer,
// puxa de uma tabela CashbackTier+CashbackParam.
const TIER_CONFIG: Record<string, { minSpentCents: number; percent: number; validityDays: number }> = {
  bronze:   { minSpentCents:        0, percent: 3,  validityDays:  60 },
  prata:    { minSpentCents:   150000, percent: 5,  validityDays:  90 },
  ouro:     { minSpentCents:   400000, percent: 7,  validityDays: 120 },
  diamante: { minSpentCents:  1000000, percent: 10, validityDays: 180 },
};
const REDEEM_MIN_CENTS = 2000;        // R$ 20
const MAX_REDEEM_PCT   = 0.30;        // 30% da compra
const CREDIT_GRACE_DAYS = 7;          // carência (devolução)

export interface CreateCustomerDto {
  cpf?: string;
  registroGiga?: number;
  name: string;
  nameSocial?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  birthDate?: string;                 // ISO date
  gender?: string;
  maritalStatus?: string;
  sizeDefault?: string;
  sizeSecondary?: string;
  bodyType?: string;
  preferredStyle?: string;
  favoriteColors?: string;
  avoidedPieces?: string;
  originSource?: string;              // physical | woo | instagram | manual | giga
  originStoreId?: string;
  originSeller?: string;
  referredByCpf?: string;             // se veio por indicação, busca pelo CPF
  notes?: string;
}

export interface UpdateCustomerDto extends Partial<CreateCustomerDto> {
  vipTier?: string;
  active?: boolean;
  inactiveReason?: string;
}

export interface UpdateCustomerCreditDto {
  limiteCrediario?: number | null; // reais
  bloqueado?: boolean;
  negativado?: boolean;
  spcSituacao?: string | null;
  spcData?: string | null;
  trabalhoRazaoSocial?: string | null;
  trabalhoCargo?: string | null;
  trabalhoSalario?: number | null; // reais
  trabalhoAdmissao?: string | null;
  trabalhoFone?: string | null;
  casaPropria?: boolean | null;
  aluguel?: number | null; // reais
}

export interface ListQuery {
  search?: string;
  tier?: string;
  rfvSegment?: string;
  storeId?: string;
  hasWhatsapp?: boolean;
  hasCashbackBalance?: boolean;
  page?: number;
  limit?: number;
  orderBy?: 'name' | 'lastOrderAt' | 'ltvCents' | 'createdAt';
  order?: 'asc' | 'desc';
}

const CUSTOMER_SOURCE_WEIGHT: Record<string, number> = {
  manual: 60, flowops: 60, pdv: 50, physical: 50,
  site: 40, ecommerce: 40, woo: 40,
  live: 30, instagram: 30, giga: 10,
};

function customerIdentityKey(customer: any): string {
  return customer.personId ? `person:${customer.personId}`
    : customer.personKey ? `key:${customer.personKey}`
      : `customer:${customer.id}`;
}

function orderCanonicalRecords(records: any[]): any[] {
  return [...records].sort((a, b) => {
    const weight = (CUSTOMER_SOURCE_WEIGHT[b.originSource || ''] || 0)
      - (CUSTOMER_SOURCE_WEIGHT[a.originSource || ''] || 0);
    return weight || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

/**
 * Nome canônico deve representar o cadastro comercial real. Um nome digitado
 * depois no site não pode substituir o nome do registro que concentra compras.
 */
function chooseCanonicalNameRecord(records: any[]): any {
  return [...records].filter((r) => r.nameSocial || r.name).sort((a, b) => {
    const orders = Number(b.orderCount || 0) - Number(a.orderCount || 0);
    if (orders) return orders;
    const ltv = Number(b.ltvCents || 0) - Number(a.ltvCents || 0);
    if (ltv) return ltv;
    const aName = String(a.nameSocial || a.name || '').trim();
    const bName = String(b.nameSocial || b.name || '').trim();
    return bName.length - aName.length;
  })[0] || records[0];
}

/**
 * Actor = quem está fazendo a request (vem do req.user).
 * Usado pra aplicar SCOPE POR LOJA automaticamente:
 *   • admin/operator (matriz) → vê todos os clientes
 *   • store              → vê só clientes com originStoreId = sua loja
 */
export interface RequestActor {
  userId: string;
  role: string;                // 'admin' | 'operator' | 'store'
  storeId?: string | null;
}

const MATRIX_ROLES = new Set(['admin', 'operator']);

function isMatrix(actor?: RequestActor): boolean {
  return !!actor && MATRIX_ROLES.has(actor.role);
}

export interface CreateAddressDto {
  type: 'residential' | 'delivery' | 'mailing' | 'work';
  isPrimary?: boolean;
  cep?: string;
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  reference?: string;
}

export interface ConsentDto {
  channel: 'whatsapp' | 'email' | 'sms' | 'mail' | 'general';
  granted: boolean;
  termVersion?: string;
  source?: string;
  registeredByUserId?: string;
}

export interface CreditCashbackDto {
  valueCents: number;                 // valor do cashback (já calculado)
  purchaseValueCents?: number;
  percentApplied?: number;
  orderId?: string;
  storeId?: string;
  description?: string;
  userId?: string;
}

export interface RedeemCashbackDto {
  valueCents: number;
  purchaseValueCents: number;         // pra validar 30% máx
  orderId?: string;
  storeId?: string;
  userId?: string;
}

@Injectable()
export class CustomersCrmService {
  private readonly logger = new Logger(CustomersCrmService.name);

  // ErpService saiu daqui no enterro do Wincred (09/2026): o último uso era o
  // runReadOnly da caixa do Giga pros marcados, hoje lido da tabela nativa.
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS — normalização
  // ─────────────────────────────────────────────────────────────────────────
  private normalizeCpf(cpf?: string | null): string | null {
    if (!cpf) return null;
    const digits = cpf.replace(/\D/g, '');
    if (digits.length !== 11) return null;
    return `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9,11)}`;
  }

  private normalizePhone(phone?: string | null): string | null {
    if (!phone) return null;
    let digits = phone.replace(/\D/g, '');
    if (digits.length > 11 && digits.startsWith('55')) digits = digits.slice(2);
    if (digits.length !== 10 && digits.length !== 11) return null;
    return `+55${digits}`;
  }

  private normalizeCep(cep?: string | null): string | null {
    if (!cep) return null;
    const d = cep.replace(/\D/g, '');
    if (d.length !== 8) return null;
    return `${d.slice(0,5)}-${d.slice(5,8)}`;
  }

  private percentForTier(tier: string): number {
    return TIER_CONFIG[tier]?.percent ?? TIER_CONFIG.bronze.percent;
  }

  private validityDaysForTier(tier: string): number {
    return TIER_CONFIG[tier]?.validityDays ?? TIER_CONFIG.bronze.validityDays;
  }

  /**
   * Carrega cliente VALIDANDO escopo de loja do actor.
   * Vendedora de outra loja recebe 404 (mesma resposta de "não existe", evita enumeration).
   */
  /**
   * ERRO DE ESCRITA COM NOME E SOBRENOME.
   *
   * Toda gravação de cliente estava virando "500 Internal server error" — a
   * tela dizia que falhou e ninguém sabia POR QUE: constraint? trigger?
   * coluna? Cada palpite custava um deploy. Agora o código do Prisma (P2002,
   * P2022, P2003...) e a mensagem do banco vão pro log e pra tela.
   *
   * Os códigos conhecidos viram frase de gente; o resto vai cru mesmo — cru e
   * visível é melhor que bonito e mudo.
   */
  private erroDeEscrita(e: any, oQue: string): never {
    const codigo = e?.code ? String(e.code) : null;
    const alvo = e?.meta?.target ? ` (${JSON.stringify(e.meta.target)})` : '';
    this.logger.error(
      `[CRM] ${oQue} falhou ${codigo ?? 'sem código'}: ${e?.message || e}`,
    );
    if (codigo === 'P2002') {
      throw new BadRequestException(`Já existe outro cliente com esse dado${alvo}. Ajuste e tente de novo.`);
    }
    if (codigo === 'P2025') throw new NotFoundException('Cliente não encontrado');
    if (codigo === 'P2003') {
      throw new BadRequestException(`Vínculo inválido${alvo} — o registro apontado não existe.`);
    }
    const detalhe = String(e?.message || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-2)
      .join(' ')
      .slice(0, 300);
    throw new BadRequestException(`Não consegui ${oQue} (${codigo ?? 'erro do banco'}): ${detalhe}`);
  }

  private async loadScoped(customerId: string, actor?: RequestActor) {
    const c = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!c) throw new NotFoundException('Cliente não encontrado');
    if (actor && !isMatrix(actor)) {
      // MESMO escopo da list(): cliente nascido na loja (originStoreId) OU
      // cliente WC atribuído à loja por CEP (targetStoreId, badge "SITE").
      // Antes só aceitava originStoreId → cliente aparecia na LISTA mas a
      // FICHA devolvia 404 e o drawer travava em "Carregando...".
      const ok =
        !!actor.storeId &&
        (c.originStoreId === actor.storeId || (c as any).targetStoreId === actor.storeId);
      if (!ok) {
        throw new NotFoundException('Cliente não encontrado');
      }
    }
    return c;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CRIAÇÃO / EDIÇÃO
  // ─────────────────────────────────────────────────────────────────────────
  async create(dto: CreateCustomerDto, actor?: RequestActor) {
    if (!dto?.name?.trim()) {
      throw new BadRequestException('Nome é obrigatório');
    }

    const cpf = this.normalizeCpf(dto.cpf);
    const whatsapp = this.normalizePhone(dto.whatsapp);
    const phone    = this.normalizePhone(dto.phone);

    // DETECÇÃO PRÉ-CADASTRO DE DUPLICIDADE — se CPF informado e já existir,
    // retorna 409 com mensagem amigável + id do cliente existente pro frontend
    // poder oferecer "abrir cliente existente".
    //
    // REGRA NOVA (01/08/2026 — decisão do dono): O CPF É A PESSOA.
    //
    // A regra anterior (jun/2026) permitia cadastro da mesma pessoa em N lojas
    // e só bloqueava duplicata dentro da própria loja. Isso é o oposto do
    // cadastro único: a cliente de Itanhaém que compra em Sorocaba virava duas
    // pessoas, e LTV e cashback ficavam partidos ao meio — justamente o que o
    // cadastro único existe pra resolver.
    //
    // Agora a busca é na REDE INTEIRA. Não funde nada do que já existe: só
    // impede que NASÇA duplicata nova. A resposta diz em qual loja ela já está,
    // pra atendente abrir o cadastro existente em vez de criar outro.
    if (cpf) {
      const cpfDigits = cpf.replace(/\D/g, '');
      const existing = await this.prisma.customer.findFirst({
        where: { OR: [{ cpf }, { cpf: cpfDigits }] },
        select: { id: true, name: true, cpf: true, originStore: { select: { name: true } } },
      });
      if (existing) {
        const onde = existing.originStore?.name ? ` (cadastrada em ${existing.originStore.name})` : '';
        throw new ConflictException({
          message:
            `Esta cliente já existe${onde}: ${existing.name}. ` +
            `Use o cadastro dela — ela pode comprar em qualquer loja.`,
          customerId: existing.id,
          customerName: existing.name,
          lojaOrigem: existing.originStore?.name || null,
        });
      }
    }

    // SCOPE POR LOJA — se quem cria é vendedora/loja, força originStoreId = sua loja.
    // Matriz pode escolher.
    let originStoreId = dto.originStoreId;
    if (actor && !isMatrix(actor)) {
      if (!actor.storeId) {
        throw new BadRequestException('Usuário sem loja vinculada não pode cadastrar cliente');
      }
      originStoreId = actor.storeId;
    }

    // Resolve referredBy via CPF se veio
    let referredById: string | undefined;
    if (dto.referredByCpf) {
      // findFirst (não Unique) pq CPF não é mais @unique (jun/2026):
      // mesmo CPF pode ter cadastro em N lojas Giga
      const ref = await this.prisma.customer.findFirst({ where: { cpf: this.normalizeCpf(dto.referredByCpf) ?? '' } });
      if (ref) referredById = ref.id;
    }

    // Frontend manda originSource='physical' mas valores aceitos são:
    // 'manual', 'pdv', 'giga', 'woo', 'instagram'. Mapeia pra 'pdv' como default
    // quando vem do PDV/loja, 'manual' caso contrário.
    const sourceMap: Record<string, string> = {
      physical: 'pdv',
      pdv: 'pdv',
      manual: 'manual',
      giga: 'giga',
      woo: 'woo',
      instagram: 'instagram',
    };
    const originSourceNormalized = sourceMap[dto.originSource ?? 'manual'] ?? 'manual';

    try {
      const created = await this.prisma.customer.create({
        data: {
          cpf: cpf ?? undefined,
          registroGiga: dto.registroGiga,
          name: dto.name.trim(),
          nameSocial: dto.nameSocial?.trim(),
          email: dto.email?.toLowerCase().trim() || undefined,
          phone: phone ?? undefined,
          whatsapp: whatsapp ?? undefined,
          birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
          gender: dto.gender,
          maritalStatus: dto.maritalStatus,
          sizeDefault: dto.sizeDefault,
          sizeSecondary: dto.sizeSecondary,
          bodyType: dto.bodyType,
          preferredStyle: dto.preferredStyle,
          favoriteColors: dto.favoriteColors,
          avoidedPieces: dto.avoidedPieces,
          originSource: originSourceNormalized,
          originStoreId,
          originSeller: dto.originSeller,
          referredById,
          notes: dto.notes,
          // saldo inicial é criado vazio (1:1)
          cashbackBalance: { create: {} },
        },
        include: { cashbackBalance: true },
      });

      this.logger.log(`[CRM] cliente criado: ${created.id} (${created.name}) por ${actor?.userId ?? 'sistema'} | loja=${originStoreId ?? 'sem'}`);
      return created;
    } catch (e: any) {
      // P2002 = Prisma unique constraint violation
      if (e?.code === 'P2002') {
        const fields = (e?.meta?.target || []).join(', ');
        this.logger.warn(`[CRM] duplicidade ao criar cliente: campos=${fields}`);
        throw new ConflictException(
          `Já existe um cliente com esses dados (campo${fields ? ` ${fields}` : ''} duplicado).`,
        );
      }
      // P2003 = foreign key violation
      if (e?.code === 'P2003') {
        this.logger.warn(`[CRM] FK violation: ${e?.message}`);
        throw new BadRequestException('Referência inválida (loja ou cliente indicador não existe).');
      }
      // Loga full antes de re-throw pra debug em Railway logs
      this.logger.error(`[CRM] create falhou: ${e?.code || ''} ${e?.message}`, e?.stack);
      throw e;
    }
  }

  async update(id: string, dto: UpdateCustomerDto, actor?: RequestActor) {
    await this.loadScoped(id, actor);

    const cpf = dto.cpf !== undefined ? this.normalizeCpf(dto.cpf) : undefined;
    const whatsapp = dto.whatsapp !== undefined ? this.normalizePhone(dto.whatsapp) : undefined;
    const phone    = dto.phone !== undefined    ? this.normalizePhone(dto.phone) : undefined;

    // O try/catch é o que faltava pro `erroDeEscrita` nascido em deb82e2 valer
    // de alguma coisa: o helper existia mas ninguém chamava, e o erro real
    // continuava saindo como 500 mudo.
    try {
      return await this.prisma.customer.update({
      where: { id },
      data: {
        ...(cpf !== undefined ? { cpf: cpf ?? null } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.nameSocial !== undefined ? { nameSocial: dto.nameSocial } : {}),
        ...(dto.email !== undefined ? { email: dto.email?.toLowerCase().trim() ?? null } : {}),
        ...(phone !== undefined ? { phone: phone ?? null } : {}),
        ...(whatsapp !== undefined ? { whatsapp: whatsapp ?? null } : {}),
        ...(dto.birthDate !== undefined ? { birthDate: dto.birthDate ? new Date(dto.birthDate) : null } : {}),
        ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
        ...(dto.maritalStatus !== undefined ? { maritalStatus: dto.maritalStatus } : {}),
        ...(dto.sizeDefault !== undefined ? { sizeDefault: dto.sizeDefault } : {}),
        ...(dto.sizeSecondary !== undefined ? { sizeSecondary: dto.sizeSecondary } : {}),
        ...(dto.bodyType !== undefined ? { bodyType: dto.bodyType } : {}),
        ...(dto.preferredStyle !== undefined ? { preferredStyle: dto.preferredStyle } : {}),
        ...(dto.favoriteColors !== undefined ? { favoriteColors: dto.favoriteColors } : {}),
        ...(dto.avoidedPieces !== undefined ? { avoidedPieces: dto.avoidedPieces } : {}),
        ...(dto.vipTier !== undefined ? { vipTier: dto.vipTier, tierEnteredAt: new Date() } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.inactiveReason !== undefined ? { inactiveReason: dto.inactiveReason } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      });
    } catch (e: any) {
      this.erroDeEscrita(e, 'salvar a ficha do cliente');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LISTAGEM / DETALHE
  // ─────────────────────────────────────────────────────────────────────────
  async list(query: ListQuery = {}, actor?: RequestActor) {
    const page  = Math.max(1, query.page ?? 1);
    const limit = Math.min(500, Math.max(1, query.limit ?? 50));
    // Default agora: ordem alfabética por nome (asc). Antes era createdAt desc
    // — usuário pediu alfabético pra facilitar busca visual.
    const orderBy = query.orderBy ?? 'name';
    const order   = query.order ?? (query.orderBy === 'name' || !query.orderBy ? 'asc' : 'desc');

    const where: any = {};

    // SCOPE POR LOJA — vendedora/loja vê:
    //   1. Clientes nascidos na loja dela (originStoreId)
    //   2. Clientes WC que moram perto dela (targetStoreId) — badge "🌐 SITE"
    //
    // Matriz (admin/operator) pode filtrar por storeId via query, ou ver tudo.
    // Usa AND array pra combinar storeFilter + searchFilter sem conflito de OR
    const andClauses: any[] = [];
    const buildStoreFilter = (storeId: string) => ({
      OR: [{ originStoreId: storeId }, { targetStoreId: storeId } as any],
    });
    if (actor && !isMatrix(actor)) {
      if (!actor.storeId) {
        return { data: [], total: 0, page, limit, scopedBy: 'store_no_store' };
      }
      andClauses.push(buildStoreFilter(actor.storeId));
    } else if (query.storeId) {
      andClauses.push(buildStoreFilter(query.storeId));
    }

    if (query.tier) where.vipTier = query.tier;
    if (query.rfvSegment) where.rfvSegment = query.rfvSegment;
    if (query.hasWhatsapp) where.whatsapp = { not: null };
    if (query.search?.trim()) {
      const q = query.search.trim();
      const digits = q.replace(/\D/g, '');
      const or: any[] = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
      if (digits.length > 0) {
        or.push(
          { cpf: { contains: digits } },
          { whatsapp: { contains: digits } },
          { phone: { contains: digits } },
        );
      }
      // Empilha no AND junto do storeFilter (não usa where.OR direto pra
      // não conflitar com o OR do storeFilter)
      andClauses.push({ OR: or });
    }

    if (andClauses.length > 0) where.AND = andClauses;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        orderBy: { [orderBy]: order },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          cashbackBalance: true,
          originStore: { select: { id: true, code: true, name: true } },
          targetStore: { select: { id: true, code: true, name: true } } as any,
          _count: { select: { tags: true, addresses: true } },
        } as any,
      }),
    ]);

    // Filtro post-query pra hasCashbackBalance (Prisma não filtra 1:1 facilmente)
    let data: any[] = rows as any[];
    if (query.hasCashbackBalance) {
      data = data.filter((c: any) => (c.cashbackBalance?.balanceCents ?? 0) > 0);
    }

    const scopedBy = actor && !isMatrix(actor) ? `store:${actor.storeId}` : 'global';

    return {
      scopedBy,
      data: (data as any[]).map((c: any) => ({
        id: c.id,
        name: c.name,
        nameSocial: c.nameSocial,
        cpf: c.cpf,
        whatsapp: c.whatsapp,
        email: c.email,
        birthDate: c.birthDate,
        sizeDefault: c.sizeDefault,
        vipTier: c.vipTier,
        rfvSegment: c.rfvSegment,
        cashbackBalanceCents: c.cashbackBalance?.balanceCents ?? 0,
        cashbackNextExpiration: c.cashbackBalance?.nextExpirationAt ?? null,
        orderCount: c.orderCount,
        ltvCents: c.ltvCents.toString(),
        ticketMedioCents: c.ticketMedioCents,
        lastOrderAt: c.lastOrderAt,
        originStore: c.originStore,
        originSource: c.originSource,
        targetStore: c.targetStore || null,
        isMixed: !!c.targetStoreId && c.originSource === 'woo',
        tagsCount: c._count?.tags ?? 0,
        addressesCount: c._count?.addresses ?? 0,
        active: c.active,
      })),
      total,
      page,
      limit,
    };
  }

  async detail(id: string, actor?: RequestActor) {
    const c = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        cashbackBalance: true,
        addresses: { where: { active: true }, orderBy: { isPrimary: 'desc' } },
        tags: { include: { tag: true } },
        originStore: { select: { id: true, code: true, name: true } },
        referredBy: { select: { id: true, name: true, cpf: true } },
      },
    });
    if (!c) throw new NotFoundException('Cliente não encontrado');

    // SCOPE POR LOJA — vendedora de outra loja não pode ver.
    // MESMO critério da list(): originStoreId OU targetStoreId (cliente WC
    // atribuído à loja por CEP). Antes só originStoreId — cliente "SITE"
    // aparecia na lista mas a ficha dava 404 e o drawer travava.
    if (actor && !isMatrix(actor)) {
      const ok =
        !!actor.storeId &&
        (c.originStoreId === actor.storeId || (c as any).targetStoreId === actor.storeId);
      if (!ok) {
        throw new NotFoundException('Cliente não encontrado');  // 404 disfarça existência
      }
    }

    // Últimos 20 movimentos de cashback
    const cashbackTransactions = await this.prisma.cashbackTransaction.findMany({
      where: { customerId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { store: { select: { code: true, name: true } } },
    });

    // Consentimentos atuais por canal (último registro)
    const consents = await this.prisma.customerConsent.findMany({
      where: { customerId: id },
      orderBy: { grantedAt: 'desc' },
    });
    const currentConsents: Record<string, boolean> = {};
    for (const ev of consents) {
      if (!(ev.channel in currentConsents)) currentConsents[ev.channel] = ev.granted;
    }

    // Caminho C: BigInts dos campos Giga novos precisam virar string pra
    // serializar em JSON (NestJS explode com BigInt nativo). Excluímos
    // gigaRawData do payload — UI não usa e payload fica enorme.
    const { gigaRawData, ...rest } = c as any;
    return {
      ...rest,
      ltvCents: c.ltvCents.toString(),
      trabalhoSalarioCents: (c as any).trabalhoSalarioCents?.toString() ?? null,
      limiteCrediarioCents: (c as any).limiteCrediarioCents?.toString() ?? null,
      aluguelCents: (c as any).aluguelCents?.toString() ?? null,
      hasGigaRawData: !!gigaRawData,
      cashbackBalance: c.cashbackBalance
        ? {
            ...c.cashbackBalance,
            accumulatedTotalCents: c.cashbackBalance.accumulatedTotalCents.toString(),
            redeemedTotalCents:    c.cashbackBalance.redeemedTotalCents.toString(),
            expiredTotalCents:     c.cashbackBalance.expiredTotalCents.toString(),
          }
        : null,
      cashbackTransactions,
      currentConsents,
      tags: c.tags.map(ct => ct.tag),
    };
  }

  /**
   * Ficha única beta. Customer continua sendo o registro operacional por
   * origem/loja; esta leitura resolve a Person e escolhe o melhor valor real
   * entre os Customers vinculados sem apagar procedência.
   */
  async betaList(query: ListQuery, actor?: RequestActor) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const matrix = isMatrix(actor);
    const scope = !matrix && actor?.storeId
      ? { OR: [{ originStoreId: actor.storeId }, { targetStoreId: actor.storeId }] }
      : {};

    const rows: any[] = await this.prisma.customer.findMany({
      where: { active: true, ...scope },
      select: {
        id: true, personId: true, personKey: true, name: true, nameSocial: true,
        cpf: true, email: true, whatsapp: true, originSource: true,
        originStoreId: true, targetStoreId: true, vipTier: true, orderCount: true,
        ltvCents: true, ticketMedioCents: true, lastOrderAt: true, updatedAt: true,
        originStore: { select: { id: true, code: true, name: true } },
        targetStore: { select: { id: true, code: true, name: true } },
        cashbackBalance: { select: { balanceCents: true } },
      },
    });

    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const key = customerIdentityKey(row);
      const current = groups.get(key) || [];
      current.push(row);
      groups.set(key, current);
    }

    const search = String(query.search || '').trim().toLocaleLowerCase('pt-BR');
    const digits = search.replace(/\D/g, '');
    const requestedStore = matrix ? String(query.storeId || '') : '';
    const people = Array.from(groups.values()).filter((records) => {
      if (search && !records.some((r) => {
        const text = [r.name, r.nameSocial, r.email].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR');
        const recordDigits = [r.cpf, r.whatsapp].filter(Boolean).join(' ').replace(/\D/g, '');
        return text.includes(search) || (!!digits && recordDigits.includes(digits));
      })) return false;
      if (requestedStore && !records.some((r) => r.originStoreId === requestedStore || r.targetStoreId === requestedStore)) return false;
      if (query.tier && !records.some((r) => r.vipTier === query.tier)) return false;
      if (query.hasWhatsapp && !records.some((r) => !!r.whatsapp)) return false;
      if (query.hasCashbackBalance && !records.some((r) => Number(r.cashbackBalance?.balanceCents || 0) > 0)) return false;
      return true;
    }).map((records) => {
      const ordered = orderCanonicalRecords(records);
      const canonical = ordered[0];
      const nameRecord = chooseCanonicalNameRecord(records);
      const cpfRecord = ordered.find((r) => r.cpf) || canonical;
      const whatsappRecord = ordered.find((r) => r.whatsapp) || canonical;
      const ltvCents = records.reduce((sum, r) => sum + Number(r.ltvCents || 0), 0);
      const orderCount = records.reduce((sum, r) => sum + Number(r.orderCount || 0), 0);
      const cashbackBalanceCents = records.reduce((sum, r) => sum + Number(r.cashbackBalance?.balanceCents || 0), 0);
      const lastOrderAt = records.map((r) => r.lastOrderAt).filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
      return {
        id: canonical.id,
        personId: canonical.personId,
        name: nameRecord.name,
        nameSocial: nameRecord.nameSocial,
        cpf: cpfRecord.cpf,
        whatsapp: whatsappRecord.whatsapp,
        vipTier: canonical.vipTier,
        orderCount,
        ltvCents: String(ltvCents),
        ticketMedioCents: orderCount ? Math.round(ltvCents / orderCount) : 0,
        cashbackBalanceCents,
        lastOrderAt,
        originStore: canonical.originStore,
        targetStore: canonical.targetStore,
        origins: ordered.map((r) => ({
          id: r.id, name: r.name, nameSocial: r.nameSocial, cpf: r.cpf,
          whatsapp: r.whatsapp, originSource: r.originSource,
          originStore: r.originStore, targetStore: r.targetStore,
          orderCount: r.orderCount, ltvCents: String(r.ltvCents),
          lastOrderAt: r.lastOrderAt, updatedAt: r.updatedAt,
        })),
      };
    }).sort((a, b) => String(a.nameSocial || a.name || '').localeCompare(String(b.nameSocial || b.name || ''), 'pt-BR'));

    const total = people.length;
    return { data: people.slice((page - 1) * limit, page * limit), total, page, limit };
  }

  async archiveDuplicate(id: string, actor: RequestActor) {
    const customer: any = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        originStore: { select: { code: true, name: true } },
        targetStore: { select: { code: true, name: true } },
        cashbackBalance: { select: { balanceCents: true } },
      },
    });
    if (!customer || !customer.active) throw new NotFoundException('Cadastro de origem não encontrado');

    const identityWhere = customer.personId
      ? { personId: customer.personId }
      : customer.personKey ? { personKey: customer.personKey } : { id: customer.id };
    const activeCount = await this.prisma.customer.count({ where: { ...identityWhere, active: true } });
    const hasMovement = Number(customer.orderCount || 0) > 0
      || Number(customer.ltvCents || 0) > 0
      || Number(customer.cashbackBalance?.balanceCents || 0) > 0;
    // Registro isolado só pode ser arquivado diretamente quando está vazio.
    // Com movimento, exigimos outra origem ativa da mesma identidade.
    if (activeCount <= 1 && hasMovement) {
      throw new ConflictException('Este cadastro possui movimentação e não está vinculado a outra origem ativa');
    }

    const snapshot = {
      id: customer.id, name: customer.name, nameSocial: customer.nameSocial,
      cpf: customer.cpf, originSource: customer.originSource,
      originStore: customer.originStore, targetStore: customer.targetStore,
      orderCount: customer.orderCount, ltvCents: String(customer.ltvCents),
      cashbackBalanceCents: customer.cashbackBalance?.balanceCents || 0,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({
        where: { id },
        data: { active: false, inactiveReason: 'duplicate_archived_by_admin' },
      });
      await tx.customerDuplicateAudit.create({
        data: {
          customerId: id,
          personId: customer.personId,
          actorUserId: actor.userId,
          action: 'archived',
          reason: 'Duplicidade removida pela lista Beta',
          snapshot,
        },
      });
    });
    return { ok: true, mode: 'archived', customerId: id };
  }

  async betaDetail(id: string, actor?: RequestActor) {
    const seed = await this.loadScoped(id, actor);
    const identityWhere = seed.personId
      ? { personId: seed.personId }
      : seed.personKey
        ? { personKey: seed.personKey }
        : { id: seed.id };
    const scopedWhere = !isMatrix(actor) && actor?.storeId
      ? { OR: [{ originStoreId: actor.storeId }, { targetStoreId: actor.storeId }] }
      : {};
    const rows = await this.prisma.customer.findMany({
      where: { ...identityWhere, ...scopedWhere, active: true },
      select: { id: true, originSource: true, updatedAt: true },
    });
    const records = await Promise.all(rows.map((row) => this.detail(row.id, actor)));
    records.splice(0, records.length, ...orderCanonicalRecords(records));

    const canonical: any = { ...records.find((r: any) => r.id === id) };
    const scalarFields = [
      'name', 'nameSocial', 'cpf', 'rg', 'registroGiga', 'email', 'phone', 'whatsapp',
      'birthDate', 'gender', 'maritalStatus', 'igUsername', 'sizeDefault',
      'sizeSecondary', 'bodyType', 'preferredStyle', 'favoriteColors', 'avoidedPieces',
      'originSeller', 'vipTier', 'tierEnteredAt', 'rfvSegment', 'rfvEngagement', 'notes',
      'naturalidade', 'pai', 'mae', 'conjugeNome', 'conjugeCpf', 'trabalhoRazaoSocial',
      'trabalhoCargo', 'trabalhoSalarioCents', 'trabalhoAdmissao', 'trabalhoFone',
      'nomeRecado', 'foneRecado', 'limiteCrediarioCents', 'bloqueadoGiga',
      'negativadoGiga', 'fidelidadeGiga', 'spcSituacao', 'spcData', 'casaPropria',
      'aluguelCents',
    ];
    for (const field of scalarFields) {
      const chosen = records.find((r: any) => r[field] !== null && r[field] !== undefined && r[field] !== '');
      if (chosen) canonical[field] = (chosen as any)[field];
    }
    const canonicalName = chooseCanonicalNameRecord(records);
    canonical.name = canonicalName.name;
    canonical.nameSocial = canonicalName.nameSocial;

    // Origem da PESSOA não pode depender do Customer usado para abrir a URL.
    // Prefere o cadastro físico mais antigo (PDV/Giga); o site pode ser apenas
    // um vínculo posterior e, nesse caso, não transforma a origem em SITE.
    const physicalSources = new Set(['pdv', 'physical', 'giga']);
    const originRecord = records
      .filter((r: any) => physicalSources.has(r.originSource) && r.originStore)
      .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0]
      || records.find((r: any) => r.originStore);
    if (originRecord) {
      canonical.originSource = originRecord.originSource;
      canonical.originStoreId = originRecord.originStoreId;
      canonical.originStore = originRecord.originStore;
    }

    const totalLtvCents = records.reduce((sum: number, r: any) => sum + Number(r.ltvCents || 0), 0);
    const totalOrderCount = records.reduce((sum: number, r: any) => sum + Number(r.orderCount || 0), 0);
    const channels = Array.from(new Set(records.map((r: any) => r.originSource).filter(Boolean)));
    const stores = Array.from(new Set(records.map((r: any) => r.originStore?.code).filter(Boolean)));
    const addresses = Array.from(new Map(records.flatMap((r: any) => r.addresses || []).map((a: any) => [a.id, a])).values());
    const cashbackTransactions = records.flatMap((r: any) => r.cashbackTransactions || [])
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);
    const cashbackBalance = {
      balanceCents: records.reduce((sum: number, r: any) => sum + Number(r.cashbackBalance?.balanceCents || 0), 0),
      accumulatedTotalCents: String(records.reduce((sum: number, r: any) => sum + Number(r.cashbackBalance?.accumulatedTotalCents || 0), 0)),
      redeemedTotalCents: String(records.reduce((sum: number, r: any) => sum + Number(r.cashbackBalance?.redeemedTotalCents || 0), 0)),
      expiredTotalCents: String(records.reduce((sum: number, r: any) => sum + Number(r.cashbackBalance?.expiredTotalCents || 0), 0)),
      nextExpirationAt: records.map((r: any) => r.cashbackBalance?.nextExpirationAt).filter(Boolean).sort()[0] || null,
      nextExpirationCents: records.reduce((sum: number, r: any) => sum + Number(r.cashbackBalance?.nextExpirationCents || 0), 0),
    };

    // A liberação de marcado pertence à ficha física (loja + código),
    // não ao Customer consolidado. Retornar as fichas separadamente evita
    // alterar Itanhaém quando o administrador pretendia liberar outra loja.
    const recordIds = records.map((r: any) => r.id);
    const markedAuthorizations: any[] = await (this.prisma as any).gigaCliente.findMany({
      where: {
        OR: [
          ...(recordIds.length ? [{ customerId: { in: recordIds } }] : []),
          ...(seed.personId ? [{ personId: seed.personId }] : []),
          ...(seed.personKey ? [{ personKey: seed.personKey }] : []),
        ],
      },
      select: {
        loja: true, codigo: true, avaliacao: true, limiteCompras: true,
        bloqueado: true, editedAt: true, editedBy: true,
      },
      orderBy: [{ loja: 'asc' }, { codigo: 'asc' }],
    });

    return {
      ...canonical,
      id, // mutações continuam ancoradas no Customer aberto e autorizado
      ltvCents: String(totalLtvCents),
      orderCount: totalOrderCount,
      ticketMedioCents: totalOrderCount ? Math.round(totalLtvCents / totalOrderCount) : 0,
      addresses,
      cashbackTransactions,
      cashbackBalance,
      markedAuthorizations: markedAuthorizations.map((f: any) => ({
        storeCode: f.loja,
        customerCode: f.codigo,
        evaluation: String(f.avaliacao || '').trim().toUpperCase() || null,
        limit: f.limiteCompras == null ? null : Number(f.limiteCompras),
        blocked: String(f.bloqueado || '').trim().toUpperCase() === 'SIM',
        allowed: String(f.avaliacao || '').trim().toUpperCase() === 'A'
          && Number(f.limiteCompras || 0) > 0
          && String(f.bloqueado || '').trim().toUpperCase() !== 'SIM',
        editedAt: f.editedAt,
        editedBy: f.editedBy,
      })),
      personSummary: {
        personId: seed.personId,
        personKey: seed.personKey,
        identityStatus: seed.personId ? 'consolidated' : 'provisional',
        totalCadastros: records.length,
        totalLtvCents,
        totalOrderCount,
        canais: channels,
        lojas: stores,
        records: records.map((r: any) => ({
          id: r.id, name: r.name, originSource: r.originSource,
          originStore: r.originStore, updatedAt: r.updatedAt,
        })),
      },
    };
  }

  async updateCredit(id: string, dto: UpdateCustomerCreditDto, actor: RequestActor) {
    const before: any = await this.loadScoped(id, actor);
    const cents = (value: number | null | undefined) => value === undefined
      ? undefined
      : value === null
        ? null
        : BigInt(Math.round(Number(value) * 100));
    const data: any = {
      ...(dto.limiteCrediario !== undefined ? { limiteCrediarioCents: cents(dto.limiteCrediario) } : {}),
      ...(dto.bloqueado !== undefined ? { bloqueadoGiga: !!dto.bloqueado } : {}),
      ...(dto.negativado !== undefined ? { negativadoGiga: !!dto.negativado } : {}),
      ...(dto.spcSituacao !== undefined ? { spcSituacao: dto.spcSituacao?.trim() || null } : {}),
      ...(dto.spcData !== undefined ? { spcData: dto.spcData ? new Date(dto.spcData) : null } : {}),
      ...(dto.trabalhoRazaoSocial !== undefined ? { trabalhoRazaoSocial: dto.trabalhoRazaoSocial?.trim() || null } : {}),
      ...(dto.trabalhoCargo !== undefined ? { trabalhoCargo: dto.trabalhoCargo?.trim() || null } : {}),
      ...(dto.trabalhoSalario !== undefined ? { trabalhoSalarioCents: cents(dto.trabalhoSalario) } : {}),
      ...(dto.trabalhoAdmissao !== undefined ? { trabalhoAdmissao: dto.trabalhoAdmissao ? new Date(dto.trabalhoAdmissao) : null } : {}),
      ...(dto.trabalhoFone !== undefined ? { trabalhoFone: this.normalizePhone(dto.trabalhoFone) } : {}),
      ...(dto.casaPropria !== undefined ? { casaPropria: dto.casaPropria } : {}),
      ...(dto.aluguel !== undefined ? { aluguelCents: cents(dto.aluguel) } : {}),
    };
    const oldSnapshot = Object.fromEntries(Object.keys(data).map((key) => [key, before[key]]));
    const stringifyAudit = (value: any) => JSON.stringify(
      value,
      (_key, item) => typeof item === 'bigint' ? item.toString() : item,
    );
    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({ where: { id }, data });
      await tx.masterAudit.create({
        data: {
          action: 'customer_credit_edit', entityType: 'customer', entityId: id,
          storeCode: null, storeName: null, level: 'ADMIN',
          userName: actor.userId || 'admin',
          oldValue: stringifyAudit(oldSnapshot),
          newValue: stringifyAudit(data),
          motivo: 'Edição administrativa pela ficha única beta',
        },
      });
      return updated;
    });
    this.logger.log(`[CRM beta] crédito de ${id} alterado por ${actor.userId}`);
    return { ok: true, id: after.id, updatedAt: after.updatedAt };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLIENTE MISTO — atribui targetStoreId baseado em range CEP da Store
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Atribui targetStoreId pros Customers de canal ONLINE que têm CEP na
   * CustomerAddress(type=entrega).
   *
   * Pra cada Customer:
   *   1. Pega o cep do endereço de entrega
   *   2. Normaliza pros 5 primeiros dígitos (inteiro)
   *   3. Procura Store cujos cepRanges cobrem esse CEP
   *   4. Atribui targetStoreId (loja física candidata)
   *
   * Cliente que JÁ é da loja física (originSource='giga'/'pdv'/'physical') não
   * é tocado — ele já tem loja de origem, não precisa de candidata.
   * Cliente online sem CEP fica com targetStoreId=null.
   *
   * ── QUEM ENTRA (corrigido em 10/08/2026) ──
   *
   * O filtro era `originSource: 'woo'` — só cliente do WooCommerce. Cliente do
   * site novo nasce com `originSource: 'site'` (ver `LojaOrdersService.
   * upsertCustomer`) e portanto NUNCA era processado: nunca ganhava loja
   * candidata, e a vendedora nunca via o selo de cliente do site na ficha.
   * `live` fica de fora de propósito — cliente da live já tem a loja que
   * apresentou como origem, atribuir outra por CEP brigaria com isso.
   */
  /**
   * A atribuição rodava SÓ no botão da retaguarda — se ninguém clicasse,
   * ninguém era atribuído, e não havia como perceber a falta (o cliente só
   * aparecia sem loja candidata). Cliente novo chega todo dia; um passo manual
   * que precisa acontecer todo dia é um passo que uma hora não acontece.
   *
   * 4h30 da manhã: longe do expediente e depois do espelho Wincred das 3h.
   * O botão manual continua valendo pra quando o dono cadastrar range de CEP
   * novo e quiser ver o efeito na hora, sem esperar a madrugada.
   *
   * `TARGET_STORES_CRON=0` desliga sem deploy.
   */
  @Cron('0 30 4 * * *', { name: 'customers-target-stores-cep' })
  async assignTargetStoresByCepCron(): Promise<void> {
    if (String(process.env.TARGET_STORES_CRON ?? '1') === '0') return;
    try {
      await this.assignTargetStoresByCep();
    } catch (e: any) {
      // Atribuição é conveniência de atendimento, não caminho de venda:
      // falhar aqui não pode derrubar nada, só reclamar e tentar amanhã.
      this.logger.error(`[target-stores] cron falhou: ${e?.message || e}`);
    }
  }

  async assignTargetStoresByCep(): Promise<{
    processados: number;
    atribuidos: number;
    semCep: number;
    semRangeMatch: number;
    duracaoMs: number;
  }> {
    const t0 = Date.now();

    // 1) Carrega TODAS as stores com cepRanges definido
    const stores = await this.prisma.store.findMany({
      where: { cepRanges: { not: null }, active: true } as any,
      select: { id: true, code: true, name: true, cepRanges: true } as any,
    });
    const storeRanges: Array<{ id: string; code: string; ranges: Array<[number, number]> }> = [];
    for (const s of stores as any[]) {
      try {
        const parsed = JSON.parse(s.cepRanges);
        if (Array.isArray(parsed)) {
          const ranges = (parsed as any[])
            .filter((r) => Array.isArray(r) && r.length === 2)
            .map((r) => [Number(r[0]), Number(r[1])] as [number, number]);
          if (ranges.length > 0) storeRanges.push({ id: s.id, code: s.code, ranges });
        }
      } catch { /* ignora cepRanges inválido */ }
    }
    this.logger.log(`[target-stores] ${storeRanges.length} lojas com ranges CEP cadastrados`);

    // 2) Carrega Customers de canal online com pelo menos 1 CustomerAddress.
    // Lista explícita em vez de "tudo que não é loja física": originSource novo
    // que apareça amanhã não entra aqui por acidente.
    const customers = await this.prisma.customer.findMany({
      where: { originSource: { in: ['woo', 'site'] } },
      select: {
        id: true,
        targetStoreId: true,
        addresses: { select: { cep: true, type: true } } as any,
      } as any,
    });

    let atribuidos = 0;
    let semCep = 0;
    let semRangeMatch = 0;

    for (const c of customers as any[]) {
      // Prefere endereço de entrega; fallback pra qualquer addr com cep
      let cep: string | null = null;
      const entrega = c.addresses?.find((a: any) => a.type === 'entrega' && a.cep);
      if (entrega) cep = entrega.cep;
      else cep = c.addresses?.find((a: any) => a.cep)?.cep || null;

      if (!cep) { semCep++; continue; }
      const cepNum = parseInt(String(cep).replace(/\D/g, '').slice(0, 5), 10);
      if (!Number.isFinite(cepNum)) { semCep++; continue; }

      // Acha loja mais ESPECÍFICA (menor range que cobre o CEP)
      let matched: { id: string; rangeSize: number } | null = null;
      for (const s of storeRanges) {
        for (const [start, end] of s.ranges) {
          if (cepNum >= start && cepNum <= end) {
            const size = end - start;
            if (!matched || size < matched.rangeSize) {
              matched = { id: s.id, rangeSize: size };
            }
          }
        }
      }

      if (!matched) { semRangeMatch++; continue; }
      if (c.targetStoreId !== matched.id) {
        await this.prisma.customer.update({
          where: { id: c.id },
          data: { targetStoreId: matched.id },
        });
      }
      atribuidos++;
    }

    this.logger.log(
      `[target-stores] processados=${customers.length} atribuidos=${atribuidos} ` +
      `semCep=${semCep} semRangeMatch=${semRangeMatch} ${Date.now() - t0}ms`,
    );

    return {
      processados: customers.length,
      atribuidos,
      semCep,
      semRangeMatch,
      duracaoMs: Date.now() - t0,
    };
  }

  /**
   * Cadastra ranges de CEP padrão pras 15 lojas conhecidas (faixa Correios
   * aproximada). Usuário pode ajustar via tela /lojas/[id] depois.
   * NÃO sobrescreve ranges já cadastrados.
   */
  async seedCepRangesPadrao(): Promise<{ atualizados: number; jaTinha: number; semStore: number }> {
    // Mapa code → ranges aproximados (CORREIOS, faixas principais)
    const RANGES_PADRAO: Record<string, Array<[number, number]>> = {
      '01': [[11740, 11749]],                    // Itanhaém
      '02': [[11000, 11099], [11500, 11599]],    // Santos
      '03': [[13280, 13289]],                    // Vinhedo
      '04': [[13300, 13349]],                    // Indaiatuba + Itu (Itu fechada → absorve)
      '05': [[13400, 13429]],                    // Piracicaba
      '06': [[18000, 18109]],                    // Sorocaba
      '07': [[13000, 13139]],                    // Campinas
      '08': [[12200, 12249]],                    // São José dos Campos
      '10': [[13201, 13219]],                    // Jundiaí
      '11': [[13480, 13489]],                    // Limeira
      '14': [[11700, 11729]],                    // Praia Grande
      '15': [[4500, 4599]],                      // Moema (SP capital) — CEP 04500-04599
      '17': [[8600, 8799]],                      // Suzano + Mogi (Mogi fechada → absorve) — CEP 08600-08799
      // ❌ Itu (19) e Mogi das Cruzes (18): FECHADAS — leads absorvidos
      //    por Indaiatuba (04) e Suzano (17) respectivamente.
    };

    let atualizados = 0;
    let jaTinha = 0;
    let semStore = 0;

    for (const [code, ranges] of Object.entries(RANGES_PADRAO)) {
      const store = await this.prisma.store.findUnique({ where: { code } });
      if (!store) { semStore++; continue; }
      if ((store as any).cepRanges) { jaTinha++; continue; } // não sobrescreve
      await this.prisma.store.update({
        where: { id: store.id },
        data: { cepRanges: JSON.stringify(ranges) } as any,
      });
      atualizados++;
    }

    return { atualizados, jaTinha, semStore };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CAMINHO C — VISÃO POR PESSOA (consolidado entre canais)
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Retorna TODOS os outros Customers que compartilham o mesmo personKey.
   * Útil pra mostrar no drawer "esta pessoa também tem cadastro em X, Y".
   *
   * Inclui agregação básica: totalLtvCents somado, totalOrderCount, lista
   * de lojas distintas onde tem cadastro.
   */
  async byPerson(id: string, actor?: RequestActor) {
    const me = await this.loadScoped(id, actor);
    if (!me.personId && !me.personKey) {
      return {
        personId: null,
        personKey: null,
        outros: [],
        agregado: null,
        message: 'Sem chave de pessoa (CPF/email indisponível).',
      };
    }
    const todos = await this.prisma.customer.findMany({
      where: {
        ...(me.personId ? { personId: me.personId } : { personKey: me.personKey! }),
        ...(!isMatrix(actor) && actor?.storeId
          ? { OR: [{ originStoreId: actor.storeId }, { targetStoreId: actor.storeId }] }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        whatsapp: true,
        originSource: true,
        originStoreId: true,
        originStore: { select: { code: true, name: true } },
        ltvCents: true,
        orderCount: true,
        lastOrderAt: true,
        vipTier: true,
      },
    });
    const outros = todos.filter((c) => c.id !== id);
    const agregado = {
      totalCadastros: todos.length,
      totalLtvCents: todos.reduce((s, c) => s + Number(c.ltvCents || 0), 0),
      totalOrderCount: todos.reduce((s, c) => s + (c.orderCount || 0), 0),
      lojas: Array.from(
        new Set(todos.map((c) => c.originStore?.code).filter(Boolean)),
      ).sort(),
      canais: Array.from(new Set(todos.map((c) => c.originSource).filter(Boolean))),
    };
    return { personId: me.personId, personKey: me.personKey, outros, agregado };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HISTÓRICO DE MOVIMENTAÇÃO
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Timeline cronológica das interações do cliente:
   *  - Compras: PdvSale (loja física) + Order (site e live) — ver abaixo
   *  - Devoluções (PdvReturn com customerCpf)
   *  - Vales-troca emitidos (PdvReturn com creditoCode)
   *  - Marcados ativos (tabela nativa `marcados` — por CPF ou ficha Giga da pessoa)
   *
   * ── POR QUE A COMPRA ONLINE ENTRA AQUI (10/08/2026) ──
   *
   * Até esta data o histórico lia SÓ `PdvSale`. Uma cliente que comprava cinco
   * vezes pelo site e uma vez na loja aparecia pra vendedora com UMA compra —
   * a ficha dizia que ela era cliente nova quando ela era a melhor cliente da
   * base. O dado sempre esteve ligado (o mesmo `Customer` é usado pelos dois
   * lados); faltava esta consulta.
   *
   * ⚠️ O CPF É GRAVADO EM DOIS FORMATOS na tabela `orders`, e é fácil errar:
   * pedido do WooCommerce passa por `cleanCpf()` e grava MASCARADO
   * ("123.456.789-00"); pedido do site novo e da live gravam só DÍGITOS. Uma
   * busca por um formato só devolve metade do histórico sem erro nenhum — a
   * ficha pareceria certa, apenas incompleta. Por isso o `in` com as duas
   * formas. Se algum dia a `orders` for normalizada num formato só, este `in`
   * pode virar igualdade — até lá, não simplificar.
   */
  async historico(id: string, actor?: RequestActor) {
    const customer = await this.loadScoped(id, actor);
    const cpf = (customer.cpf || '').replace(/\D/g, '');
    if (!cpf || cpf.length !== 11) {
      return {
        customer: { id: customer.id, name: customer.name, cpf: customer.cpf },
        compras: [],
        devolucoes: [],
        // estrutura completa pra frontend não quebrar em .toFixed/access
        vales: { ativos: [], usados: [], saldoAtivo: 0, saldoUsado: 0 },
        marcadosGiga: { items: [], total: 0, qtd: 0, parcial: false },
        warning: 'Cliente sem CPF cadastrado — busca limitada',
      };
    }

    // 1. Compras (PdvSale finalizadas, exclui MARCADO e cancelled)
    const compras = await (this.prisma as any).pdvSale.findMany({
      where: {
        OR: [
          ...(customer.personId ? [{ personId: customer.personId }] : []),
          { customerCpf: cpf },
        ],
        status: 'finalized',
        NOT: { paymentMethod: 'MARCADO' },
      },
      orderBy: { finalizedAt: 'desc' },
      take: 100,
      select: {
        id: true, storeCode: true, storeName: true,
        total: true, subtotal: true, desconto: true,
        paymentMethod: true, sellerName: true, vendedorName: true,
        finalizedAt: true, createdAt: true, nfceNumber: true,
        _count: { select: { items: true, payments: true } },
        payments: { select: { method: true, valor: true } },
      },
    });

    // 1b. Compras ONLINE (Order: site WooCommerce, site novo e live).
    // Cancelado/malsucedido fica de fora: não é compra, e contar como compra
    // inflaria o LTV que a vendedora usa pra decidir como atender.
    // ⚠️ A lista de status vive em common/pedido-pago.ts. A versão antiga aqui
    // barrava só 'cancelled'/'failed' e deixava entrar 'payment_failed' (cartão
    // RECUSADO) e 'awaiting_payment' (PIX nunca pago) — a vendedora via como
    // cliente boa quem tinha tentado e não conseguido pagar.
    const cpfMascarado = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
    let comprasOnline: any[] = [];
    try {
      comprasOnline = await (this.prisma as any).order.findMany({
        where: comPedidoPago({
          OR: [
            ...(customer.personId ? [{ personId: customer.personId }] : []),
            { customerCpf: { in: [cpf, cpfMascarado] } },
          ],
          // Pedido ONLINE do PDV fica FORA: a venda dele já aparece na ficha
          // como PdvSale (caixa da loja vendedora) — listar o Order junto
          // mostraria a MESMA compra duas vezes.
          source: { not: 'pdv_online' },
        }),
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true, wcOrderNumber: true, source: true, status: true,
          totalAmount: true, sellerName: true, paymentInfo: true,
          isPickup: true, pickupStoreCode: true,
          paidAt: true, wcDateCreated: true, createdAt: true,
          _count: { select: { items: true } },
        },
      });
    } catch (e: any) {
      // Mesma postura das outras seções: uma fonte que falha não pode deixar
      // a ficha inteira em branco — a vendedora está com a cliente na frente.
      this.logger.warn(`[historico] compras online falharam: ${e?.message}`);
    }

    // 2. Devoluções (PdvReturn)
    const devolucoes = await (this.prisma as any).pdvReturn.findMany({
      where: { customerCpf: cpf },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, storeCode: true, storeName: true,
        modo: true, valorTotal: true, status: true,
        creditoCode: true, creditoValidade: true,
        creditoUsadoEm: true, creditoUsadoAt: true,
        originalSaleNumber: true, originalSaleId: true,
        userName: true, createdAt: true,
        _count: { select: { items: true } },
      },
    });

    // 3. Vales-troca emitidos no nome dele (subset das devoluções com código)
    const valesAtivos: any[] = [];
    const valesUsados: any[] = [];
    const agora = Date.now();
    for (const r of devolucoes as any[]) {
      if (!r.creditoCode) continue;
      const venc = r.creditoValidade ? new Date(r.creditoValidade).getTime() : Infinity;
      const isUsed = r.status === 'used';
      const isVencido = !isUsed && venc < agora;
      const info = {
        code: r.creditoCode,
        valor: r.valorTotal,
        validade: r.creditoValidade,
        usadoEm: r.creditoUsadoAt,
        usadoSaleId: r.creditoUsadoEm,
        emitidoEm: r.createdAt,
        loja: r.storeName,
        vencido: isVencido,
      };
      if (isUsed) valesUsados.push(info);
      else if (!isVencido) valesAtivos.push(info);
    }

    // 4. Marcados ATIVOS — tabela NATIVA `marcados` (Flow). Até 03/09 isto
    // era runReadOnly na caixa do Giga (MARCADO='SIM'): com o pool morto a
    // ficha mostrava 0 marcado pra todo mundo, sem erro nenhum. Mesmo
    // critério do resumo do clientes-giga: CPF (dígitos) OU ficha Giga da
    // pessoa (codCliente com variantes de zero à esquerda + loja 2 dígitos).
    // `parcial` = a seção NÃO pôde ser calculada (não é "cliente sem marcado").
    // Sem esse sinal, falha na consulta vira 0 marcado na ficha — a mesma
    // mentira silenciosa que o Giga morto contava.
    let marcadosGiga = { items: [] as any[], total: 0, qtd: 0, parcial: false };
    try {
      // ⚠️ SEM `.catch(() => [])` aqui: sem as fichas do Giga o ramo por
      // `codCliente` some e o marcado da cliente pode não aparecer — o vazio
      // seria indistinguível de "não tem marcado". A falha sobe pro catch
      // abaixo, que loga E marca a seção como incompleta.
      const fichas: any[] = await (this.prisma as any).gigaCliente.findMany({
        where: { personKey: `cpf:${cpf}`, arquivadoEm: null },
        select: { loja: true, codigo: true },
      });
      // Código do Giga tem padding de zero inconsistente: '01234' e '1234'
      // são a mesma pessoa. Sem as variantes a consulta responde vazio.
      const codVariants = (cod: any): string[] => {
        const c = String(cod ?? '').trim();
        const set = new Set<string>();
        if (c) set.add(c);
        const noZeros = c.replace(/^0+/, '');
        if (noZeros) set.add(noZeros);
        if (/^\d+$/.test(c)) set.add(String(Number(c)));
        return [...set];
      };
      const rows: any[] = await (this.prisma as any).marcado.findMany({
        where: {
          status: 'ativo',
          isTraining: false,
          OR: [
            { cpf }, // marcados guarda CPF só em dígitos
            ...fichas.map((f: any) => ({
              codCliente: { in: codVariants(f.codigo) },
              storeCode: String(f.loja).replace(/\D/g, '').padStart(2, '0'),
            })),
          ],
        },
        orderBy: [{ dataMarcacao: 'desc' }],
        take: 100,
      });
      marcadosGiga.items = rows.map((row: any) => ({
        // registroGiga é BigInt — sem Number() o JSON.stringify estoura (500 mudo)
        registro: row.registroGiga != null ? Number(row.registroGiga) : null,
        sku: String(row.sku || '').trim(),
        descricao: String(row.descricao || '').trim(),
        qtd: Number(row.qty) || 1,
        valor: Number(row.valorUnit) || 0,
        total: Number(row.valorTotal) || 0,
        data: row.dataMarcacao,
        loja: String(row.storeCode || '').trim(),
      }));
      marcadosGiga.qtd = marcadosGiga.items.reduce((s: number, m: any) => s + m.qtd, 0);
      marcadosGiga.total = marcadosGiga.items.reduce((s: number, m: any) => s + m.total, 0);
    } catch (e: any) {
      // A ficha inteira não cai por causa dos marcados, mas a seção assume que
      // está INCOMPLETA em vez de mostrar zero como se fosse a verdade.
      this.logger.warn(`[historico] marcados nativos falharam: ${e?.message}`);
      marcadosGiga = { items: [], total: 0, qtd: 0, parcial: true };
    }

    /**
     * Loja física e online viram UMA lista só, ordenada por data. A cliente
     * não pensa em "canal" — ela comprou. `canal` fica em cada linha pra tela
     * distinguir com um selo, mas o histórico é um só, que é a promessa do
     * sistema unificado.
     */
    const comprasLoja = (compras as any[]).map((s) => ({
      canal: 'loja' as const,
      id: s.id,
      saleNumber: String(s.id).slice(0, 8),
      nfceNumber: s.nfceNumber,
      storeCode: s.storeCode,
      storeName: s.storeName,
      total: s.total,
      subtotal: s.subtotal,
      desconto: s.desconto,
      paymentMethod: s.paymentMethod,
      sellerName: s.sellerName || s.vendedorName,
      qtdItens: s._count?.items || 0,
      qtdPayments: s._count?.payments || 0,
      payments: s.payments,
      status: null as string | null,
      data: s.finalizedAt || s.createdAt,
    }));

    const comprasDoOnline = comprasOnline.map((o) => {
      // `paymentInfo` só existe no pedido do site novo (JSON em texto, convenção
      // da casa). WooCommerce e live não guardam — daí o chip de pagamento
      // simplesmente não aparece, em vez de aparecer errado.
      let metodo: string | null = null;
      try {
        if (o.paymentInfo) metodo = JSON.parse(o.paymentInfo)?.method ?? null;
      } catch {
        /* JSON quebrado não pode derrubar a ficha */
      }
      const canal: 'site' | 'live' = o.source === 'live' ? 'live' : 'site';
      return {
        canal,
        id: o.id,
        saleNumber: o.wcOrderNumber || String(o.id).slice(0, 8),
        nfceNumber: null,
        storeCode: o.pickupStoreCode || null,
        // Onde a venda aconteceu, na linguagem de quem lê a ficha.
        storeName: canal === 'live' ? 'LIVE' : o.isPickup ? 'SITE · retirada' : 'SITE',
        total: o.totalAmount,
        subtotal: o.totalAmount,
        desconto: 0,
        paymentMethod: metodo,
        sellerName: o.sellerName,
        qtdItens: o._count?.items || 0,
        qtdPayments: metodo ? 1 : 0,
        payments: metodo ? [{ method: metodo, valor: Number(o.totalAmount ?? 0) }] : [],
        // Pedido online tem vida depois de pago (separando, enviado, entregue)
        // — a vendedora precisa saber pra responder "cadê meu pedido?".
        status: o.status as string | null,
        data: o.paidAt || o.wcDateCreated || o.createdAt,
      };
    });

    const comprasUnificadas = [...comprasLoja, ...comprasDoOnline].sort(
      (a, b) => new Date(b.data).getTime() - new Date(a.data).getTime(),
    );

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        cpf: customer.cpf,
      },
      compras: comprasUnificadas,
      devolucoes: (devolucoes as any[]).map((r) => ({
        id: r.id,
        returnNumber: String(r.id).slice(0, 8),
        storeCode: r.storeCode,
        storeName: r.storeName,
        modo: r.modo,
        valor: r.valorTotal,
        status: r.status,
        creditoCode: r.creditoCode,
        creditoValidade: r.creditoValidade,
        creditoUsado: r.status === 'used',
        creditoUsadoAt: r.creditoUsadoAt,
        originalSaleNumber: r.originalSaleNumber,
        userName: r.userName,
        qtdItens: r._count?.items || 0,
        data: r.createdAt,
      })),
      vales: {
        ativos: valesAtivos,
        usados: valesUsados,
        saldoAtivo: valesAtivos.reduce((s: number, v: any) => s + Number(v.valor || 0), 0),
      },
      marcadosGiga,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENDEREÇOS
  // ─────────────────────────────────────────────────────────────────────────
  async addAddress(customerId: string, dto: CreateAddressDto, actor?: RequestActor) {
    await this.loadScoped(customerId, actor);

    // Se for primary, desmarca outros do mesmo tipo
    if (dto.isPrimary) {
      await this.prisma.customerAddress.updateMany({
        where: { customerId, type: dto.type, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    return this.prisma.customerAddress.create({
      data: {
        customerId,
        type: dto.type,
        isPrimary: dto.isPrimary ?? false,
        cep: this.normalizeCep(dto.cep),
        street: dto.street,
        number: dto.number,
        complement: dto.complement,
        district: dto.district,
        city: dto.city,
        state: dto.state,
        reference: dto.reference,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONSENTIMENTOS LGPD
  // ─────────────────────────────────────────────────────────────────────────
  async registerConsent(customerId: string, dto: ConsentDto, actor?: RequestActor) {
    await this.loadScoped(customerId, actor);

    return this.prisma.customerConsent.create({
      data: {
        customerId,
        channel: dto.channel,
        granted: dto.granted,
        termVersion: dto.termVersion,
        source: dto.source,
        registeredByUserId: dto.registeredByUserId,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CASHBACK — credit / redeem
  // ─────────────────────────────────────────────────────────────────────────
  async creditCashback(customerId: string, dto: CreditCashbackDto, actor?: RequestActor) {
    await this.loadScoped(customerId, actor);
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { cashbackBalance: true },
    });
    if (!c) throw new NotFoundException('Cliente não encontrado');
    if (dto.valueCents <= 0) throw new BadRequestException('valor deve ser positivo');

    const balanceBefore = c.cashbackBalance?.balanceCents ?? 0;
    const balanceAfter  = balanceBefore + dto.valueCents;

    const creditedAt = new Date();
    creditedAt.setDate(creditedAt.getDate() + CREDIT_GRACE_DAYS);
    const expiresAt = new Date(creditedAt);
    expiresAt.setDate(expiresAt.getDate() + this.validityDaysForTier(c.vipTier));

    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.cashbackTransaction.create({
        data: {
          customerId,
          type: 'credit',
          valueCents: dto.valueCents,
          balanceBeforeCents: balanceBefore,
          balanceAfterCents:  balanceAfter,
          orderId: dto.orderId,
          storeId: dto.storeId,
          purchaseValueCents: dto.purchaseValueCents,
          percentApplied: dto.percentApplied,
          creditedAt,
          expiresAt,
          description: dto.description ?? 'Crédito por compra',
          userId: dto.userId,
        },
      });

      await tx.cashbackBalance.upsert({
        where: { customerId },
        create: {
          customerId,
          balanceCents: dto.valueCents,
          accumulatedTotalCents: BigInt(dto.valueCents),
          nextExpirationAt: expiresAt,
          nextExpirationCents: dto.valueCents,
        },
        update: {
          balanceCents: balanceAfter,
          accumulatedTotalCents: { increment: dto.valueCents },
          // se ainda não tinha expiração agendada, agenda; senão mantém a mais próxima
          nextExpirationAt: c.cashbackBalance?.nextExpirationAt ?? expiresAt,
          nextExpirationCents: c.cashbackBalance?.nextExpirationCents ?? dto.valueCents,
        },
      });

      return txn;
    });
  }

  async redeemCashback(customerId: string, dto: RedeemCashbackDto, actor?: RequestActor) {
    await this.loadScoped(customerId, actor);
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { cashbackBalance: true },
    });
    if (!c) throw new NotFoundException('Cliente não encontrado');

    const balance = c.cashbackBalance?.balanceCents ?? 0;
    if (balance < REDEEM_MIN_CENTS)
      throw new BadRequestException(`Saldo abaixo do mínimo de R$ ${REDEEM_MIN_CENTS / 100}`);
    if (dto.valueCents > balance)
      throw new BadRequestException(`Saldo insuficiente. Disponível: R$ ${balance / 100}`);

    const maxRedeem = Math.round(dto.purchaseValueCents * MAX_REDEEM_PCT);
    if (dto.valueCents > maxRedeem)
      throw new BadRequestException(
        `Pode usar no máximo R$ ${maxRedeem / 100} nesta compra (30% do valor)`,
      );

    const balanceAfter = balance - dto.valueCents;

    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.cashbackTransaction.create({
        data: {
          customerId,
          type: 'redeem',
          valueCents: dto.valueCents,
          balanceBeforeCents: balance,
          balanceAfterCents:  balanceAfter,
          orderId: dto.orderId,
          storeId: dto.storeId,
          purchaseValueCents: dto.purchaseValueCents,
          description: `Resgate em pedido ${dto.orderId ?? ''}`.trim(),
          userId: dto.userId,
        },
      });

      await tx.cashbackBalance.update({
        where: { customerId },
        data: {
          balanceCents: balanceAfter,
          redeemedTotalCents: { increment: dto.valueCents },
        },
      });

      return txn;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TAGS
  // ─────────────────────────────────────────────────────────────────────────
  async listTags() {
    return this.prisma.tag.findMany({ orderBy: { name: 'asc' } });
  }

  async createTag(name: string, description?: string, color?: string) {
    return this.prisma.tag.create({
      data: { name: name.trim(), description, color: color ?? '#888888' },
    });
  }

  async applyTag(customerId: string, tagId: string, appliedBy?: string, actor?: RequestActor) {
    await this.loadScoped(customerId, actor);
    return this.prisma.customerTag.upsert({
      where: { customerId_tagId: { customerId, tagId } },
      create: { customerId, tagId, appliedBy },
      update: { appliedBy, appliedAt: new Date() },
    });
  }

  async removeTag(customerId: string, tagId: string, actor?: RequestActor) {
    await this.loadScoped(customerId, actor);
    return this.prisma.customerTag.delete({
      where: { customerId_tagId: { customerId, tagId } },
    });
  }
}
