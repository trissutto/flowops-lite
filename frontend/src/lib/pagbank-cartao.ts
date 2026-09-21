'use client';

/**
 * CARTÃO PELO PAGBANK NO NAVEGADOR — SDK + máscaras da página `/pague/<token>`
 * (link de pagamento do PDV, 21/09/2026).
 *
 * PCI-DSS, a regra que não se negocia: número, CVV e validade NUNCA saem deste
 * navegador. O SDK oficial do PagBank recebe a chave PÚBLICA da conta (vem do
 * backend no estado do link) e devolve um blob RSA — é ele, e só ele, que
 * viaja pro backend, que cobra.
 *
 * Cópia enxuta do que o site já usa desde 16/09
 * (`ecommerce/src/lib/payments/pagbank-sdk.ts` + `components/checkout/masks.ts`):
 * são dois apps Next separados e não compartilham código.
 */

const SDK_URL = 'https://assets.pagseguro.com.br/checkout-sdk-js/rc/dist/browser/pagseguro.min.js';

interface PagbankCardInput {
  publicKey: string;
  holder: string;
  number: string;
  expMonth: string;
  expYear: string;
  securityCode: string;
}

interface PagbankEncryptResult {
  encryptedCard?: string;
  hasErrors?: boolean;
  errors?: Array<{ code?: string; message?: string }>;
}

interface PagSeguroGlobal {
  encryptCard(input: PagbankCardInput): PagbankEncryptResult;
}

declare global {
  interface Window {
    PagSeguro?: PagSeguroGlobal;
  }
}

let carregando: Promise<PagSeguroGlobal> | null = null;

/** Injeta o script uma vez e resolve com o global `PagSeguro`. */
export function carregarSdkPagbank(): Promise<PagSeguroGlobal> {
  if (typeof window === 'undefined') return Promise.reject(new Error('sem window'));
  if (window.PagSeguro?.encryptCard) return Promise.resolve(window.PagSeguro);
  if (carregando) return carregando;

  carregando = new Promise<PagSeguroGlobal>((resolve, reject) => {
    const existente = document.querySelector<HTMLScriptElement>(`script[src="${SDK_URL}"]`);
    const script = existente ?? document.createElement('script');
    const pronto = () => {
      if (window.PagSeguro?.encryptCard) resolve(window.PagSeguro);
      else reject(new Error('SDK do PagBank carregou sem encryptCard'));
    };
    script.addEventListener('load', pronto, { once: true });
    script.addEventListener('error', () => reject(new Error('SDK do PagBank não carregou')), { once: true });
    if (!existente) {
      script.src = SDK_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  }).finally(() => {
    carregando = null;
  });
  return carregando;
}

/**
 * Criptografa o cartão. Lança com o motivo técnico (NUNCA com dado do cartão)
 * quando o SDK reprova — número inválido, validade, chave errada.
 */
export async function criptografarCartaoPagbank(input: {
  publicKey: string;
  holder: string;
  number: string;
  /** MM/AA */
  expiry: string;
  cvv: string;
}): Promise<string> {
  const sdk = await carregarSdkPagbank();
  const [mm, yy] = input.expiry.split('/');
  const r = sdk.encryptCard({
    publicKey: input.publicKey,
    holder: input.holder.trim(),
    number: soDigitos(input.number),
    expMonth: mm,
    // O SDK pede o ano com 4 dígitos.
    expYear: yy && yy.length === 2 ? `20${yy}` : yy,
    securityCode: input.cvv,
  });
  if (r?.hasErrors || !r?.encryptedCard) {
    const motivo = (r?.errors ?? []).map((e) => e.code || e.message).filter(Boolean).join(',') || 'sem encryptedCard';
    throw new Error(`pagbank encryptCard: ${motivo}`);
  }
  return r.encryptedCard;
}

export function soDigitos(v: string): string {
  return String(v || '').replace(/\D/g, '');
}

/** Amex agrupa 4-6-5; os demais de 4 em 4. */
export function mascaraCartao(v: string): string {
  const d = soDigitos(v);
  if (/^3[47]/.test(d)) {
    const a = d.slice(0, 15);
    return [a.slice(0, 4), a.slice(4, 10), a.slice(10)].filter(Boolean).join(' ');
  }
  return d.slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
}

/** Luhn + tamanho plausível (Amex 15; demais 13–19). É cortesia de UX — quem valida é o PagBank. */
export function cartaoValido(v: string): boolean {
  const d = soDigitos(v);
  const amex = /^3[47]/.test(d);
  if (amex ? d.length !== 15 : d.length < 13 || d.length > 19) return false;
  let soma = 0;
  let dobra = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dobra) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    soma += n;
    dobra = !dobra;
  }
  return soma % 10 === 0;
}

/** MM/AA progressivo. */
export function mascaraValidade(v: string): string {
  const d = soDigitos(v).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

/** Mês 01–12 e competência >= mês atual (o cartão vale até o fim do mês). */
export function validadeOk(v: string): boolean {
  const m = /^(\d{2})\/(\d{2})$/.exec(v);
  if (!m) return false;
  const mes = Number(m[1]);
  if (mes < 1 || mes > 12) return false;
  const ano = 2000 + Number(m[2]);
  const agora = new Date();
  return ano * 12 + (mes - 1) >= agora.getFullYear() * 12 + agora.getMonth();
}

/** 000.000.000-00 progressivo. */
export function mascaraCpf(v: string): string {
  const d = soDigitos(v).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
}

/** CPF com dígito verificador de verdade ("111.111.111-11" não passa). */
export function cpfOk(v: string): boolean {
  const cpf = soDigitos(v);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const tam of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < tam; i++) soma += Number(cpf[i]) * (tam + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(cpf[tam])) return false;
  }
  return true;
}

/** (11) 98765-4321 — o DDI 55 colado cai fora (o "+55" engolia dígito — caso de 26/08). */
export function mascaraCelular(v: string): string {
  let d = soDigitos(v).replace(/^0+/, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  d = d.slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function celularOk(v: string): boolean {
  let d = soDigitos(v).replace(/^0+/, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || (d.length === 11 && d[2] === '9');
}

export function emailOk(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
}
