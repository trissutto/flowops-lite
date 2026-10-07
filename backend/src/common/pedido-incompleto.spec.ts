import { mensagemPedidoIncompleto, pecasSemLoja, travaPedidoIncompletoLigada } from './pedido-incompleto';

describe('pedido-incompleto', () => {
  // O ON-000600 como estava às 15:46 de 05/10: 1 peça em São José, 2 sem loja.
  const on600 = [
    { sku: '8000000030313', ref: '13131', cor: 'OFF WHITE', tamanho: '50', quantity: 1, assignedStoreId: 'sjc', cancelledAt: null },
    { sku: '8000000030344', ref: '13131', cor: 'PRETO', tamanho: '48', quantity: 1, assignedStoreId: null, cancelledAt: null },
    { sku: '8000000030276', ref: '131008', cor: 'AZUL', tamanho: '50', quantity: 1, assignedStoreId: null, cancelledAt: null },
  ];

  it('ON-000600: acha as 2 peças sem loja', () => {
    expect(pecasSemLoja(on600).map((l) => l.sku)).toEqual(['8000000030344', '8000000030276']);
  });

  it('peça resolvida com crédito/reembolso (cancelada) não segura o envio', () => {
    const resolvido = on600.map((l) => (l.assignedStoreId ? l : { ...l, cancelledAt: new Date() }));
    expect(pecasSemLoja(resolvido)).toEqual([]);
  });

  it('frete e linha manual não são peça', () => {
    expect(
      pecasSemLoja([
        { sku: 'FRETE', ref: 'FRETE', assignedStoreId: null, cancelledAt: null },
        { sku: 'MANUAL-123', ref: 'MANUAL', assignedStoreId: null, cancelledAt: null },
      ]),
    ).toEqual([]);
  });

  it('mensagem diz o que falta e o que fazer', () => {
    const msg = mensagemPedidoIncompleto(pecasSemLoja(on600));
    expect(msg).toMatch(/PEDIDO INCOMPLETO/);
    expect(msg).toMatch(/13131 PRETO 48 · 131008 AZUL 50/);
  });

  it('kill-switch', () => {
    expect(travaPedidoIncompletoLigada()).toBe(true);
    process.env.ENVIO_EXIGE_PEDIDO_COMPLETO = '0';
    expect(travaPedidoIncompletoLigada()).toBe(false);
    delete process.env.ENVIO_EXIGE_PEDIDO_COMPLETO;
  });
});
