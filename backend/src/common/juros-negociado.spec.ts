import {
  aplicarDescontoJuros,
  normalizarPctDesconto,
  pctParaJurosAlvo,
  rotuloDesconto,
} from './juros-negociado';

/**
 * A redução de juros que a loja negocia no balcão (17/09/2026).
 *
 * O que não pode escapar: o desconto mexe SÓ no juros, a conta fecha centavo
 * a centavo com o que cada parcela leva pro histórico, e "digitar o valor
 * final" não vira desconto maior do que a pessoa quis.
 */
describe('juros negociado', () => {
  // Os três juros da OZELINA na tela do dono (parcelas de 322 dias).
  const ozelina = [158.46, 151.11, 324.26];

  it('50% tira metade do juros e não encosta no principal', () => {
    const r = aplicarDescontoJuros(ozelina, 50);
    expect(r.jurosCobrado).toEqual([79.23, 75.56, 162.13]);
    expect(r.totalCheio).toBe(633.83);
    expect(r.totalCobrado).toBe(316.92);
    expect(r.desconto).toBe(316.91);
  });

  it('a soma das parcelas é EXATAMENTE o total cobrado (recibo × histórico)', () => {
    const r = aplicarDescontoJuros(ozelina, 37.5);
    const soma = Math.round(r.jurosCobrado.reduce((s, j) => s + j, 0) * 100) / 100;
    expect(soma).toBe(r.totalCobrado);
    expect(Math.round((r.totalCobrado + r.desconto) * 100) / 100).toBe(r.totalCheio);
  });

  it('100% perdoa o JUROS, não a dívida', () => {
    const r = aplicarDescontoJuros(ozelina, 100);
    expect(r.jurosCobrado).toEqual([0, 0, 0]);
    expect(r.totalCobrado).toBe(0);
    expect(r.desconto).toBe(633.83);
  });

  it('sem desconto, nada muda', () => {
    const r = aplicarDescontoJuros(ozelina, 0);
    expect(r.jurosCobrado).toEqual(ozelina);
    expect(r.desconto).toBe(0);
    expect(rotuloDesconto(r)).toBe('');
  });

  it('parcela em dia (juros 0) continua em zero — desconto não inventa crédito', () => {
    const r = aplicarDescontoJuros([0, 100], 40);
    expect(r.jurosCobrado).toEqual([0, 60]);
  });

  it('lixo no campo (texto, negativo, acima de 100) não vira desconto maluco', () => {
    expect(normalizarPctDesconto('abc')).toBe(0);
    expect(normalizarPctDesconto(-10)).toBe(0);
    expect(normalizarPctDesconto(150)).toBe(100);
    expect(normalizarPctDesconto('12,5')).toBe(12.5);
    expect(aplicarDescontoJuros(ozelina, 'abc').totalCobrado).toBe(633.83);
  });

  it('digitar o valor final acha o % (e o valor exato sai da conta por parcela)', () => {
    const pct = pctParaJurosAlvo(ozelina, 300);
    const r = aplicarDescontoJuros(ozelina, pct);
    expect(Math.abs(r.totalCobrado - 300)).toBeLessThanOrEqual(0.05);
    expect(r.totalCobrado).toBeLessThanOrEqual(633.83);
  });

  it('valor final MAIOR que o juros não vira desconto negativo (cobrança a mais)', () => {
    expect(pctParaJurosAlvo(ozelina, 900)).toBe(0);
    expect(aplicarDescontoJuros(ozelina, pctParaJurosAlvo(ozelina, 900)).totalCobrado).toBe(633.83);
  });

  it('sem juros nenhum, não há o que negociar', () => {
    expect(pctParaJurosAlvo([0, 0], 50)).toBe(0);
    expect(aplicarDescontoJuros([0, 0], 80).totalCheio).toBe(0);
  });

  it('a frase do recibo diz o tamanho da mão que a loja abriu', () => {
    expect(rotuloDesconto(aplicarDescontoJuros(ozelina, 50))).toContain('50% de desconto no juros');
    expect(rotuloDesconto(aplicarDescontoJuros(ozelina, 100))).toContain('perdoado');
  });
});
