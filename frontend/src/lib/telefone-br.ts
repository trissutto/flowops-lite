/**
 * Telefone BR do pedido — espelho de `backend/src/lib/phone-br.ts`
 * (`localBrPhone`/`localBrPhoneValido`). Mexeu na regra lá, mexe aqui: a tela
 * apontar problema que o servidor aceita (ou o contrário) é como nasce o
 * "salvei e não deixou".
 *
 * O caso que criou este arquivo: cliente colou "+55 11 99595-8222" no
 * checkout, a máscara cortava em 11 dígitos e o DDI ENGOLIA o fim do número —
 * o pedido ficava com "55119595822", que não é telefone de ninguém.
 */

/** Só dígitos, sem DDI: o 55 da frente cai quando o total tem 12-13 dígitos. */
export function telefoneLocalBr(raw: string | null | undefined): string {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^0+/, ''); // prefixo de operadora ("011 9…")
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d;
}

/**
 * "(11) 99595-8222" quando o número é são. Número torto volta CRU de
 * propósito: formatar "55119595822" como "(55) 11959-5822" esconderia o
 * defeito atrás de uma cara de telefone válido.
 */
export function fmtTelefoneBr(raw: string | null | undefined): string {
  const d = telefoneLocalBr(raw);
  if (d.length === 11 && d[2] === '9') return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(raw ?? '');
}

/** Por que este telefone parece errado — null = parece são. */
export function telefoneProblema(raw: string | null | undefined): string | null {
  const bruto = String(raw ?? '').replace(/\D/g, '');
  if (!bruto) return null;
  const d = telefoneLocalBr(bruto);
  if (d.length < 10) return 'faltam dígitos — precisa de DDD + número';
  if (d.length > 11) return 'dígitos demais pra um telefone com DDD';
  if (d.length === 11 && d[2] !== '9') {
    return bruto.startsWith('55')
      ? 'parece +55 colado que engoliu o FIM do número — faltam os últimos dígitos'
      : 'celular tem o 9 logo depois do DDD';
  }
  return null;
}

/** Máscara progressiva "(11) 99595-8222" — idempotente, roda a cada tecla. */
export function maskTelefoneBr(value: string): string {
  const d = telefoneLocalBr(value).slice(0, 11);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** 000.000.000-00 — progressiva. */
export function maskCpfBr(value: string): string {
  const d = String(value ?? '').replace(/\D/g, '').slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
}

/** Dígito verificador de verdade (mesmo algoritmo do backend e do checkout). */
export function cpfValidoBr(value: string): boolean {
  const d = String(value ?? '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Number(d[i]) * (size + 1 - i);
    const dv = ((sum * 10) % 11) % 10;
    if (dv !== Number(d[size])) return false;
  }
  return true;
}
