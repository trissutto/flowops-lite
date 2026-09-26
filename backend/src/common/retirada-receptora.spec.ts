import {
  ehCardReceptor,
  faltaCardReceptor,
  fechaComoEntregue,
  statusDoReceptor,
} from './retirada-receptora';

// O caso-mãe: LP-001652 (26/09/2026). Retirada na 06 SOROCABA, peça única na
// 18 ANÁLIA FRANCO. Só existia o card de transferência da 18.
const retiradaSorocaba = { isPickup: true, pickupStoreCode: '06', shippingMethod: 'Retirada em loja' };
const feederAnalia = { id: 'card-18', status: 'separated', isTransfer: true, transferToStoreCode: '06', storeCode: '18', storeName: 'Anália Franco' };

describe('faltaCardReceptor — quando a loja de retirada precisa de card', () => {
  it('retirada com só o card de transferência apontando pra ela: falta (LP-001652)', () => {
    expect(faltaCardReceptor(retiradaSorocaba, [feederAnalia])).toBe('06');
  });

  it('a loja de retirada já tem card próprio (retirada composta): não falta', () => {
    const proprio = { id: 'card-06', status: 'new', isTransfer: false, storeCode: '06' };
    expect(faltaCardReceptor(retiradaSorocaba, [feederAnalia, proprio])).toBeNull();
  });

  it('receptor que já existe em separated/shipped também conta como próprio', () => {
    for (const status of ['separated', 'ready', 'shipped']) {
      const proprio = { id: 'card-06', status, isTransfer: false, storeCode: '06' };
      expect(faltaCardReceptor(retiradaSorocaba, [feederAnalia, proprio])).toBeNull();
    }
  });

  it('card cancelado não conta — nem como feeder nem como próprio', () => {
    const cancelado = { ...feederAnalia, status: 'cancelled' };
    expect(faltaCardReceptor(retiradaSorocaba, [cancelado])).toBeNull();
    const proprioMorto = { id: 'card-06', status: 'cancelled', isTransfer: false, storeCode: '06' };
    expect(faltaCardReceptor(retiradaSorocaba, [feederAnalia, proprioMorto])).toBe('06');
  });

  it('sem alimentador (a própria loja de retirada separa tudo) não falta nada', () => {
    const lock = { id: 'card-06', status: 'new', isTransfer: false, storeCode: '06' };
    expect(faltaCardReceptor(retiradaSorocaba, [lock])).toBeNull();
    expect(faltaCardReceptor(retiradaSorocaba, [])).toBeNull();
  });

  it('SEDEX/PAC não tem destino obrigatório: feeder de juntada não vira receptor', () => {
    const sedex = { isPickup: false, pickupStoreCode: null, shippingMethod: 'SEDEX' };
    const feeder = { ...feederAnalia, transferToStoreCode: '04' };
    expect(faltaCardReceptor(sedex, [feeder])).toBeNull();
  });

  it('motoboy com loja escolhida segue a mesma régua da retirada', () => {
    const moto = { isPickup: false, pickupStoreCode: '10', shippingMethod: 'Entrega por MOTOBOY' };
    const feeder = { ...feederAnalia, transferToStoreCode: '10' };
    expect(faltaCardReceptor(moto, [feeder])).toBe('10');
  });
});

describe('statusDoReceptor — nasce aguardando ou com a peça já aqui', () => {
  const feeders = [{ id: 'card-18' }];

  it('sem caixa nenhuma (origem ainda separando): new', () => {
    expect(statusDoReceptor(feeders, [])).toBe('new');
  });

  it('caixa em trânsito: new', () => {
    expect(statusDoReceptor(feeders, [{ pickOrderId: 'card-18', status: 'in_transit' }])).toBe('new');
  });

  it('caixa recebida: separated (a peça está na loja, falta a cliente)', () => {
    expect(statusDoReceptor(feeders, [{ pickOrderId: 'card-18', status: 'received' }])).toBe('separated');
  });

  it('dois alimentadores, só um chegou: new', () => {
    const dois = [{ id: 'card-18' }, { id: 'card-01' }];
    const caixas = [
      { pickOrderId: 'card-18', status: 'received' },
      { pickOrderId: 'card-01', status: 'in_transit' },
    ];
    expect(statusDoReceptor(dois, caixas)).toBe('new');
  });

  it('caixa cancelada não conta como chegada', () => {
    expect(statusDoReceptor(feeders, [{ pickOrderId: 'card-18', status: 'cancelled' }])).toBe('new');
  });

  it('sem alimentador não há o que esperar — mas também não é "chegou"', () => {
    expect(statusDoReceptor([], [])).toBe('new');
  });
});

describe('ehCardReceptor — card próprio da loja de destino sem peça própria', () => {
  it('card da 06 sem itens num pedido de retirada na 06: receptor', () => {
    expect(ehCardReceptor({ isTransfer: false, storeCode: '06' }, retiradaSorocaba, false)).toBe(true);
  });

  it('card da 06 COM peça própria é card comum (retirada composta)', () => {
    expect(ehCardReceptor({ isTransfer: false, storeCode: '06' }, retiradaSorocaba, true)).toBe(false);
  });

  it('card de transferência nunca é receptor', () => {
    expect(ehCardReceptor({ isTransfer: true, storeCode: '18' }, retiradaSorocaba, false)).toBe(false);
  });

  it('card vazio numa loja que NÃO é a de retirada não é receptor (é órfão)', () => {
    expect(ehCardReceptor({ isTransfer: false, storeCode: '18' }, retiradaSorocaba, false)).toBe(false);
  });

  it('pedido SEDEX nunca tem receptor', () => {
    expect(ehCardReceptor({ isTransfer: false, storeCode: '06' }, { isPickup: false }, false)).toBe(false);
  });
});

describe('fechaComoEntregue — quem entrega fecha, quem transfere não', () => {
  const pickup = { isPickup: true };

  it('"📦 Enviei pra loja X" (card de transferência, carrier Retirada) NÃO entrega — o bug do LP-001652', () => {
    expect(fechaComoEntregue({ isTransfer: true }, pickup, 'Retirada')).toBe(false);
  });

  it('"🏬 Cliente retirou" no card próprio da loja de retirada entrega', () => {
    expect(fechaComoEntregue({ isTransfer: false }, pickup, 'Retirada')).toBe(true);
    expect(fechaComoEntregue({ isTransfer: false }, pickup, 'retirada em loja')).toBe(true);
  });

  it('pedido que não é retirada nunca fecha por aqui', () => {
    expect(fechaComoEntregue({ isTransfer: false }, { isPickup: false }, 'Retirada')).toBe(false);
    expect(fechaComoEntregue({ isTransfer: false }, null, 'Retirada')).toBe(false);
  });

  it('motoboy e Correios não são retirada', () => {
    expect(fechaComoEntregue({ isTransfer: false }, pickup, 'Motoboy')).toBe(false);
    expect(fechaComoEntregue({ isTransfer: false }, pickup, 'Correios')).toBe(false);
    expect(fechaComoEntregue({ isTransfer: false }, pickup, '')).toBe(false);
    expect(fechaComoEntregue({ isTransfer: false }, pickup, null)).toBe(false);
  });
});
