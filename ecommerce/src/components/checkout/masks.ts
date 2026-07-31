/**
 * MÁSCARAS E VALIDAÇÕES DO CHECKOUT — funções puras, sem UI.
 *
 * Vivem separadas dos componentes por dois motivos: (1) máscara aplicada no
 * onChange precisa ser idempotente (roda a cada tecla sobre o valor já
 * mascarado), então cada função aceita entrada suja e devolve o formato final;
 * (2) a validação que VALE é a do server — aqui é cortesia de UX pra apontar
 * o erro antes do submit, nunca a fronteira de segurança.
 *
 * ⚠️ CPF valida o dígito verificador DE VERDADE (algoritmo da Receita), não só
 * o comprimento — "111.111.111-11" passa em regex e é inválido.
 */

import { onlyDigits } from '@/lib/commerce/frete';

export { onlyDigits };

/* ------------------------------------------------------------------ CPF */

/** 000.000.000-00 — progressiva (funciona a cada tecla). */
export function maskCpf(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
}

/**
 * Validação real do CPF: os dois dígitos verificadores são módulo 11 dos
 * anteriores. Sequências repetidas (000…, 111…) têm DV "válido" pela conta
 * mas são proibidas pela Receita — o regex do início barra esse caso.
 */
export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(cpf[i]) * (size + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(cpf[size])) return false;
  }
  return true;
}

/* ------------------------------------------------------------- TELEFONE */

/** (11) 98765-4321 — aceita fixo (10 dígitos) e celular (11). */
export function maskPhone(value: string): string {
  const d = onlyDigits(value).slice(0, 11);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function isValidPhone(value: string): boolean {
  return [10, 11].includes(onlyDigits(value).length);
}

/* ----------------------------------------------------------------- CEP */

/** 00000-000. */
export function maskCep(value: string): string {
  const d = onlyDigits(value).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

/* -------------------------------------------------------------- CARTÃO */

export type CardBrand = 'visa' | 'mastercard' | 'elo' | 'amex' | 'hipercard';

export const CARD_BRAND_LABEL: Record<CardBrand, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  elo: 'Elo',
  amex: 'American Express',
  hipercard: 'Hipercard',
};

/**
 * Prefixos Elo — precisam ser testados ANTES do Visa: vários BINs Elo começam
 * com 4, e o teste ingênuo "começa com 4 = Visa" erraria a bandeira nacional
 * mais comum do público da loja.
 */
const ELO_PREFIXES = [
  '401178', '401179', '431274', '438935', '451416', '457393', '457631',
  '457632', '504175', '5067', '509', '627780', '636297', '636368', '6500',
  '6504', '6505', '6516', '6550',
];

export function detectCardBrand(value: string): CardBrand | undefined {
  const d = onlyDigits(value);
  if (d.length < 2) return undefined;
  if (ELO_PREFIXES.some((p) => d.startsWith(p))) return 'elo';
  if (/^3[47]/.test(d)) return 'amex';
  if (/^(606282|3841)/.test(d)) return 'hipercard';
  if (/^5[1-5]/.test(d) || /^(222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/.test(d)) return 'mastercard';
  if (d.startsWith('4')) return 'visa';
  return undefined;
}

/** Amex agrupa 4-6-5 (15 dígitos); as demais 4-4-4-4 (16). */
export function maskCardNumber(value: string): string {
  const brand = detectCardBrand(value);
  if (brand === 'amex') {
    const d = onlyDigits(value).slice(0, 15);
    return [d.slice(0, 4), d.slice(4, 10), d.slice(10)].filter(Boolean).join(' ');
  }
  const d = onlyDigits(value).slice(0, 16);
  return d.replace(/(\d{4})(?=\d)/g, '$1 ');
}

/**
 * Luhn — o checksum que todo número de cartão real satisfaz. Pega dígito
 * trocado/faltando ANTES do submit; não prova que o cartão existe.
 */
export function isLuhnValid(value: string): boolean {
  const d = onlyDigits(value);
  if (d.length < 13) return false;
  let sum = 0;
  let doubleIt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (doubleIt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleIt = !doubleIt;
  }
  return sum % 10 === 0;
}

export function isValidCardNumber(value: string): boolean {
  const d = onlyDigits(value);
  const expected = detectCardBrand(value) === 'amex' ? 15 : 16;
  return d.length === expected && isLuhnValid(d);
}

/* ------------------------------------------------------------ VALIDADE */

/** MM/AA. */
export function maskExpiry(value: string): string {
  const d = onlyDigits(value).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

/** Mês 01–12 e competência >= mês atual (cartão vale até o fim do mês). */
export function isValidExpiry(value: string): boolean {
  const m = /^(\d{2})\/(\d{2})$/.exec(value);
  if (!m) return false;
  const month = Number(m[1]);
  if (month < 1 || month > 12) return false;
  const year = 2000 + Number(m[2]);
  const now = new Date();
  return year * 12 + (month - 1) >= now.getFullYear() * 12 + now.getMonth();
}
