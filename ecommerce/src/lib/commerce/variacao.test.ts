import { describe, expect, it } from 'vitest';
import { codigoDaVariacao } from './variacao';

/**
 * O caso real de 25/09: VOGUE em duas cores, as duas com 52. A sacola tem
 * que levar o código da cor ESCOLHIDA — nunca o 52 "que sobrou".
 */
const vogue = [
  { nome: 'PRETO', tamanhos: [{ label: '50', sku: '5000050' }, { label: '52', sku: '5000052' }] },
  { nome: 'MARROM', tamanhos: [{ label: '52', sku: '5100052' }, { label: '54', sku: '5100054' }] },
];

describe('codigoDaVariacao — a peça é cor + tamanho, não a REF', () => {
  it('MARROM 52 devolve o código da MARROM, mesmo com PRETO 52 na peça', () => {
    expect(codigoDaVariacao(vogue, 'MARROM', '52')).toBe('5100052');
    expect(codigoDaVariacao(vogue, 'PRETO', '52')).toBe('5000052');
  });

  it('tamanho que só existe em OUTRA cor não vira código', () => {
    // O 54 é da MARROM; pedir PRETO 54 não pode cair no 5100054.
    expect(codigoDaVariacao(vogue, 'PRETO', '54')).toBeUndefined();
  });

  it('sem cor numa peça de várias cores NÃO escolhe por ela', () => {
    expect(codigoDaVariacao(vogue, null, '52')).toBeUndefined();
    expect(codigoDaVariacao(vogue, undefined, '52')).toBeUndefined();
  });

  it('peça de cor única resolve sem cor informada', () => {
    expect(codigoDaVariacao([vogue[1]], null, '54')).toBe('5100054');
  });

  it('cor que não está na lista, grade sem código ou sem tamanho → indefinido', () => {
    expect(codigoDaVariacao(vogue, 'VINHO', '52')).toBeUndefined();
    expect(codigoDaVariacao([{ nome: 'PRETO', tamanhos: [{ label: '52' }] }], 'PRETO', '52')).toBeUndefined();
    expect(codigoDaVariacao([{ nome: 'PRETO', tamanhos: [{ label: '52', sku: '  ' }] }], 'PRETO', '52')).toBeUndefined();
    expect(codigoDaVariacao(vogue, 'PRETO', null)).toBeUndefined();
    expect(codigoDaVariacao([], 'PRETO', '52')).toBeUndefined();
    expect(codigoDaVariacao(undefined, 'PRETO', '52')).toBeUndefined();
  });
});
