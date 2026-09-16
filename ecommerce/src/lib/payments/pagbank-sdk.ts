'use client';

/**
 * SDK do PagBank no navegador — só pra CRIPTOGRAFAR o cartão.
 *
 * PCI-DSS, a mesma regra do caminho Pagar.me: número, CVV e validade NUNCA
 * saem deste navegador. O SDK oficial (`pagseguro.min.js`) recebe a chave
 * PÚBLICA da conta (vem do backend em `/api/loja/config`) e devolve um blob
 * RSA — é ele, e só ele, que viaja pro BFF e pro backend, que cobra.
 *
 * Carregado sob demanda (só quando o cartão é PagBank e a cliente abriu a
 * aba Cartão): a maioria paga por PIX e não precisa baixar 100 KB de SDK.
 */

const SDK_URL = 'https://assets.pagseguro.com.br/checkout-sdk-js/rc/dist/browser/pagseguro.min.js';

export interface PagbankCardInput {
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
export function loadPagbankSdk(): Promise<PagSeguroGlobal> {
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
 * Criptografa o cartão. Lança com o motivo técnico (nunca com dado do
 * cartão) quando o SDK reprova — número inválido, validade, chave errada.
 */
export async function encryptPagbankCard(input: PagbankCardInput): Promise<string> {
  const sdk = await loadPagbankSdk();
  const r = sdk.encryptCard(input);
  if (r?.hasErrors || !r?.encryptedCard) {
    const motivo = (r?.errors ?? []).map((e) => e.code || e.message).filter(Boolean).join(',') || 'sem encryptedCard';
    throw new Error(`pagbank encryptCard: ${motivo}`);
  }
  return r.encryptedCard;
}
