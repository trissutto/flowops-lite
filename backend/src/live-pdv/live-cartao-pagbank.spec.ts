import { BadRequestException, HttpException } from '@nestjs/common';
import { LivePdvService } from './live-pdv.service';
import { ORIGEM_LIVE_CARTAO } from '../common/link-pagamento-pagbank';

/**
 * CARTÃO DA LIVE PELO PAGBANK (22/09/2026) — a orquestração do dinheiro.
 *
 * O botão "Cartão até 12x" da página da live gerava um link do checkout da
 * Pagar.me, que a conta desligou em 21/09. Agora o cartão é cobrado na própria
 * página. Estes testes cobrem o que é silencioso na operação quando erra:
 * cobrar duas vezes, fechar o carrinho sem dinheiro, ou deixar o carrinho
 * preso esperando um cartão que o banco já recusou.
 */

const CARTAO_OK = {
  cardEncrypted: 'x'.repeat(120),
  holderName: 'MARIA SOUZA',
  holderCpf: '52998224725',
  installments: 3,
};

function montar(opts: {
  cart?: any;
  cobrancas?: Array<{ method: string; status: string }>;
  cobranca?: any;
  pendentes?: number;
  pago?: any;
}) {
  const cart = {
    id: 'cart-1',
    sessionId: 'sess-1',
    status: 'open',
    totalCents: 25990,
    customerName: 'Maria Souza',
    customerCpf: '52998224725',
    customerPhone: '13991234567',
    customerEmail: 'maria@exemplo.com',
    customerInstagram: 'maria',
    customerCep: '11010000',
    customerEndereco: 'Rua A',
    customerNumero: '10',
    customerCidade: 'Santos',
    customerUf: 'SP',
    isPickup: false,
    paymentMethod: null,
    pagarmeOrderId: null,
    ...(opts.cart || {}),
  };
  const prisma: any = {
    livePdvCart: {
      findUnique: jest.fn().mockResolvedValue(cart),
      update: jest.fn().mockResolvedValue(cart),
    },
    livePdvItem: { findMany: jest.fn().mockResolvedValue([{ id: 'it-1' }]) },
    pagbankPayment: {
      findMany: jest.fn().mockResolvedValue(opts.cobrancas ?? []),
      findFirst: jest.fn().mockResolvedValue(opts.pago ?? null),
      count: jest.fn().mockResolvedValue(opts.pendentes ?? 0),
    },
  };
  const pagbank: any = {
    createCardCharge: jest.fn().mockResolvedValue(
      opts.cobranca ?? { ok: true, status: 'paid', pagbankOrderId: 'ORDE_1', pagbankChargeId: 'CHAR_1', lido: {} },
    ),
    chavePublicaCartao: jest.fn().mockResolvedValue({ publicKey: 'PUB' }),
    checkOrderStatus: jest.fn().mockResolvedValue({ isPaid: false }),
  };
  const nada = {} as any;
  const svc = new LivePdvService(
    prisma, nada, nada, nada, nada, pagbank, nada, nada, nada, nada, nada, nada, nada, nada,
  );
  jest.spyOn(svc, 'getSession').mockResolvedValue({ id: 'sess-1', liveStoreCode: '05', liveStoreName: 'Sorocaba' } as any);
  jest.spyOn(svc as any, 'recalcCart').mockResolvedValue(undefined);
  const onCartPaid = jest.spyOn(svc, 'onCartPaid').mockResolvedValue({} as any);
  return { svc, prisma, pagbank, onCartPaid };
}

