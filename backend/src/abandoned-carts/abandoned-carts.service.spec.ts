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
      create: expect.objectContaining({ status: 'active', telefone: '11987654321', recoveryConsent: false }),
      update: expect.not.objectContaining({ status: expect.anything(), convertedAt: expect.anything() }),
    }));
    const data = upsert.mock.calls[0][0].create;
    expect(data.attribution).toEqual({ utm_source: 'meta', utm_campaign: 'verao' });
  });

  it('persiste somente consentimento explícito para recuperação', async () => {
    const service = makeService();
    await service.captureCheckout({
      sessionId: 'session-consentida', name: 'Bia', phone: '11999998888',
      recoveryConsent: true, items: [],
    }, '127.0.0.2');

    expect(upsert.mock.calls[0][0].create.recoveryConsent).toBe(true);
  });

  it('limita rajadas do mesmo contato', async () => {
    const service = makeService();
    const body = { sessionId: 'session-abcdefgh', name: 'Ana', phone: '11987654321', items: [] };
    for (let i = 0; i < 10; i++) await service.captureCheckout(body, '10.0.0.1');
    await expect(service.captureCheckout(body, '10.0.0.1')).rejects.toBeInstanceOf(HttpException);
  });
});

/**
 * O caso real (24/08/2026): HELEMAR VALIM levou 3 recusas de cartão e a 4ª
 * tentativa passou 23 segundos depois. Os 3 pedidos mortos apareciam como
 * "carrinho abandonado" com botão de WhatsApp — cobrando quem acabou de pagar.
 */
describe('AbandonedCartsService carrinhos do site novo', () => {
  const T = (min: number) => new Date(Date.UTC(2026, 7, 24, 11, min, 0));
  const pedido = (over: any) => ({
    wcOrderId: 950000000 + Math.round(Math.random() * 1000),
    customerName: 'Helemar Valim',
    customerEmail: 'helemarvalim@yahoo.com.br',
    customerPhone: '35991720547',
    totalAmount: 229.69,
    status: 'payment_failed',
    paidAt: null,
    createdAt: T(38),
    wcOrderNumber: 'LP-000195',
    items: [],
    ...over,
  });

  const makeService = (encontrados: any[], pagos: any[]) => {
    const findMany = jest.fn().mockImplementation((args: any) =>
      Promise.resolve(args?.where?.paidAt?.not === null ? pagos : encontrados),
    );
    return new AbandonedCartsService({} as any, {} as any, {
      order: { findMany },
      checkoutRecovery: { findMany: jest.fn().mockResolvedValue([]) },
    } as any);
  };

  it('esconde a tentativa recusada quando a mesma cliente fechou a venda na sequência', async () => {
    const recusados = [
      pedido({ wcOrderNumber: 'LP-000197', createdAt: T(39) }),
      pedido({ wcOrderNumber: 'LP-000196', createdAt: T(39) }),
      pedido({ wcOrderNumber: 'LP-000195', createdAt: T(38) }),
    ];
    const service = makeService(recusados, [
      { customerEmail: 'helemarvalim@yahoo.com.br', customerPhone: '35991720547', createdAt: T(39) },
    ]);

    const r: any = await service.listEcommercePending({ status: 'abandoned' });
    expect(r.items).toHaveLength(0);
    expect(r.stats.abandoned).toBe(0);
  });

  it('casa a venda pelo TELEFONE quando o e-mail do pedido pago é outro', async () => {
    const service = makeService([pedido({ customerEmail: 'digitou@errado.com' })], [
      { customerEmail: 'helemarvalim@yahoo.com.br', customerPhone: '(35) 99172-0547', createdAt: T(39) },
    ]);

    const r: any = await service.listEcommercePending({ status: 'abandoned' });
    expect(r.items).toHaveLength(0);
  });

  it('mantém o abandono de verdade e marca o status cru do pedido', async () => {
    const service = makeService([pedido({ wcOrderNumber: 'LP-000199' })], [
      { customerEmail: 'outra@cliente.com', customerPhone: '11988887777', createdAt: T(42) },
    ]);

    const r: any = await service.listEcommercePending({ status: 'abandoned' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].order_number).toBe('LP-000199');
    expect(r.items[0].pedido_status).toBe('payment_failed');
    expect(r.items[0].order_status).toBe('abandoned');
  });

  it('não esconde nada quando a venda da mesma cliente está fora da janela', async () => {
    const service = makeService([pedido({})], [
      {
        customerEmail: 'helemarvalim@yahoo.com.br',
        customerPhone: '35991720547',
        createdAt: new Date(Date.UTC(2026, 7, 26, 11, 38, 0)), // 2 dias depois
      },
    ]);

    const r: any = await service.listEcommercePending({ status: 'abandoned' });
    expect(r.items).toHaveLength(1);
  });
});
