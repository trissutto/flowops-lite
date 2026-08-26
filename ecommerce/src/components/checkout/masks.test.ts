import { describe, expect, it } from 'vitest';

import { isValidPhone, maskPhone } from './masks';

/**
 * O caso real (pedido de 26/08): a cliente colou "+55 11 99595-8222" e a
 * máscara antiga cortava em 11 dígitos — o DDI entrava e ENGOLIA o fim do
 * número. "55119959582" passava no regex do server e o WhatsApp do pedido
 * não era de ninguém.
 */
describe('maskPhone', () => {
  it('formata celular com DDD', () => {
    expect(maskPhone('11995958222')).toBe('(11) 99595-8222');
  });

  it('formata fixo com DDD', () => {
    expect(maskPhone('1335321234')).toBe('(13) 3532-1234');
  });

  it('colar com +55 tira o DDI em vez de engolir o fim do número', () => {
    expect(maskPhone('+55 11 99595-8222')).toBe('(11) 99595-8222');
    expect(maskPhone('5511995958222')).toBe('(11) 99595-8222');
  });

  it('DDD 55 (Santa Maria/RS) com 11 dígitos NÃO é tratado como DDI', () => {
    expect(maskPhone('55999595822')).toBe('(55) 99959-5822');
  });

  it('zero de operadora cai ("011 9…")', () => {
    expect(maskPhone('011995958222')).toBe('(11) 99595-8222');
  });

  it('é idempotente (roda a cada tecla sobre o valor já mascarado)', () => {
    const uma = maskPhone('5511995958222');
    expect(maskPhone(uma)).toBe(uma);
  });
});

describe('isValidPhone', () => {
  it('aceita celular (11, com o 9) e fixo (10)', () => {
    expect(isValidPhone('(11) 99595-8222')).toBe(true);
    expect(isValidPhone('(13) 3532-1234')).toBe(true);
  });

  it('aceita o número colado com +55 (o DDI sai antes de validar)', () => {
    expect(isValidPhone('+55 11 99595-8222')).toBe(true);
  });

  it('recusa o rastro do +55 truncado: 11 dígitos sem o 9 depois do DDD', () => {
    expect(isValidPhone('55119595822')).toBe(false);
  });

  it('recusa curto/vazio', () => {
    expect(isValidPhone('995958222')).toBe(false);
    expect(isValidPhone('')).toBe(false);
  });
});
