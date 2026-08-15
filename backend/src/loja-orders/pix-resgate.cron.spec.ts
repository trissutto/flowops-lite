import { PixResgateCron } from './pix-resgate.cron';

describe('PixResgateCron', () => {
  it('envia lembrete somente para pedido com consentimento explícito', async () => {
    const consentido = {
      id: 'com-opt-in', status: 'awaiting_payment', paidAt: null,
      trackingInfo: JSON.stringify({ recovery_consent: true }), items: [],
    };
    const semConsentimento = {
      id: 'sem-opt-in', status: 'awaiting_payment', paidAt: null,
      trackingInfo: JSON.stringify({ recovery_consent: false }), items: [],
    };
    const findMany = jest.fn().mockResolvedValue([semConsentimento, consentido]);
    const findUnique = jest.fn().mockResolvedValue({ paidAt: null, status: 'awaiting_payment' });
    const update = jest.fn().mockResolvedValue({});
    const aoPixNaoPago = jest.fn().mockResolvedValue(true);
    const cron = new PixResgateCron(
      { order: { findMany, findUnique, update } } as any,
      { get: jest.fn().mockReturnValue(undefined) } as any,
      { aoPixNaoPago } as any,
    );

    await cron.ciclo();

    expect(aoPixNaoPago).toHaveBeenCalledTimes(1);
    expect(aoPixNaoPago).toHaveBeenCalledWith(consentido);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'com-opt-in' } }));
  });

  it('ignora tracking ausente ou inválido', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'antigo', trackingInfo: null },
      { id: 'quebrado', trackingInfo: '{' },
    ]);
    const aoPixNaoPago = jest.fn();
    const cron = new PixResgateCron(
      { order: { findMany } } as any,
      { get: jest.fn().mockReturnValue(undefined) } as any,
      { aoPixNaoPago } as any,
    );

    await cron.ciclo();

    expect(aoPixNaoPago).not.toHaveBeenCalled();
  });
});
