import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestActor } from './customers-crm.service';

export type IdentitySuggestionType = 'phone' | 'instagram';

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

export function reviewHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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
      where: { active: true, OR: [{ phone: { not: null } }, { whatsapp: { not: null } }, { igUsername: { not: null } }] },
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
      add('phone', normalizeReviewPhone(c.phone), c);
      add('phone', normalizeReviewPhone(c.whatsapp), c);
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
    return {
      key: g.key,
      type: g.type,
      matchMasked: g.type === 'phone' ? `(**) *****-${g.normalizedValue.slice(-4)}` : `@${g.normalizedValue}`,
      participantCount: g.candidates.length,
      unlinkedCount: g.candidates.filter((c) => !c.personId).length,
      existingPersonCount: new Set(g.candidates.map((c) => c.personId).filter(Boolean)).size,
      totalLtvCents: g.candidates.reduce((sum, c) => sum + Number(c.ltvCents), 0),
      totalOrders: g.candidates.reduce((sum, c) => sum + c.orderCount, 0),
      candidates: g.candidates.map((c) => this.publicCandidate(c)),
    };
  }

  async list(page = 1, limit = 20) {
    const all = await this.groups();
    const decisions = await this.prisma.personReviewDecision.findMany({
      where: { OR: all.map((g) => ({ suggestionType: g.type, suggestionHash: g.suggestionHash, participantKey: g.participantKey })) },
      select: { suggestionType: true, suggestionHash: true, participantKey: true },
    });
    const decided = new Set(decisions.map((d) => `${d.suggestionType}:${d.suggestionHash}:${d.participantKey}`));
    const pending = all.filter((g) => !decided.has(`${g.type}:${g.suggestionHash}:${g.participantKey}`));
    const safeLimit = Math.min(100, Math.max(1, limit));
    const safePage = Math.max(1, page);
    return {
      total: pending.length, page: safePage, limit: safeLimit,
      items: pending.slice((safePage - 1) * safeLimit, safePage * safeLimit).map((g) => this.summary(g)),
    };
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
