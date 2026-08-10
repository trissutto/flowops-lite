import {
  digitsOnly,
  normalizeCpf,
  normalizeEmail,
  normalizeInstagramUsername,
  normalizePhone,
} from './identity-normalization';

describe('identity normalization', () => {
  it('normaliza e valida CPF com ou sem máscara', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
    expect(normalizeCpf('52998224725')).toBe('52998224725');
  });

  it('rejeita CPF inválido, repetido ou incompleto', () => {
    expect(normalizeCpf('529.982.247-24')).toBeNull();
    expect(normalizeCpf('111.111.111-11')).toBeNull();
    expect(normalizeCpf('123')).toBeNull();
  });

  it('normaliza identificadores sem inventar correspondências', () => {
    expect(digitsOnly('(13) 99999-0000')).toBe('13999990000');
    expect(normalizeEmail(' Cliente@Email.COM ')).toBe('cliente@email.com');
    expect(normalizeEmail('sem-email')).toBeNull();
    expect(normalizePhone('+55 (13) 99999-0000')).toBe('13999990000');
    expect(normalizePhone('1234')).toBeNull();
    expect(normalizeInstagramUsername(' @Maria.Plus ')).toBe('maria.plus');
  });
});
