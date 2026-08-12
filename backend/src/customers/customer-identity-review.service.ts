import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestActor } from './customers-crm.service';

export type IdentitySuggestionType = 'phone' | 'email' | 'instagram';

export function normalizeReviewPhone(value?: string | null): string | null {
  if (!value) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length > 11 && digits.startsWith('55')) digits = digits.slice(2);
  return digits.length === 10 || digits.length === 11 ? digits : null;
}

export function normalizeReviewInstagram(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/^@+/, '').replace(/\s+/g, '');
  return normalized.length >= 2 ? normalized : null;
}

const GENERIC_EMAIL_LOCAL_PARTS = new Set([
  'admin', 'atendimento', 'caixa', 'comercial', 'contato', 'ecommerce',
  'financeiro', 'loja', 'noreply', 'naoresponder', 'sac', 'sememail',
  'site', 'suporte', 'teste', 'vendas',
]);

export function normalizeReviewEmail(value?: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || /\s/.test(normalized)) return null;
  const match = normalized.match(/^([^@]+)@([^@]+)$/);
  if (!match || !match[1] || !match[2].includes('.') || match[2].startsWith('.') || match[2].endsWith('.')) return null;
  const local = match[1].replace(/[^a-z0-9]/g, '');
  if (!local || GENERIC_EMAIL_LOCAL_PARTS.has(local)) return null;
  return normalized;
}

export function reviewHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedText(value?: string | null): string | null {
  if (!value) return null;
  const text = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return text || null;
}

const INTERNAL_CUSTOMER_NAMES = new Set(['defeitos', 'reserva', 'furto', 'perda']);

export function isInternalReviewCustomer(name?: string | null): boolean {
  const normalized = normalizedText(name);
  return normalized ? INTERNAL_CUSTOMER_NAMES.has(normalized) : false;
}

export type ReviewPriority = 'conflict' | 'high' | 'review';

export function classifyReviewCandidates(candidates: Array<Pick<Candidate, 'name' | 'email' | 'cpf' | 'personId' | 'originSource' | 'orderCount'>>): {
  priority: ReviewPriority; score: number; signals: string[]; partial: boolean; siteLive: boolean;
} {
  const signals: string[] = [];
  const distinct = (values: Array<string | null>) => new Set(values.filter((v): v is string => !!v));
  const names = distinct(candidates.map((c) => normalizedText(c.name)));
  const emails = distinct(candidates.map((c) => normalizedText(c.email)));
  const cpfs = distinct(candidates.map((c) => c.cpf?.replace(/\D/g, '').length === 11 ? c.cpf.replace(/\D/g, '') : null));
  const persons = distinct(candidates.map((c) => c.personId));
  const sources = distinct(candidates.map((c) => c.originSource?.toLowerCase() ?? null));
  const partial = persons.size === 1 && candidates.some((c) => !c.personId);
  const siteLive = sources.has('live') && ([...sources].some((s) => s === 'woo' || s === 'site' || s === 'woocommerce'));
  let score = 20;
  if (names.size === 1 && names.size > 0) { score += 40; signals.push('Nomes iguais'); }
  if (emails.size === 1 && emails.size > 0) { score += 25; signals.push('E-mails iguais'); }
  if (siteLive) { score += 15; signals.push('Site + Live'); }
  if (candidates.some((c) => c.orderCount > 0)) { score += 5; signals.push('Possui histórico'); }
  if (partial) { score += 10; signals.push('Vínculo parcial'); }
  if (cpfs.size > 1 || persons.size > 1) {
    signals.push(cpfs.size > 1 ? 'CPFs divergentes' : 'Persons conflitantes');
    return { priority: 'conflict', score: 0, signals, partial, siteLive };
  }
  return { priority: score >= 65 ? 'high' : 'review', score: Math.min(100, score), signals, partial, siteLive };
}

