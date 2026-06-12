/**
 * Utilitários de CPF — formatação, validação e máscara de input.
 *
 * Validação: algoritmo oficial (2 dígitos verificadores).
 * Formato: 000.000.000-00
 */

/** Remove tudo que não for dígito */
export function cpfDigits(cpf: string): string {
  return (cpf || '').replace(/\D/g, '');
}

/** Aplica máscara 000.000.000-00 incrementalmente (digita-corrente) */
export function maskCpf(value: string): string {
  const d = cpfDigits(value).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

/**
 * Valida CPF pelo algoritmo oficial.
 * Rejeita: tamanho ≠ 11, todos dígitos iguais, dígitos verificadores errados.
 */
export function isValidCpf(cpf: string): boolean {
  const d = cpfDigits(cpf);
  if (d.length !== 11) return false;
  // Sequência igual (111.111.111-11, etc.) é inválida
  if (/^(\d)\1+$/.test(d)) return false;

  // 1º dígito verificador
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i], 10) * (10 - i);
  let dv1 = (sum * 10) % 11;
  if (dv1 === 10) dv1 = 0;
  if (dv1 !== parseInt(d[9], 10)) return false;

  // 2º dígito verificador
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i], 10) * (11 - i);
  let dv2 = (sum * 10) % 11;
  if (dv2 === 10) dv2 = 0;
  return dv2 === parseInt(d[10], 10);
}
