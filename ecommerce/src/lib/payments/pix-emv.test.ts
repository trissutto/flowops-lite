/**
 * Testes do payload PIX EMV — o formato é rígido: um byte errado e o app do
 * banco recusa o QR em silêncio. Por isso o teste confere o payload byte a
 * byte onde importa: CRC, chave, valor e limites de campo.
 */

import { describe, expect, it } from 'vitest';
import { buildPixPayload, crc16ccitt } from './pix-emv';

describe('crc16ccitt', () => {
  it('bate com o vetor de teste clássico do CCITT-FALSE', () => {
    // "123456789" → 0x29B1 é O vetor de verificação do CRC16-CCITT-FALSE.
    expect(crc16ccitt('123456789')).toBe('29B1');
  });

  it('devolve sempre 4 hex maiúsculos', () => {
    expect(crc16ccitt('')).toMatch(/^[0-9A-F]{4}$/);
    expect(crc16ccitt('a')).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe('buildPixPayload', () => {
  const base = { amount: 289.9, txid: 'LP000042K4', key: 'sandbox@lurdsplussize.com.br' };

  it('termina com CRC válido de 4 hex', () => {
    const payload = buildPixPayload(base);
    const crc = payload.slice(-4);
    expect(crc).toMatch(/^[0-9A-F]{4}$/);
    // Recalcula sobre tudo que vem antes (incluindo o "6304") e confere.
    expect(crc16ccitt(payload.slice(0, -4))).toBe(crc);
  });

  it('contém a chave PIX dentro do campo 26', () => {
    const payload = buildPixPayload(base);
    expect(payload).toContain('br.gov.bcb.pix');
    expect(payload).toContain('sandbox@lurdsplussize.com.br');
  });

  it('formata o valor com PONTO e 2 casas no campo 54', () => {
    const payload = buildPixPayload(base);
    // TLV completo: id 54, tamanho 06, valor "289.90".
    expect(payload).toContain('5406289.90');
    expect(payload).not.toContain('289,90');
  });

  it('valor inteiro ganha as 2 casas decimais', () => {
    expect(buildPixPayload({ ...base, amount: 80 })).toContain('540580.00');
  });

  it('começa com o payload format indicator e anuncia o CRC com 6304', () => {
    const payload = buildPixPayload(base);
    expect(payload.startsWith('000201')).toBe(true);
    expect(payload.slice(-8, -4)).toBe('6304');
  });

  it('normaliza acento e caixa em nome/cidade (limite EMV)', () => {
    const payload = buildPixPayload({ ...base, merchantName: "Lurd's São João", merchantCity: 'Itanhaém' });
    expect(payload).toContain('LURDS SAO JOAO');
    expect(payload).toContain('ITANHAEM');
  });

  it('txid não-alfanumérico é saneado e limitado a 25 chars', () => {
    const payload = buildPixPayload({ ...base, txid: 'abc-123-'.repeat(10) });
    // 62 = TLV externo; 05 + tamanho 25 + os 25 primeiros chars limpos.
    expect(payload).toContain('0525' + 'abc123'.repeat(10).slice(0, 25));
  });
});
