import { MarketingRecoveryService } from './marketing-recovery.service';

describe('MarketingRecoveryService ecommerce contacts', () => {
  it('inclui contato do checkout na fila manual após uma hora', async () => {
    const prisma = {
      waMessage: { findMany: jest.fn().mockResolvedValue([]) },
      waOptOut: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const abandoned = {
      list: jest.fn().mockResolvedValue({ ok: true, items: [] }),
      listEcommercePending: jest.fn().mockResolvedValue({ ok: true, items: [{
        id: 970000000, recovery_id: 'recovery-1', source: 'ecommerce-contact',
        first_name: 'Maria', last_name: 'Silva', phone: '11987654321',
        cart_total: 249.9, time: new Date(Date.now() - 61 * 60_000).toISOString(),
        cart_items: [{ name: 'Vestido', quantity: 2, unitPrice: 124.95 }],
      }] }),
    };
    const service = new MarketingRecoveryService(prisma as any, abandoned as any);

    const result = await service.listCandidates({ stepFilter: 'pending' });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      sourceType: 'ecommerce', sourceId: 'recovery-1', name: 'Maria Silva',
      nextStepIndex: 0, itemCount: 2, productSummary: 'Vestido', amount: 249.9,
    }));
  });
});
