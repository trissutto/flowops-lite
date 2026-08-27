/**
 * O `client_id` DO GTAG, E SÓ ELE, COSTURA A COMPRA À VISITA.
 *
 * Até 27/08/2026 o `purchase` server-side ia ao GA4 com o nosso
 * `lurds_anonymous_id`. Para o GA4 aquilo é um visitante novo, sem clique de
 * anúncio: a venda virava tráfego direto e a importação GA4 → Google Ads
 * ficou 10 dias sem uma única compra, enquanto `add_to_cart` e
 * `begin_checkout` — que nascem no navegador, com o cookie certo — chegavam
 * todo dia. A conta cortou a campanha que mais vendia por falta de sinal.
 *
 * Estes testes existem porque a regressão é MUDA: o Measurement Protocol
 * responde 204 para quase tudo, inclusive para payload que ele descarta.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getGa4BrowserIds } from './identity';
import type { TrackingEvent } from './types';

// `ga4-mp.ts` importa `server-only`, que existe justamente pra explodir fora do
// servidor. Aqui o módulo é o alvo do teste, então o guarda vira no-op.
vi.mock('server-only', () => ({}));

const { sendToGa4Mp } = await import('./server/ga4-mp');

function limpaCookies() {
  document.cookie.split(';').forEach((c) => {
    const nome = c.split('=')[0].trim();
    if (nome) document.cookie = `${nome}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
}

beforeEach(() => {
  limpaCookies();
  localStorage.clear();
});

describe('getGa4BrowserIds', () => {
  it('tira o prefixo de versão do cookie `_ga` — o client_id são os dois últimos campos', () => {
    document.cookie = '_ga=GA1.1.1234567890.1755600000';

    expect(getGa4BrowserIds().ga4?.client_id).toBe('1234567890.1755600000');
  });

  it('lê a sessão do `_ga_<sufixo>` no formato GS1', () => {
    process.env.NEXT_PUBLIC_GA4_ID = 'G-YH69KP0Z8X';
    document.cookie = '_ga_YH69KP0Z8X=GS1.1.1755600000.3.1.1755600300.60.0.0';

    expect(getGa4BrowserIds().ga4?.session_id).toBe('1755600000');
  });

  it('lê a sessão no formato GS2, que o Google passou a usar sem avisar', () => {
    process.env.NEXT_PUBLIC_GA4_ID = 'G-YH69KP0Z8X';
    document.cookie = '_ga_YH69KP0Z8X=GS2.1.s1755600000$o5$g1$t1755600300$j60';

    expect(getGa4BrowserIds().ga4?.session_id).toBe('1755600000');
  });

  it('sem cookie devolve objeto vazio — bloqueador não pode derrubar checkout', () => {
    expect(getGa4BrowserIds()).toEqual({});
  });
});

describe('sendToGa4Mp', () => {
  const evento = (ga4?: { client_id?: string; session_id?: string }): TrackingEvent =>
    ({
      event: 'purchase',
      event_id: 'purchase-abc12345',
      timestamp: '2026-08-27T12:00:00.000Z',
      params: {},
      value: 199.9,
      transaction_id: 'abc12345',
      source: 'server',
      context: {
        session_id: 'sessao-nossa',
        anonymous_id: 'anon-nosso',
        user_id: null,
        ga4,
        page: { path: '/checkout/confirmacao', url: 'https://lurds.com.br/checkout/confirmacao' },
        device: { type: 'desktop' },
        attribution: {},
        loja: null,
        currency: 'BRL',
        language: 'pt-BR',
        country: 'BR',
      },
    }) as TrackingEvent;

  /** O que sairia no corpo do Measurement Protocol. */
  type CorpoMp = { client_id: string; events: Array<{ params: Record<string, unknown> }> };
  let corpos: CorpoMp[];

  beforeEach(() => {
    corpos = [];
    process.env.NEXT_PUBLIC_GA4_ID = 'G-YH69KP0Z8X';
    process.env.GA4_API_SECRET = 'segredo-de-teste';
    process.env.GA4_MP_DEBUG = '';
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      corpos.push(JSON.parse(String(init.body)) as CorpoMp);
      return { ok: true, status: 204, json: async () => ({}) } as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('manda o client_id do gtag, não o nosso anonymous_id', async () => {
    await sendToGa4Mp([evento({ client_id: '1234567890.1755600000' })]);

    expect(corpos[0].client_id).toBe('1234567890.1755600000');
  });

  it('manda a sessão do gtag — a nossa não recebe a atribuição do clique', async () => {
    await sendToGa4Mp([evento({ client_id: '111.222', session_id: '1755600000' })]);

    expect(corpos[0].events[0].params.session_id).toBe('1755600000');
  });

  it('sem cookie do gtag, cai no anonymous_id: pior atribuição, nunca evento perdido', async () => {
    await sendToGa4Mp([evento(undefined)]);

    expect(corpos[0].client_id).toBe('anon-nosso');
    expect(corpos[0].events[0].params.session_id).toBe('sessao-nossa');
  });
});