describe('cartão da live pelo PagBank', () => {
  it('APROVADO: cobra o total do carrinho na conta da loja da live e fecha na hora', async () => {
    const { svc, prisma, pagbank, onCartPaid } = montar({});
    const r = await svc.pagarCartao('cart-1', CARTAO_OK);
    expect(r.resultado).toBe('pago');
    expect(pagbank.createCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        saleId: 'cart-1',
        storeCode: '05',
        valor: 259.9,
        installments: 3,
        origem: ORIGEM_LIVE_CARTAO,
        customer: expect.objectContaining({ cpf: '52998224725', phone: '13991234567', email: 'maria@exemplo.com' }),
        shippingAddress: expect.objectContaining({ city: 'Santos', uf: 'SP', cep: '11010000' }),
      }),
    );
    expect(prisma.livePdvCart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentMethod: 'cartao', pagarmeOrderId: 'ORDE_1' }) }),
    );
    expect(onCartPaid).toHaveBeenCalledWith('cart-1');
  });

  it('retirada em loja não manda endereço de entrega', async () => {
    const { svc, pagbank } = montar({ cart: { isPickup: true } });
    await svc.pagarCartao('cart-1', CARTAO_OK);
    expect(pagbank.createCardCharge).toHaveBeenCalledWith(expect.objectContaining({ shippingAddress: null }));
  });

  it('EM ANÁLISE: carrinho espera o banco (72h) e NÃO fecha', async () => {
    const { svc, prisma, onCartPaid } = montar({
      cobranca: { ok: true, status: 'pending', pagbankOrderId: 'ORDE_2', pagbankChargeId: null, lido: {} },
    });
    const antes = Date.now();
    const r = await svc.pagarCartao('cart-1', CARTAO_OK);
    expect(r.resultado).toBe('analise');
    expect(onCartPaid).not.toHaveBeenCalled();
    const data = prisma.livePdvCart.update.mock.calls[0][0].data;
    expect(data).toEqual(expect.objectContaining({ status: 'awaiting_payment', paymentMethod: 'cartao', pagarmeOrderId: 'ORDE_2' }));
    expect(data.paymentExpiresAt.getTime()).toBeGreaterThanOrEqual(antes + 71 * 3600_000);
  });

  it('RECUSADO: não fecha, não marca o carrinho e gasta a tentativa', async () => {
    const { svc, prisma, onCartPaid } = montar({
      cobrancas: [{ method: 'credit_card', status: 'cancelled' }],
      cobranca: { ok: false, kind: 'recusa', detalhe: 'insufficient funds', pagbankOrderId: 'ORDE_3' },
    });
    const r = await svc.pagarCartao('cart-1', CARTAO_OK);
    expect(r.resultado).toBe('recusado');
    expect(r.mensagem).toMatch(/limite/);
    expect(r.tentativasRestantes).toBe(2); // teto 4: uma antes + esta
    expect(onCartPaid).not.toHaveBeenCalled();
    expect(prisma.livePdvCart.update).not.toHaveBeenCalled();
  });

  it('cartão EM ANÁLISE segura a segunda tentativa — senão cobra duas vezes', async () => {
    const { svc, pagbank } = montar({ cobrancas: [{ method: 'credit_card', status: 'pending' }] });
    await expect(svc.pagarCartao('cart-1', CARTAO_OK)).rejects.toBeInstanceOf(BadRequestException);
    expect(pagbank.createCardCharge).not.toHaveBeenCalled();
  });

  it('teto de tentativas por compra', async () => {
    const recusas = Array.from({ length: 4 }, () => ({ method: 'credit_card', status: 'cancelled' }));
    const { svc, pagbank } = montar({ cobrancas: recusas });
    await expect(svc.pagarCartao('cart-1', CARTAO_OK)).rejects.toBeInstanceOf(HttpException);
    expect(pagbank.createCardCharge).not.toHaveBeenCalled();
  });

  it('PIX já pago: fecha o carrinho sem cobrar o cartão', async () => {
    const { svc, pagbank, onCartPaid } = montar({ cobrancas: [{ method: 'pix', status: 'paid' }] });
    const r = await svc.pagarCartao('cart-1', CARTAO_OK);
    expect(r.resultado).toBe('pago');
    expect(pagbank.createCardCharge).not.toHaveBeenCalled();
    expect(onCartPaid).toHaveBeenCalledWith('cart-1');
  });

  it('carrinho já pago não cobra de novo', async () => {
    const { svc, pagbank } = montar({ cart: { status: 'paid' } });
    const r = await svc.pagarCartao('cart-1', CARTAO_OK);
    expect(r.resultado).toBe('pago');
    expect(pagbank.createCardCharge).not.toHaveBeenCalled();
  });

  it('sem e-mail no carrinho exige o digitado — e grava no carrinho quando aprova', async () => {
    const { svc, prisma, pagbank } = montar({ cart: { customerEmail: null } });
    await expect(svc.pagarCartao('cart-1', CARTAO_OK)).rejects.toBeInstanceOf(BadRequestException);
    expect(pagbank.createCardCharge).not.toHaveBeenCalled();

    const r = await svc.pagarCartao('cart-1', { ...CARTAO_OK, email: 'maria@exemplo.com' });
    expect(r.resultado).toBe('pago');
    expect(prisma.livePdvCart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ customerEmail: 'maria@exemplo.com' }) }),
    );
  });

  it('CPF do titular inválido nem chega ao PagBank', async () => {
    const { svc, pagbank } = montar({});
    await expect(svc.pagarCartao('cart-1', { ...CARTAO_OK, holderCpf: '11111111111' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(pagbank.createCardCharge).not.toHaveBeenCalled();
  });

  describe('checkPayment do carrinho no cartão', () => {
    it('banco aprovou depois da análise → fecha', async () => {
      const { svc, onCartPaid } = montar({
        cart: { status: 'awaiting_payment', paymentMethod: 'cartao', pagarmeOrderId: 'ORDE_2' },
        pago: { pagbankOrderId: 'ORDE_2' },
      });
      const r = await svc.checkPayment('cart-1');
      expect(r.paid).toBe(true);
      expect(onCartPaid).toHaveBeenCalledWith('cart-1');
    });

    it('banco RECUSOU depois da análise → a compra volta a ficar em aberto (itens intactos)', async () => {
      const { svc, prisma, onCartPaid } = montar({
        cart: { status: 'awaiting_payment', paymentMethod: 'cartao', pagarmeOrderId: 'ORDE_2' },
        pago: null,
        pendentes: 0,
      });
      const r = await svc.checkPayment('cart-1');
      expect(r.paid).toBe(false);
      expect(onCartPaid).not.toHaveBeenCalled();
      expect(prisma.livePdvCart.update).toHaveBeenCalledWith({
        where: { id: 'cart-1' },
        data: { status: 'open', paymentExpiresAt: null },
      });
    });

    it('ainda em análise → continua esperando, sem reabrir', async () => {
      const { svc, prisma } = montar({
        cart: { status: 'awaiting_payment', paymentMethod: 'cartao', pagarmeOrderId: 'ORDE_2' },
        pago: null,
        pendentes: 1,
      });
      const r = await svc.checkPayment('cart-1');
      expect(r.paid).toBe(false);
      expect(prisma.livePdvCart.update).not.toHaveBeenCalled();
    });
  });

  it('onCartPaid: quem PERDE a corrida (cron + cartão juntos) não libera a separação de novo', async () => {
    const { svc, prisma, onCartPaid } = montar({});
    onCartPaid.mockRestore();
    prisma.livePdvCart.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    prisma.livePdvItem.updateMany = jest.fn();
    const getCart = jest.spyOn(svc, 'getCart').mockResolvedValue({ id: 'cart-1', status: 'paid' } as any);
    const release = jest.spyOn(svc, 'releaseSeparation').mockResolvedValue({} as any);
    await svc.onCartPaid('cart-1');
    expect(prisma.livePdvCart.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'cart-1', status: { notIn: LivePdvService.PAID_STATES } }) }),
    );
    expect(prisma.livePdvItem.updateMany).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(getCart).toHaveBeenCalledWith('cart-1');
  });

  it('PIX não nasce com cartão em análise na mesma compra', async () => {
    const { svc } = montar({ pendentes: 1 });
    await expect(svc.startPayment('cart-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
