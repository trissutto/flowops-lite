/**
 * O GA4 NÃO DEDUPLICA — E ERA POR ISSO QUE METADE DA RECEITA ESTAVA SEM ORIGEM.
 *
 * A CAPI da Meta é feita pra andar em paralelo com o Pixel: manda dos dois
 * lados e ela junta pelo `event_id`. O Measurement Protocol do GA4 não tem
 * nada disso. Até 27/08/2026 o despacho do servidor mandava o lote INTEIRO
 * para os dois, incluindo os eventos que o gtag do navegador já tinha enviado.
 *
 * Medido no GA4 em 28 dias: "Unassigned" com 7.032 sessões, 289 mil eventos
 * (41 por sessão, contra 5-20 dos canais de gente), 5,77% de engajamento e
 * R$ 45.156 — quase metade da receita da propriedade, sem origem.
 *
 * Estes testes travam a regra nos dois sentidos: o que o navegador manda NÃO
 * repete no GA4, e o que só existe no servidor NÃO pode sumir.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrackingEvent } from './types';

vi.mock('server-only', () => ({}));

const ga4Recebeu: TrackingEvent[][] = [];
const metaRecebeu: TrackingEvent[][] = [];

vi.mock('./server/ga4-mp', () => ({
  isGa4MpEnabled: () => true,
  sendToGa4Mp: async (events: TrackingEvent[]) => {
    ga4Recebeu.push(events);
    return { ok: true, status: 204 };
  },
}));

vi.mock('./server/meta-capi', () => ({
  isMetaCapiEnabled: () => true,
  sendToMetaCapi: async (events: TrackingEvent[]) => {
    metaRecebeu.push(events);
    return { ok: true };
  },
}));

vi.mock('./server/log-store', () => ({
  getLogStore: () => ({ append: async () => {} }),
}));

const { dispatchBatch } = await import('./server/dispatch');

const evento = (over: Partial<TrackingEvent> = {}): TrackingEvent =>
  ({
    event: 'view_item',
    event_id: `ev-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-08-27T12:00:00.000Z',
    params: {},
    source: 'browser',
    context: {
      session_id: 's1',
      anonymous_id: 'anon',
      user_id: null,
      page: { path: '/', url: 'https://lurds.com.br/' },
      device: { type: 'desktop' },
      attribution: {},
      loja: null,
      currency: 'BRL',
      language: 'pt-BR',
      country: 'BR',
    },
    ...over,
  }) as TrackingEvent;

const nomes = (lotes: TrackingEvent[][]) => lotes.flat().map((e) => e.event);

beforeEach(() => {
  ga4Recebeu.length = 0;
  metaRecebeu.length = 0;
});

describe('despacho pro GA4', () => {
  it('NÃO repete no GA4 o evento que o navegador já mandou', async () => {
    await dispatchBatch([evento({ event: 'view_item' }), evento({ event: 'add_to_cart' })], {});

    expect(ga4Recebeu).toEqual([]);
  });

  it('a Meta continua recebendo tudo — a CAPI deduplica pelo event_id', async () => {
    await dispatchBatch([evento({ event: 'view_item' }), evento({ event: 'add_to_cart' })], {});

    expect(nomes(metaRecebeu)).toEqual(['view_item', 'add_to_cart']);
  });

  it('purchase do servidor CHEGA no GA4 — ali o servidor é a única rota', async () => {
    await dispatchBatch(
      [evento({ event: 'purchase', source: 'server', transaction_id: 'lp-1', value: 199.9 })],
      {},
    );

    expect(nomes(ga4Recebeu)).toEqual(['purchase']);
  });

  it('no lote misto, o GA4 recebe só a parte do servidor', async () => {
    await dispatchBatch(
      [
        evento({ event: 'view_item' }),
        evento({ event: 'purchase', source: 'server', transaction_id: 'lp-2' }),
        evento({ event: 'scroll_depth' }),
      ],
      {},
    );

    expect(nomes(ga4Recebeu)).toEqual(['purchase']);
    expect(nomes(metaRecebeu)).toHaveLength(3);
  });
});
