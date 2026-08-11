import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeCpf } from './identity-normalization';

export type PersonLinkResult = {
  linked: boolean;
  personId?: string;
  rule?: 'existing' | 'valid_cpf_exact' | 'official_instagram_id';
  reason?: string;
};

@Injectable()
export class PersonIdentityService {
  private readonly logger = new Logger(PersonIdentityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async linkCustomer(customerId: string): Promise<PersonLinkResult> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        personId: true,
        cpf: true,
        name: true,
        nameSocial: true,
        email: true,
        phone: true,
        birthDate: true,
        igUserId: true,
        createdAt: true,
        originSource: true,
        originStoreId: true,
      },
    });
    if (!customer) return { linked: false, reason: 'customer_not_found' };
    if (customer.personId) return { linked: true, personId: customer.personId, rule: 'existing' };

    const cpf = normalizeCpf(customer.cpf);
    if (cpf) return this.linkByCpf(customer, cpf);
    if (customer.igUserId) return this.linkByOfficialInstagram(customer, customer.igUserId);
    return { linked: false, reason: 'no_strong_identifier' };
  }

  private async linkByCpf(customer: any, cpf: string): Promise<PersonLinkResult> {
    return this.prisma.$transaction(async (tx) => {
      const person = await tx.person.upsert({
        where: { cpfNormalized: cpf },
        create: {
          cpfNormalized: cpf,
          identityStatus: 'confirmed',
          name: customer.name,
          socialName: customer.nameSocial,
          email: customer.email,
          phone: customer.phone,
          birthDate: customer.birthDate,
          primaryCustomerId: customer.id,
          firstRegistrationAt: customer.createdAt,
          firstRegistrationSource: customer.originSource || 'flow',
          firstRegistrationStoreId: customer.originStoreId,
        },
        update: {},
      });
      await this.persistLink(tx, customer.id, person.id, 'valid_cpf_exact', 100, {
        type: 'cpf', value: cpf, uniqueKey: `cpf:${cpf}`, verified: true,
      }, 'upsert');
      return { linked: true, personId: person.id, rule: 'valid_cpf_exact' };
    });
  }

  private async linkByOfficialInstagram(customer: any, igUserId: string): Promise<PersonLinkResult> {
    const uniqueKey = `instagram_user_id:${igUserId}`;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const identifier = await tx.personIdentifier.findUnique({ where: { uniqueKey } });
        const person = identifier
          ? await tx.person.findUniqueOrThrow({ where: { id: identifier.personId } })
          : await tx.person.create({
              data: {
                identityStatus: 'provisional',
                name: customer.name,
                socialName: customer.nameSocial,
                email: customer.email,
                phone: customer.phone,
                primaryCustomerId: customer.id,
                firstRegistrationAt: customer.createdAt,
                firstRegistrationSource: customer.originSource || 'live',
                firstRegistrationStoreId: customer.originStoreId,
              },
            });
        await this.persistLink(tx, customer.id, person.id, 'official_instagram_id', 100, {
          type: 'instagram_user_id', value: igUserId, uniqueKey, verified: true,
        }, identifier ? 'skip' : 'create');
        return { linked: true, personId: person.id, rule: 'official_instagram_id' };
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const identifier = await this.prisma.personIdentifier.findUnique({ where: { uniqueKey } });
        if (identifier) return this.linkCustomerToKnownPerson(customer.id, identifier.personId);
      }
      throw error;
    }
  }

  private async linkCustomerToKnownPerson(customerId: string, personId: string): Promise<PersonLinkResult> {
    await this.prisma.$transaction((tx) =>
      this.persistLink(tx, customerId, personId, 'official_instagram_id', 100),
    );
    return { linked: true, personId, rule: 'official_instagram_id' };
  }

  private async persistLink(
    tx: any,
    customerId: string,
    personId: string,
    rule: string,
    confidence: number,
    identifier?: { type: string; value: string; uniqueKey: string; verified: boolean },
    identifierWrite: 'create' | 'upsert' | 'skip' = 'create',
  ): Promise<void> {
    await tx.customer.updateMany({ where: { id: customerId, personId: null }, data: { personId } });
    if (identifier && identifierWrite !== 'skip') {
      const data = {
          personId,
          type: identifier.type,
          normalizedValue: identifier.value,
          uniqueKey: identifier.uniqueKey,
          verified: identifier.verified,
          source: 'runtime',
          sourceCustomerId: customerId,
          verifiedAt: identifier.verified ? new Date() : null,
      };
      if (identifierWrite === 'upsert') {
        await tx.personIdentifier.upsert({ where: { uniqueKey: identifier.uniqueKey }, create: data, update: {} });
      } else {
        await tx.personIdentifier.create({ data });
      }
    }
    await tx.personLinkAudit.upsert({
      where: { personId_entityType_entityId_rule: { personId, entityType: 'customer', entityId: customerId, rule } },
      create: { personId, entityType: 'customer', entityId: customerId, rule, confidence, automatic: true },
      update: {},
    });
    this.logger.debug(`customer=${customerId} person=${personId} rule=${rule}`);
  }
}
