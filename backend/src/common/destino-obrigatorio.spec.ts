import { destinoObrigatorioDoPedido, feederOrfao, transferenciaParaDestino } from './destino-obrigatorio';

/**
 * Trava o comportamento que faltava no LP-001224 (06/09/2026): retirada em
 * Moema montada na mão, cards nascidos sem `isTransfer`, peça sem trilho
 * nenhum pra chegar na loja onde a cliente ia buscar.
 */
describe('destinoObrigatorioDoPedido', () => {
  it('retirada em loja tem destino obrigatório', () => {
    expect(
      destinoObrigatorioDoPedido({ isPickup: true, pickupStoreCode: '15', shippingMethod: 'Retirada em loja (Moema)' }),
    ).toBe('15');
  });

  it('motoboy com loja escolhida também tem', () => {
    expect(
      destinoObrigatorioDoPedido({ isPickup: false, pickupStoreCode: '01', shippingMethod: 'Entrega por Motoboy' }),
    ).toBe('01');
  });

  it('SEDEX/PAC não tem destino obrigatório — a peça viaja pra cliente', () => {
    expect(
      destinoObrigatorioDoPedido({ isPickup: false, pickupStoreCode: null, shippingMethod: 'SEDEX' }),
    ).toBeNull();
  });

  it('sem loja escolhida não inventa destino', () => {
    expect(destinoObrigatorioDoPedido({ isPickup: true, pickupStoreCode: '', shippingMethod: 'Retirada' })).toBeNull();
    expect(destinoObrigatorioDoPedido({ isPickup: true, pickupStoreCode: null })).toBeNull();
  });

  it('pickupStoreCode sozinho, sem retirada nem motoboy, não vira destino', () => {
    // Pedido de SEDEX que carrega pickupStoreCode por outro motivo não pode
    // virar transferência — a peça tem que sair pra cliente.
    expect(
      destinoObrigatorioDoPedido({ isPickup: false, pickupStoreCode: '15', shippingMethod: 'PAC' }),
    ).toBeNull();
  });
});

describe('transferenciaParaDestino', () => {
  const retiradaMoema = { isPickup: true, pickupStoreCode: '15', shippingMethod: 'Retirada em loja (Moema)' };

  it('loja que NÃO é o destino vira alimentadora (o caso LP-001224)', () => {
    expect(transferenciaParaDestino(retiradaMoema, '06')).toEqual({
      isTransfer: true,
      transferToStoreCode: '15',
    });
    expect(transferenciaParaDestino(retiradaMoema, '08')).toEqual({
      isTransfer: true,
      transferToStoreCode: '15',
    });
  });

  it('a própria loja da retirada separa sem transferência', () => {
    expect(transferenciaParaDestino(retiradaMoema, '15')).toEqual({
      isTransfer: false,
      transferToStoreCode: null,
    });
  });

  it('pedido de envio normal nunca vira transferência', () => {
    expect(transferenciaParaDestino({ isPickup: false, shippingMethod: 'SEDEX' }, '06')).toEqual({
      isTransfer: false,
      transferToStoreCode: null,
    });
  });
});

describe('feederOrfao', () => {
  // 950001490 (17/09/2026): retirada em São José (08), Itanhaém alimenta a
  // 08. A 08 não separa nada — sem card nela NÃO é órfão.
  const retirada = { isPickup: true, pickupStoreCode: '08', shippingMethod: 'Retirada em loja' };
  const sedex = { isPickup: false, pickupStoreCode: null, shippingMethod: 'SEDEX' };

  it('retirada: feeder pro destino obrigatório sem card lá é legítimo', () => {
    expect(feederOrfao(retirada, '08', false)).toBe(false);
  });

  it('retirada: feeder pra OUTRA loja sem card continua órfão', () => {
    expect(feederOrfao(retirada, '02', false)).toBe(true);
  });

  it('SEDEX (juntada): âncora sem card é órfão — LP-000244', () => {
    expect(feederOrfao(sedex, '08', false)).toBe(true);
  });

  it('âncora com card nunca é órfã, em qualquer pedido', () => {
    expect(feederOrfao(sedex, '08', true)).toBe(false);
    expect(feederOrfao(retirada, '02', true)).toBe(false);
  });

  it('card sem transferToStoreCode não é feeder', () => {
    expect(feederOrfao(sedex, null, false)).toBe(false);
    expect(feederOrfao(sedex, '', false)).toBe(false);
  });
});
