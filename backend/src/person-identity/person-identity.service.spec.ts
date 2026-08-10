import { PersonIdentityService } from './person-identity.service';

function customer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1', personId: null, cpf: null, name: 'Maria', nameSocial: null,
    email: null, phone: '13999990000', birthDate: null, igUserId: null,
    createdAt: new Date('2020-01-01T00:00:00Z'), originSource: 'giga',
    originStoreId: 'store-1', ...overrides,
  };
}

describe('PersonIdentityService', () => {
  it('não une por telefone isolado', async () => {
    const prisma: any = { customer: { findUnique: jest.fn().mockResolvedValue(customer()) } };
    const service = new PersonIdentityService(prisma);
    await expect(service.linkCustomer('customer-1')).resolves.toEqual({
      linked: false, reason: 'no_strong_identifier',
    });
  });

  it('reutiliza personId já vinculado sem escrever', async () => {
    const prisma: any = {
      customer: { findUnique: jest.fn().mockResolvedValue(customer({ personId: 'person-1' })) },
      $transaction: jest.fn(),
    };
    const service = new PersonIdentityService(prisma);
    await expect(service.linkCustomer('customer-1')).resolves.toEqual({
      linked: true, personId: 'person-1', rule: 'existing',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('vincula CPF válido de forma idempotente e auditada', async () => {
    const tx: any = {
      person: { upsert: jest.fn().mockResolvedValue({ id: 'person-1' }) },
      customer: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      personIdentifier: { upsert: jest.fn().mockResolvedValue({ id: 'identifier-1' }) },
      personLinkAudit: { upsert: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma: any = {
      customer: { findUnique: jest.fn().mockResolvedValue(customer({ cpf: '529.982.247-25' })) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = new PersonIdentityService(prisma);
    await expect(service.linkCustomer('customer-1')).resolves.toEqual({
      linked: true, personId: 'person-1', rule: 'valid_cpf_exact',
    });
    expect(tx.person.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { cpfNormalized: '52998224725' },
    }));
    expect(tx.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'customer-1', personId: null }, data: { personId: 'person-1' },
    });
    expect(tx.personLinkAudit.upsert).toHaveBeenCalledTimes(1);
  });
});
