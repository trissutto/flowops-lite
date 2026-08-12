import { restoreAuditedPersonLinks } from './person-link-recovery';

describe('restoreAuditedPersonLinks', () => {
  it('restores only audited null links', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ count: 0n }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(42),
    };
    await expect(restoreAuditedPersonLinks(prisma, 'crediario_parcela')).resolves.toBe(42);
    expect(prisma.$executeRawUnsafe.mock.calls[0][0]).toContain('t.person_id IS NULL');
    expect(prisma.$executeRawUnsafe.mock.calls[0][0]).toContain("entity_type = 'crediario_parcela'");
  });

  it('blocks restoration when one entity has multiple audited persons', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ count: 1n }]),
      $executeRawUnsafe: jest.fn(),
    };
    await expect(restoreAuditedPersonLinks(prisma, 'giga_cliente')).rejects.toThrow('auditorias conflitantes');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

