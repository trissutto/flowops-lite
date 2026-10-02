import { ratearTotalDaVenda } from './ratear-total-da-venda';

const soma = (xs: Array<number | null>) =>
  Math.round(xs.reduce<number>((s, v) => s + (v ?? 0), 0) * 100) / 100;

describe('ratearTotalDaVenda', () => {
  it('sem desconto na venda devolve os itens como vieram', () => {
    const itens = [89.9, 59.9];
    expect(ratearTotalDaVenda(itens, 149.8)).toBe(itens);
  });

  it('rateia o desconto da venda inteira e a soma fecha com o total', () => {
    const r = ratearTotalDaVenda([100, 50, 50], 180);
    expect(r).toEqual([90, 45, 45]);
    expect(soma(r)).toBe(180);
  });

  it('a sobra do arredondamento cai na linha de maior valor', () => {
    // R$ 10,00 de desconto em 3 peças iguais: 3,33 + 3,33 + 3,34
    const r = ratearTotalDaVenda([33.33, 33.33, 33.34], 90);
    expect(soma(r)).toBe(90);
    expect(r).toEqual([30, 30, 30]);
  });

  it('centavo quebrado nunca vaza: a soma é exatamente o total', () => {
    const r = ratearTotalDaVenda([79.9, 129.9, 39.95, 219.9], 446.17);
    expect(soma(r)).toBe(446.17);
    // nenhuma linha com fração de centavo
    for (const v of r) expect(Number((v as number).toFixed(2))).toBe(v);
  });

  it('item negativo (ajuste/troca dentro da venda) não recebe rateio', () => {
    // 200 − 39,90 de ajuste = 160,10; desconto extra de 10 → total 150,10
    const r = ratearTotalDaVenda([120, 80, -39.9], 150.1);
    expect(r[2]).toBe(-39.9);
    expect(soma(r)).toBe(150.1);
    expect(r).toEqual([114, 76, -39.9]);
  });

  it('MARCADO (total nulo) não é rateado', () => {
    const itens = [150, 80];
    expect(ratearTotalDaVenda(itens, null)).toBe(itens);
    expect(ratearTotalDaVenda(itens, NaN)).toBe(itens);
  });

  it('total MAIOR que a soma dos itens não inventa receita na peça', () => {
    const itens = [100, 50];
    expect(ratearTotalDaVenda(itens, 170)).toBe(itens);
  });

  it('desconto maior que as peças positivas não mexe em nada', () => {
    const itens = [10, -5];
    expect(ratearTotalDaVenda(itens, -8)).toBe(itens);
  });

  it('item sem valor continua nulo e fora da conta', () => {
    const r = ratearTotalDaVenda([100, null, 100], 150);
    expect(r).toEqual([75, null, 75]);
  });

  it('desconto de 100% zera as peças', () => {
    const r = ratearTotalDaVenda([60, 40], 0);
    expect(r).toEqual([0, 0]);
  });
});
