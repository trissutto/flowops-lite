import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ErpService } from '../erp/erp.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly erp: ErpService,
  ) {}

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
  private async loadScoped(customerId: string, actor?: RequestActor) {
    const c = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!c) throw new NotFoundException('Cliente não encontrado');
    if (actor && !isMatrix(actor)) {
      if (!actor.storeId || c.originStoreId !== actor.storeId) {
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
    // REGRA (jun/2026): mesma pessoa pode ter cadastro em N lojas Giga.
    // Só bloqueia se o CPF já existe NA MESMA LOJA do actor (evita
    // duplicar cadastro dentro da própria loja). Loja diferente: permite.
    if (cpf) {
      const cpfDigits = cpf.replace(/\D/g, '');
      const scopeStoreId = actor && !isMatrix(actor) ? actor.storeId : (dto.originStoreId || null);
      const whereScope: any = {
        OR: [{ cpf }, { cpf: cpfDigits }],
      };
      if (scopeStoreId) whereScope.originStoreId = scopeStoreId;
      const existing = await this.prisma.customer.findFirst({
        where: whereScope,
        select: { id: true, name: true, cpf: true },
      });
      if (existing) {
        throw new ConflictException({
          message: `CPF já cadastrado nesta loja: ${existing.name} (${existing.cpf})`,
          customerId: existing.id,
          customerName: existing.name,
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

    return this.prisma.customer.update({
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

    // SCOPE POR LOJA — vendedora/loja só vê os clientes da loja dela.
    // Matriz (admin/operator) pode filtrar por storeId via query, ou ver tudo.
    if (actor && !isMatrix(actor)) {
      if (!actor.storeId) {
        // Usuário sem loja vinculada → não vê nada (defensivo)
        return { data: [], total: 0, page, limit, scopedBy: 'store_no_store' };
      }
      where.originStoreId = actor.storeId;
    } else if (query.storeId) {
      where.originStoreId = query.storeId;
    }

    if (query.tier) where.vipTier = query.tier;
    if (query.rfvSegment) where.rfvSegment = query.rfvSegment;
    if (query.hasWhatsapp) where.whatsapp = { not: null };
    if (query.search?.trim()) {
      const q = query.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { cpf: { contains: q.replace(/\D/g, '') } },
        { whatsapp: { contains: q.replace(/\D/g, '') } },
        { phone: { contains: q.replace(/\D/g, '') } },
      ];
    }

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
          _count: { select: { tags: true, addresses: true } },
        },
      }),
    ]);

    // Filtro post-query pra hasCashbackBalance (Prisma não filtra 1:1 facilmente)
    let data = rows;
    if (query.hasCashbackBalance) {
      data = data.filter(c => (c.cashbackBalance?.balanceCents ?? 0) > 0);
    }

    const scopedBy = actor && !isMatrix(actor) ? `store:${actor.storeId}` : 'global';

    return {
      scopedBy,
      data: data.map(c => ({
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
        tagsCount: c._count.tags,
        addressesCount: c._count.addresses,
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

    // SCOPE POR LOJA — vendedora de outra loja não pode ver
    if (actor && !isMatrix(actor)) {
      if (!actor.storeId || c.originStoreId !== actor.storeId) {
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

    return {
      ...c,
      ltvCents: c.ltvCents.toString(),
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
    if (!me.personKey) {
      return {
        personKey: null,
        outros: [],
        agregado: null,
        message: 'Sem chave de pessoa (CPF/email indisponível).',
      };
    }
    const todos = await this.prisma.customer.findMany({
      where: { personKey: me.personKey },
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
    return { personKey: me.personKey, outros, agregado };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HISTÓRICO DE MOVIMENTAÇÃO
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Timeline cronológica das interações do cliente:
   *  - Compras (PdvSale finalizadas com customerCpf)
   *  - Devoluções (PdvReturn com customerCpf)
   *  - Vales-troca emitidos (PdvReturn com creditoCode)
   *  - Marcados ativos no Giga (caixa com MARCADO='SIM' no nome do cliente)
   */
  async historico(id: string, actor?: RequestActor) {
    const customer = await this.loadScoped(id, actor);
    const cpf = (customer.cpf || '').replace(/\D/g, '');
    if (!cpf || cpf.length !== 11) {
      return {
        customer: { id: customer.id, name: customer.name, cpf: customer.cpf },
        compras: [],
        devolucoes: [],
        vales: { ativos: [], usados: [] },
        marcadosGiga: { items: [], total: 0, qtd: 0 },
        warning: 'Cliente sem CPF cadastrado — busca limitada',
      };
    }

    // 1. Compras (PdvSale finalizadas, exclui MARCADO e cancelled)
    const compras = await (this.prisma as any).pdvSale.findMany({
      where: {
        customerCpf: cpf,
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

    // 4. Marcados ATIVOS no Giga (consulta direta caixa por nome ou CPF)
    let marcadosGiga = { items: [] as any[], total: 0, qtd: 0 };
    try {
      const cpfFormat = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
      const safeCpf = cpf.replace(/'/g, "''");
      const safeCpfFormat = cpfFormat.replace(/'/g, "''");
      // Tenta buscar pela TABELA clientes do Giga via codCliente JOIN caixa
      const sql = `
        SELECT cx.REGISTRO, cx.CODIGO, cx.DESCRICAO, cx.QUANTIDADE,
               cx.VALOR, cx.VALORTOTAL, cx.DATA, cx.LOJA, cx.CLIENTE
        FROM caixa cx
        INNER JOIN clientes c ON cx.CLIENTE = c.CODIGO
        WHERE UPPER(cx.MARCADO) = 'SIM'
          AND (
            REPLACE(REPLACE(REPLACE(c.CPF,'.',''),'-',''),'/','') = '${safeCpf}'
            OR c.CPF = '${safeCpfFormat}'
          )
        ORDER BY cx.DATA DESC
        LIMIT 100
      `;
      const r = await (this as any).erp?.runReadOnly?.(sql, { maxRows: 100, timeoutMs: 10000 });
      const rows = r?.rows || [];
      marcadosGiga.items = rows.map((row: any) => ({
        registro: Number(row.REGISTRO),
        sku: String(row.CODIGO || '').trim(),
        descricao: String(row.DESCRICAO || '').trim(),
        qtd: Number(row.QUANTIDADE) || 1,
        valor: Number(row.VALOR) || 0,
        total: Number(row.VALORTOTAL) || 0,
        data: row.DATA,
        loja: String(row.LOJA || '').trim(),
      }));
      marcadosGiga.qtd = marcadosGiga.items.reduce((s: number, m: any) => s + m.qtd, 0);
      marcadosGiga.total = marcadosGiga.items.reduce((s: number, m: any) => s + m.total, 0);
    } catch (e: any) {
      this.logger.warn(`[historico] marcados Giga falhou: ${e?.message}`);
    }

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        cpf: customer.cpf,
      },
      compras: (compras as any[]).map((s) => ({
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
        data: s.finalizedAt || s.createdAt,
      })),
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
