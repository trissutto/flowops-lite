/**
 * Utilitário pra geração de EAN-13 com prefixo 8 (uso interno LURDS).
 *
 * ESTRUTURA:
 *   8 + [11 dígitos sequenciais] + [1 dígito verificador]
 *   = 13 dígitos no total
 *
 * Exemplo:
 *   sequência 1   → 8000000000017 (00000000001 + check 7)
 *   sequência 2   → 8000000000024
 *   sequência 100 → 8000000001005
 *
 * ALGORITMO DO DÍGITO VERIFICADOR (padrão GS1 EAN-13):
 *   Soma os 12 primeiros dígitos com peso alternado (1, 3, 1, 3, ...).
 *   Tira o módulo 10 e calcula o complemento de 10.
 *
 * IMPORTANTE: o prefixo 8 foi escolhido pela LURDS pra não colidir com o
 * range que o Wincred usa (Wincred usa códigos curtos de 7-8 dígitos
 * decimais, sem prefixo). Se um dia o Wincred começar a emitir EAN-13,
 * usar prefixo nacional 789/790 (Brasil), o prefixo 8 não conflita.
 */

const EAN13_PREFIX = '8';
const EAN13_TOTAL_LEN = 13;
const EAN13_BODY_LEN = EAN13_TOTAL_LEN - 1; // 12 (prefixo + sequencial)
const EAN13_SEQ_LEN = EAN13_BODY_LEN - EAN13_PREFIX.length; // 11

/**
 * Calcula o dígito verificador (check digit) de um corpo EAN-13 de 12 dígitos.
 *
 * @param body12 String com 12 dígitos (prefixo + sequencial, SEM o check digit)
 * @returns String com 1 dígito (0-9)
 */
export function calcEan13CheckDigit(body12: string): string {
  if (!/^\d{12}$/.test(body12)) {
    throw new Error(`calcEan13CheckDigit: corpo inválido "${body12}" (precisa ter exatamente 12 dígitos)`);
  }
  let soma = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(body12[i]);
    // posição ímpar (1ª, 3ª, ...) peso 1; posição par (2ª, 4ª, ...) peso 3
    const peso = i % 2 === 0 ? 1 : 3;
    soma += d * peso;
  }
  const mod = soma % 10;
  const check = mod === 0 ? 0 : 10 - mod;
  return String(check);
}

/**
 * Valida um EAN-13 completo (13 dígitos), conferindo o check digit.
 */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const body = code.slice(0, 12);
  const expected = calcEan13CheckDigit(body);
  return expected === code[12];
}

/**
 * Constrói um EAN-13 a partir de um número sequencial.
 *
 * @param seq Número sequencial (1, 2, 3, ...). Tem que caber em 11 dígitos
 *            (max 99_999_999_999).
 * @returns EAN-13 de 13 dígitos
 */
export function buildEan13FromSeq(seq: bigint | number): string {
  const seqNum = typeof seq === 'bigint' ? seq : BigInt(seq);
  if (seqNum < 0n) throw new Error(`buildEan13FromSeq: seq não pode ser negativo (${seqNum})`);
  const max = 10n ** BigInt(EAN13_SEQ_LEN); // 100_000_000_000
  if (seqNum >= max) throw new Error(`buildEan13FromSeq: seq excede ${EAN13_SEQ_LEN} dígitos (${seqNum})`);

  const seqStr = seqNum.toString().padStart(EAN13_SEQ_LEN, '0');
  const body = `${EAN13_PREFIX}${seqStr}`; // 12 dígitos
  const check = calcEan13CheckDigit(body);
  return `${body}${check}`;
}

/**
 * Gera N EANs sequenciais a partir de um valor base.
 *
 * @param startSeq Próximo número sequencial a usar
 * @param count Quantos EANs gerar
 * @returns Array com N strings EAN-13
 */
export function generateEan13Batch(startSeq: bigint, count: number): string[] {
  if (count <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(buildEan13FromSeq(startSeq + BigInt(i)));
  }
  return out;
}