type Candidate = {
  id: string;
  personId: string | null;
  cpf: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  igUsername: string | null;
  originSource: string | null;
  originStoreId: string | null;
  createdAt: Date;
  ltvCents: bigint;
  orderCount: number;
  originStore: { code: string; name: string } | null;
};

type Group = {
  key: string;
  type: IdentitySuggestionType;
  suggestionHash: string;
  participantKey: string;
  normalizedValue: string;
  candidates: Candidate[];
};

const customerSelect = {
  id: true, personId: true, cpf: true, name: true, email: true,
  phone: true, whatsapp: true, igUsername: true, originSource: true,
  originStoreId: true, createdAt: true, ltvCents: true, orderCount: true,
  originStore: { select: { code: true, name: true } },
} satisfies Prisma.CustomerSelect;

@Injectable()
export class CustomerIdentityReviewService {
  constructor(private readonly prisma: PrismaService) {}

  private async groups(db: Prisma.TransactionClient | PrismaClient = this.prisma): Promise<Group[]> {
    const customers = await db.customer.findMany({
      where: { active: true, OR: [{ phone: { not: null } }, { whatsapp: { not: null } }, { email: { not: null } }, { igUsername: { not: null } }] },
      select: customerSelect,
    }) as Candidate[];
    const buckets = new Map<string, { type: IdentitySuggestionType; value: string; candidates: Map<string, Candidate> }>();

    const add = (type: IdentitySuggestionType, value: string | null, customer: Candidate) => {
      if (!value) return;
      const bucketKey = `${type}:${value}`;
      const bucket = buckets.get(bucketKey) ?? { type, value, candidates: new Map<string, Candidate>() };
      bucket.candidates.set(customer.id, customer);
      buckets.set(bucketKey, bucket);
    };
    for (const c of customers) {
      if (isInternalReviewCustomer(c.name)) continue;
      add('phone', normalizeReviewPhone(c.phone), c);
      add('phone', normalizeReviewPhone(c.whatsapp), c);
      add('email', normalizeReviewEmail(c.email), c);
      add('instagram', normalizeReviewInstagram(c.igUsername), c);
    }

    return [...buckets.values()].flatMap((bucket) => {
      const candidates = [...bucket.candidates.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (candidates.length < 2 || !candidates.some((c) => !c.personId)) return [];
      const suggestionHash = reviewHash(`${bucket.type}:${bucket.value}`);
      const participantKey = reviewHash(candidates.map((c) => c.id).sort().join(':'));
      return [{
        key: `${bucket.type}.${suggestionHash}.${participantKey}`,
        type: bucket.type,
        normalizedValue: bucket.value,
        suggestionHash,
        participantKey,
        candidates,
      }];
    });
  }

  private publicCandidate(c: Candidate) {
    const cpf = c.cpf?.replace(/\D/g, '') ?? '';
    const phone = normalizeReviewPhone(c.whatsapp || c.phone);
    return {
      id: c.id,
      personId: c.personId,
      name: c.name,
      email: c.email ? c.email.replace(/^(.{2}).*(@.*)$/, '$1***$2') : null,
      cpfMasked: cpf.length === 11 ? `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**` : null,
      phoneMasked: phone ? `(${phone.slice(0, 2)}) *****-${phone.slice(-4)}` : null,
      instagram: c.igUsername ? `@${normalizeReviewInstagram(c.igUsername)}` : null,
      originSource: c.originSource,
      store: c.originStore,
      firstRegistrationAt: c.createdAt,
      ltvCents: Number(c.ltvCents),
      orderCount: c.orderCount,
    };
  }

  private summary(g: Group) {
    const classification = classifyReviewCandidates(g.candidates);
    return {
      key: g.key,
      type: g.type,
      matchMasked: g.type === 'phone'
        ? `(**) *****-${g.normalizedValue.slice(-4)}`
        : g.type === 'email'
          ? g.normalizedValue.replace(/^(.{2}).*(@.*)$/, '$1***$2')
          : `@${g.normalizedValue}`,
      participantCount: g.candidates.length,
      unlinkedCount: g.candidates.filter((c) => !c.personId).length,
      existingPersonCount: new Set(g.candidates.map((c) => c.personId).filter(Boolean)).size,
      totalLtvCents: g.candidates.reduce((sum, c) => sum + Number(c.ltvCents), 0),
      totalOrders: g.candidates.reduce((sum, c) => sum + c.orderCount, 0),
      candidates: g.candidates.map((c) => this.publicCandidate(c)),
      ...classification,
    };
  }

  async list(query: { page?: number; limit?: number; priority?: string; type?: string; channel?: string; linkState?: string; search?: string } = {}) {
    const all = await this.groups();
    const decisions = await this.prisma.personReviewDecision.findMany({
      where: { OR: all.map((g) => ({ suggestionType: g.type, suggestionHash: g.suggestionHash, participantKey: g.participantKey })) },
      select: { suggestionType: true, suggestionHash: true, participantKey: true },
    });
    const decided = new Set(decisions.map((d) => `${d.suggestionType}:${d.suggestionHash}:${d.participantKey}`));
    const summaries = all.filter((g) => !decided.has(`${g.type}:${g.suggestionHash}:${g.participantKey}`)).map((g) => this.summary(g));
    const counters = summaries.reduce((acc, item) => { acc[item.priority]++; return acc; }, { conflict: 0, high: 0, review: 0 });
    const search = normalizedText(query.search);
    const pending = summaries.filter((item) =>
      (!query.priority || item.priority === query.priority) &&
      (!query.type || item.type === query.type) &&
      (!query.channel || query.channel !== 'site-live' || item.siteLive) &&
      (!query.linkState || (query.linkState === 'partial' ? item.partial : item.unlinkedCount === item.participantCount)) &&
      (!search || item.candidates.some((c) => normalizedText(c.name)?.includes(search))),
    ).sort((a, b) => ({ conflict: 0, high: 1, review: 2 }[a.priority] - { conflict: 0, high: 1, review: 2 }[b.priority]) || b.score - a.score);
    const safeLimit = Math.min(100, Math.max(1, query.limit ?? 20));
    const safePage = Math.max(1, query.page ?? 1);
    return {
      total: pending.length, counters, page: safePage, limit: safeLimit,
      items: pending.slice((safePage - 1) * safeLimit, safePage * safeLimit),
    };
  }

  async history(page = 1, limit = 30) {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safePage = Math.max(1, page);
    const [total, decisions] = await this.prisma.$transaction([
      this.prisma.personReviewDecision.count(),
      this.prisma.personReviewDecision.findMany({ orderBy: { decidedAt: 'desc' }, skip: (safePage - 1) * safeLimit, take: safeLimit }),
    ]);
    const ids = [...new Set(decisions.flatMap((d) => d.participantIds as string[]))];
    const customers = await this.prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, originSource: true, originStore: { select: { code: true, name: true } } } });
    const byId = new Map(customers.map((c) => [c.id, c]));
    return { total, page: safePage, limit: safeLimit, items: decisions.map((d) => ({
      id: d.id, decision: d.decision, suggestionType: d.suggestionType, actorUserId: d.actorUserId,
      reason: d.reason, decidedAt: d.decidedAt, destinationPersonId: d.destinationPersonId,
      rolledBackAt: d.rolledBackAt, canRollback: d.decision === 'confirmed' && !d.rolledBackAt,
      participants: (d.participantIds as string[]).map((id) => byId.get(id) ?? { id, name: 'Cadastro indisponível', originSource: null, originStore: null }),
    })) };
  }

  async detail(key: string) {
    const group = (await this.groups()).find((g) => g.key === key);
    if (!group) throw new NotFoundException('Sugestão não existe mais ou o conjunto de clientes mudou');
    return this.summary(group);
  }

  async confirm(key: string, reason: string, actor: RequestActor) {
    if (!reason?.trim() || reason.trim().length < 3) throw new BadRequestException('Informe o motivo da confirmação');
    return this.prisma.$transaction(async (tx) => {
      const group = (await this.groups(tx)).find((g) => g.key === key);
      if (!group) throw new ConflictException('Grupo alterado; atualize a fila antes de confirmar');
      if (classifyReviewCandidates(group.candidates).priority === 'conflict') {
        throw new ConflictException('Conflito de identidade: revise CPF e vínculos existentes antes de confirmar');
      }
      const personIds = [...new Set(group.candidates.map((c) => c.personId).filter((id): id is string => !!id))];
      if (personIds.length > 1) throw new ConflictException('Conflito: os cadastros já apontam para pessoas diferentes');
      const previousState = group.candidates.map((c) => ({ customerId: c.id, personId: c.personId }));
      const first = group.candidates[0];
      const destinationPersonId = personIds[0] ?? (await tx.person.create({ data: {
        identityStatus: 'provisional', name: first.name, email: first.email, phone: first.whatsapp || first.phone,
        primaryCustomerId: first.id, firstRegistrationAt: first.createdAt,
        firstRegistrationSource: first.originSource?.slice(0, 20), firstRegistrationStoreId: first.originStoreId,
      }, select: { id: true } })).id;

      const changed = group.candidates.filter((c) => !c.personId);
      if (changed.length) {
        await tx.customer.updateMany({ where: { id: { in: changed.map((c) => c.id) }, personId: null }, data: { personId: destinationPersonId } });
        await tx.personLinkAudit.createMany({ data: changed.map((c) => ({
          personId: destinationPersonId, entityType: 'Customer', entityId: c.id,
          rule: 'manual_identity_review', confidence: 100, automatic: false, actor: actor.userId,
          metadata: { suggestionType: group.type, suggestionHash: group.suggestionHash, reason: reason.trim() },
        })), skipDuplicates: true });
      }
      const decision = await tx.personReviewDecision.create({ data: {
        suggestionType: group.type, suggestionHash: group.suggestionHash, participantKey: group.participantKey,
        participantIds: group.candidates.map((c) => c.id), decision: 'confirmed', destinationPersonId,
        actorUserId: actor.userId, reason: reason.trim(), previousState,
      }});
      return { decisionId: decision.id, destinationPersonId, linkedCustomers: changed.length };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async reject(key: string, reason: string, actor: RequestActor) {
    if (!reason?.trim() || reason.trim().length < 3) throw new BadRequestException('Informe o motivo da rejeição');
    return this.prisma.$transaction(async (tx) => {
      const group = (await this.groups(tx)).find((g) => g.key === key);
      if (!group) throw new ConflictException('Grupo alterado; atualize a fila antes de rejeitar');
      return tx.personReviewDecision.create({ data: {
        suggestionType: group.type, suggestionHash: group.suggestionHash, participantKey: group.participantKey,
        participantIds: group.candidates.map((c) => c.id), decision: 'rejected', actorUserId: actor.userId,
        reason: reason.trim(), previousState: group.candidates.map((c) => ({ customerId: c.id, personId: c.personId })),
      }});
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async rollback(decisionId: string, actor: RequestActor) {
    return this.prisma.$transaction(async (tx) => {
      const decision = await tx.personReviewDecision.findUnique({ where: { id: decisionId } });
      if (!decision || decision.decision !== 'confirmed') throw new NotFoundException('Confirmação não encontrada');
      if (decision.rolledBackAt) throw new ConflictException('Esta decisão já foi desfeita');
      const previous = decision.previousState as Array<{ customerId: string; personId: string | null }>;
      let restored = 0;
      for (const state of previous) {
        const result = await tx.customer.updateMany({
          where: { id: state.customerId, personId: decision.destinationPersonId }, data: { personId: state.personId },
        });
        restored += result.count;
      }
      await tx.personReviewDecision.update({ where: { id: decision.id }, data: { rolledBackAt: new Date(), rolledBackByUserId: actor.userId } });
      return { decisionId, restoredCustomers: restored };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
