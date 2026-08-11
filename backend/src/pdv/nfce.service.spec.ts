import { BadRequestException } from '@nestjs/common';
import { NfceService } from './nfce.service';

describe('NfceService - sequencia fiscal', () => {
  function serviceWith(prisma: any) {
    return new NfceService(prisma);
  }

  it('reutiliza o numero ja reservado sem incrementar a configuracao', async () => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ nfce_number: '155' }])
        .mockResolvedValueOnce([{ id: 'attempt-1' }]),
      $executeRawUnsafe: jest.fn(),
    };
    const prisma = { $transaction: (fn: any) => fn(tx) };
    const service = serviceWith(prisma);

    const numero = await (service as any).reserveNumero('sale-1', '10', '4');

    expect(numero).toBe(155);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).toContain('nfce_attempts');
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('ignora numero fake do stub de preview (sem nfce_attempt) e renumera pelo contador', async () => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ nfce_number: '462823380' }])
        .mockResolvedValueOnce([]) // nenhum attempt com esse numero
        .mockResolvedValueOnce([{ numero_atual: 198 }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    const prisma = { $transaction: (fn: any) => fn(tx) };
    const service = serviceWith(prisma);

    const numero = await (service as any).reserveNumero('sale-stub', '02', '6');

    expect(numero).toBe(198);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pdv_sales'),
      '198',
      '6',
      'sale-stub',
    );
  });

  it('reserva novo numero com UPDATE atomico e o associa a venda', async () => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ nfce_number: null }])
        .mockResolvedValueOnce([{ numero_atual: 177 }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    const prisma = { $transaction: (fn: any) => fn(tx) };
    const service = serviceWith(prisma);

    const numero = await (service as any).reserveNumero('sale-2', '10', '4');

    expect(numero).toBe(177);
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).toContain('numero_atual = numero_atual + 1');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pdv_sales'),
      '177',
      '4',
      'sale-2',
    );
  });

  it('recusa uma segunda emissao concorrente da mesma venda', async () => {
    const prisma = { pdvSale: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } };
    const service = serviceWith(prisma);

    await expect((service as any).acquireEmissionLock('sale-3')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('bloqueia teste de emissao no ambiente de producao', async () => {
    const prisma = {
      nfceConfig: {
        findUnique: jest.fn().mockResolvedValue({
          storeCode: '10',
          ambiente: '1',
          cnpj: '50213437000424',
          ie: '1',
          cscToken: 'token',
          certPfxB64: 'pfx',
        }),
      },
    };
    const service = serviceWith(prisma);

    await expect(service.testEmit('10')).rejects.toBeInstanceOf(BadRequestException);
  });
});
