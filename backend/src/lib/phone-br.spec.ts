import { localBrPhone, localBrPhoneValido } from './phone-br';

/**
 * O caso que motivou tudo (pedido de 26/08): a cliente colou "+55 11 …" no
 * checkout, a máscara cortava em 11 dígitos e o DDI engolia o FIM do número —
 * "55119595822" gravado, aviso de WhatsApp indo pro nada.
 */
describe('localBrPhone', () => {
  it('mantém número local com DDD (11 dígitos)', () => {
    expect(localBrPhone('11995958222')).toBe('11995958222');
  });

  it('mantém fixo com DDD (10 dígitos)', () => {
    expect(localBrPhone('1335321234')).toBe('1335321234');
  });

  it('remove o DDI 55 quando o total tem 13 dígitos', () => {
    expect(localBrPhone('5511995958222')).toBe('11995958222');
  });

  it('remove o DDI 55 quando o total tem 12 dígitos (fixo com DDI)', () => {
    expect(localBrPhone('551335321234')).toBe('1335321234');
  });

  it('aceita máscara e sinais ("+55 (11) 99595-8222")', () => {
    expect(localBrPhone('+55 (11) 99595-8222')).toBe('11995958222');
  });

  it('NÃO confunde DDD 55 (Santa Maria/RS) com DDI', () => {
    expect(localBrPhone('55999595822')).toBe('55999595822');
    expect(localBrPhone('5535321234')).toBe('5535321234');
  });

  it('tira o zero de operadora da frente', () => {
    expect(localBrPhone('011995958222')).toBe('11995958222');
  });

  it('vazio/nulo vira string vazia', () => {
    expect(localBrPhone('')).toBe('');
    expect(localBrPhone(null)).toBe('');
    expect(localBrPhone(undefined)).toBe('');
  });
});

describe('localBrPhoneValido', () => {
  it('celular com DDD e o 9 na frente é válido', () => {
    expect(localBrPhoneValido('11995958222')).toBe(true);
    expect(localBrPhoneValido('+55 11 99595-8222')).toBe(true);
  });

  it('fixo com DDD é válido', () => {
    expect(localBrPhoneValido('1335321234')).toBe(true);
  });

  it('o caso real do +55 truncado é INVÁLIDO (não vira número de outra pessoa)', () => {
    // 11 dígitos, mas o 3º é "1": sobrou DDI e faltou dígito no fim.
    expect(localBrPhoneValido('55119595822')).toBe(false);
  });

  it('curto demais ou longo demais é inválido', () => {
    expect(localBrPhoneValido('995958222')).toBe(false);
    expect(localBrPhoneValido('551199595822299')).toBe(false);
    expect(localBrPhoneValido('')).toBe(false);
  });
});
