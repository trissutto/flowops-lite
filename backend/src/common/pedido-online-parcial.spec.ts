import { rotuloDaLinha, selecionarPecasDoPedido } from './pedido-online-parcial';

const peca = (id: string, total: number, extra: Record<string, any> = {}) => ({
  id, sku: `800000000${id}`, ref: `R${id}`, cor: 'PRETO', tamanho: '48', descricao: `PEÇA ${id}`, qty: 1, total, precoUnit: total, ...extra,
});
const frete = (total: number) => ({ id: 'frete', sku: 'FRETE', ref: 'FRETE', descricao: 'FRETE', qty: 1, total, precoUnit: total });
const manual = (total: number) => ({ id: 'vp', sku: 'MANUAL-1700000000', ref: 'MANUAL', descricao: 'VALE PRESENTE', qty: 1, total, precoUnit: total });
const round2 = (v: number) => Math.round(v * 100) / 100;

describe('selecionarPecasDoPedido', () => {
  const itens = [peca('a', 100), peca('b', 100), peca('c', 50), frete(20)];
  const totalVenda = 270;

  it('sem itemIds = a venda inteira (o comportamento de sempre): só as peças, sem frete, total/desconto da venda', () => {
    const r = selecionarPecasDoPedido(itens, undefined, totalVenda);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parcial).toBe(false);
    expect(r.pecas.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(r.foraDoPedido).toEqual([]);
    expect(r.pecasNoPedido).toBe(3);
    expect(r.pecasDaVenda).toBe(3);
    expect(r.totalAmount).toBeNull();
    expect(r.discount).toBeNull();
  });

  it('itemIds vazio, só espaço ou repetido com todas as peças = inteira', () => {
    expect(selecionarPecasDoPedido(itens, [], totalVenda)).toMatchObject({ ok: true, parcial: false });
    expect(selecionarPecasDoPedido(itens, ['', '  ', null], totalVenda)).toMatchObject({ ok: true, parcial: false });
    expect(selecionarPecasDoPedido(itens, ['a', 'a', ' b', 'c'], totalVenda)).toMatchObject({ ok: true, parcial: false, pecasNoPedido: 3 });
  });

  it('id que não é desta venda = recusa inteira (nunca "gera o que deu")', () => {
    const r = selecionarPecasDoPedido(itens, ['a', 'zzz'], totalVenda);
    expect(r).toEqual({ ok: false, erro: 'Peça zzz não é desta venda' });
  });

  it('FRETE e linha MANUAL não são peça: escolher uma delas é recusa', () => {
    const r = selecionarPecasDoPedido(itens, ['frete'], totalVenda);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain('não é peça');
    expect(selecionarPecasDoPedido([...itens, manual(50)], ['a', 'vp'], 320)).toMatchObject({ ok: false });
  });

  it('parcial SEM desconto na venda: peças escolhidas + frete, desconto 0, o resto fica de fora', () => {
    const r = selecionarPecasDoPedido(itens, ['b', 'c'], 270);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.parcial).toBe(true);
    expect(r.pecas.map((p) => p.id)).toEqual(['b', 'c']);
    expect(r.foraDoPedido.map((p) => p.id)).toEqual(['a']);
    expect(r.pecasNoPedido).toBe(2);
    expect(r.pecasDaVenda).toBe(3);
    // 100 + 50 + frete 20
    expect(r.totalAmount).toBe(170);
    expect(r.discount).toBe(0);
  });

  it('parcial COM desconto da venda: cada linha leva a sua parte (rateio do espelho), e o total fecha em centavos', () => {
    // Venda de 270 em peças+frete fechada por 250: desconto de 20 rateado por valor.
    const r = selecionarPecasDoPedido(itens, ['b', 'c'], 250);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // b: 100 − 7,40 · c: 50 − 3,70 · frete: 20 − 1,48 (a sobra do floor vai pra 'a', que ficou fora)
    expect(r.discount).toBe(12.58);
    expect(r.totalAmount).toBe(157.42);
    expect(round2(100 + 50 + 20 - (r.discount as number))).toBe(r.totalAmount);
  });

  it('venda sem total não inventa desconto', () => {
    const r = selecionarPecasDoPedido(itens, ['a'], null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalAmount).toBe(120); // 100 + frete 20
    expect(r.discount).toBe(0);
  });

  it('a ordem das peças é a da venda, não a dos ids mandados', () => {
    const r = selecionarPecasDoPedido(itens, ['c', 'a'], totalVenda);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pecas.map((p) => p.id)).toEqual(['a', 'c']);
    expect(r.foraDoPedido.map((p) => p.id)).toEqual(['b']);
  });

  it('peça com quantidade conta por quantidade (é assim que o Order explode em linhas de 1)', () => {
    const lista = [peca('a', 60, { qty: 2 }), peca('b', 30)];
    const r = selecionarPecasDoPedido(lista, ['a'], 90);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pecasDaVenda).toBe(3);
    expect(r.pecasNoPedido).toBe(2);
    expect(r.totalAmount).toBe(60);
  });

  it('venda sem nenhuma peça (só frete/manual) com itemIds vazio devolve inteira vazia — quem avisa é o chamador', () => {
    const r = selecionarPecasDoPedido([frete(20), manual(50)], [], 70);
    expect(r).toMatchObject({ ok: true, parcial: false, pecas: [], pecasDaVenda: 0 });
  });
});

describe('rotuloDaLinha', () => {
  it('REF · COR · TAM; cai pro nome, pro código, pro id', () => {
    expect(rotuloDaLinha({ ref: '138867', cor: 'OFF WHITE', tamanho: 'M' })).toBe('138867 · OFF WHITE · M');
    expect(rotuloDaLinha({ descricao: ' BLUSA ' })).toBe('BLUSA');
    expect(rotuloDaLinha({ sku: '11481126' })).toBe('11481126');
    expect(rotuloDaLinha({ id: 'x' })).toBe('x');
  });
});
