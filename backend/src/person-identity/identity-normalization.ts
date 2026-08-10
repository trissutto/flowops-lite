export function digitsOnly(value: string | null | undefined): string {
  return String(value || '').replace(/\D/g, '');
}

export function normalizeCpf(value: string | null | undefined): string | null {
  const cpf = digitsOnly(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return null;

  const checkDigit = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  if (checkDigit(9) !== Number(cpf[9])) return null;
  if (checkDigit(10) !== Number(cpf[10])) return null;
  return cpf;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = String(value || '').trim().toLowerCase();
  return email && email.includes('@') ? email : null;
}

export function normalizePhone(value: string | null | undefined): string | null {
  const phone = digitsOnly(value);
  if (phone.length < 10 || phone.length > 13) return null;
  return phone.startsWith('55') && phone.length >= 12 ? phone.slice(2) : phone;
}

export function normalizeInstagramUsername(value: string | null | undefined): string | null {
  const username = String(value || '').trim().replace(/^@/, '').toLowerCase();
  return username.length >= 2 ? username : null;
}
