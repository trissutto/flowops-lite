import { destinoObrigatorioDoPedido, transferenciaParaDestino } from './destino-obrigatorio';

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
