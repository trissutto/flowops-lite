import { HttpException } from '@nestjs/common';
import { AbandonedCartsService } from './abandoned-carts.service';

describe('AbandonedCartsService checkout recovery', () => {
  const upsert = jest.fn().mockResolvedValue({});
  const makeService = () => new AbandonedCartsService({} as any, {} as any, {
    checkoutRecovery: { upsert },
  } as any);

  beforeEach(() => upsert.mockClear());

  it('ignora status de conversão enviado pelo navegador e sanitiza atribuição', async () => {
    const service = makeService();
    await service.captureCheckout({
      sessionId: 'session-12345678', name: 'Maria', phone: '(11) 98765-4321', status: 'converted',
      attribution: { utm_source: ' meta ', utm_campaign: 'verao', segredo: 'não guardar' },
      items: [{ productId: 'REF1', name: 'Vestido', quantity: 1, unitPrice: 199.9 }],
    }, '127.0.0.1');

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: 'active', telefone: '11987654321' }),
      update: expect.not.objectContaining({ status: expect.anything(), convertedAt: expect.anything() }),
    }));
    const data = upsert.mock.calls[0][0].create;
    expect(data.attribution).toEqual({ utm_source: 'meta', utm_campaign: 'verao' });
  });

  it('limita rajadas do mesmo contato', async () => {
    const service = makeService();
    const body = { sessionId: 'session-abcdefgh', name: 'Ana', phone: '11987654321', items: [] };
    for (let i = 0; i < 10; i++) await service.captureCheckout(body, '10.0.0.1');
    await expect(service.captureCheckout(body, '10.0.0.1')).rejects.toBeInstanceOf(HttpException);
  });
});
