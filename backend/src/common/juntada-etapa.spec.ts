import { caixaDesviadaPara, etapaDoFeeder } from './juntada-etapa';

describe('etapaDoFeeder — sem caixa, o sinal é o card da outra loja', () => {
  it('problema reportado ganha de qualquer status', () => {
    expect(etapaDoFeeder(null, { status: 'separating', issueReason: 'out_of_stock' })).toBe('problema');
  });
  it('card fechado sem caixa = já saiu da loja de origem', () => {
    expect(etapaDoFeeder(null, { status: 'shipped' })).toBe('a_caminho');
  });
  it('separado/pronto = separada, ainda na origem', () => {
    expect(etapaDoFeeder(null, { status: 'separated' })).toBe('pronta');
    expect(etapaDoFeeder(undefined, { status: 'ready' })).toBe('pronta');
  });
  it('new/separating = ainda separando', () => {
    expect(etapaDoFeeder(null, { status: 'new' })).toBe('separando');
    expect(etapaDoFeeder(null, { status: 'separating' })).toBe('separando');
  });
});

describe('etapaDoFeeder — com caixa, a caixa manda', () => {
  it('received = chegou', () => {
    expect(etapaDoFeeder({ status: 'received' }, { status: 'shipped' })).toBe('chegou');
  });
  it('in_transit/open = a caminho, mesmo com o card já fechado', () => {
    expect(etapaDoFeeder({ status: 'in_transit' }, { status: 'shipped' })).toBe('a_caminho');
    expect(etapaDoFeeder({ status: 'open' }, { status: 'separated' })).toBe('a_caminho');
  });
  it('a caixa que foi pra OUTRA loja conta do mesmo jeito que a porta (received = chegou)', () => {
    // LP-001508: caixa de Itanhaém endereçada à 04, âncora trocada pra 18.
    expect(etapaDoFeeder({ status: 'received', toStoreCode: '04' }, { status: 'shipped' })).toBe('chegou');
  });
});

describe('caixaDesviadaPara — caixa endereçada a outra loja', () => {
  it('caixa vindo pra mim não é desvio', () => {
    expect(caixaDesviadaPara({ status: 'received', toStoreCode: '18', toStoreName: 'Anália Franco' }, '18')).toBeNull();
  });
  it('LP-001508: caixa 01→04 recebida, eu sou a 18 → desviada pra INDAIATUBA', () => {
    expect(
      caixaDesviadaPara({ status: 'received', toStoreCode: '04', toStoreName: 'INDAIATUBA' }, '18'),
    ).toBe('INDAIATUBA');
  });
  it('sem nome da loja, devolve o código', () => {
    expect(caixaDesviadaPara({ status: 'in_transit', toStoreCode: '04' }, '18')).toBe('04');
  });
  it('sem caixa, sem destino ou sem saber quem sou → null', () => {
    expect(caixaDesviadaPara(null, '18')).toBeNull();
    expect(caixaDesviadaPara({ status: 'received', toStoreCode: '' }, '18')).toBeNull();
    expect(caixaDesviadaPara({ status: 'received', toStoreCode: '04' }, null)).toBeNull();
    expect(caixaDesviadaPara({ status: 'received', toStoreCode: '04' }, '')).toBeNull();
  });
  it('espaço em volta do código não vira desvio falso', () => {
    expect(caixaDesviadaPara({ status: 'received', toStoreCode: ' 18 ' }, '18')).toBeNull();
  });
});
