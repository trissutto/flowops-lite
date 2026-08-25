/**
 * REGRESSÃO DO STUB DO PIXEL (bug de 30/07→24/08/2026).
 *
 * O stub caseiro só fazia `queue.push(...)` e ignorava o `callMethod` que o
 * fbevents.js pendura ao carregar. Efeito: todo evento disparado DEPOIS do
 * script carregado entrava numa fila que ninguém drenava — só
 * PageView/ViewContent (na corrida antes do load) chegavam à Meta, e
 * AddToCart caiu de ~120/dia pra 1-4/dia quando a virada de domínio tirou o
 * WordPress da frente. Estes testes provam as DUAS fases do stub:
 * antes do load enfileira; depois do load, entrega pro callMethod.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metaPixel } from './meta-pixel';
import type { TrackingEvent } from '../types';

type FbqStub = ((...args: unknown[]) => void) & {
  queue: unknown[][];
  callMethod?: (...args: unknown[]) => void;
};

function fbqGlobal(): FbqStub {
  return (window as unknown as { fbq: FbqStub }).fbq;
}

function evento(nome: TrackingEvent['event']): TrackingEvent {
  return {
    event: nome,
    event_id: 'evt-regressao-123',
    timestamp: new Date().toISOString(),
    context: {
      page: { path: '/produto/ref-teste', title: 'Teste', referrer: '' },
      currency: 'BRL',
    } as TrackingEvent['context'],
    params: {},
    source: 'browser',
  } as TrackingEvent;
}

describe('metaPixel — stub do fbq', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', '1175057803035158');
    const w = window as unknown as Record<string, unknown>;
    delete w.fbq;
    delete w._fbq;
    // loadScript pendura <script> no DOM; no jsdom ele nunca "carrega", o que
    // é exatamente a fase 1 do stub.
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ANTES do fbevents carregar: chamadas vão pra fila', () => {
    metaPixel.init();
    const f = fbqGlobal();
    expect(typeof f).toBe('function');

    // O init já enfileirou o fbq('init', <id>).
    const tamanhoInicial = f.queue.length;
    expect(tamanhoInicial).toBeGreaterThanOrEqual(1);

    metaPixel.send(evento('page_view'));
    expect(f.queue.length).toBe(tamanhoInicial + 1);
    expect(f.queue[f.queue.length - 1][0]).toBe('track');
    expect(f.queue[f.queue.length - 1][1]).toBe('PageView');
  });

  it('DEPOIS do fbevents carregar: chamadas vão pro callMethod, não pra fila morta', () => {
    metaPixel.init();
    const f = fbqGlobal();

    // Simula o fbevents.js chegando: drena a fila e pendura o callMethod —
    // exatamente o contrato do script real.
    f.queue.length = 0;
    const recebidas: unknown[][] = [];
    f.callMethod = (...args: unknown[]) => {
      recebidas.push(args);
    };

    metaPixel.send(evento('add_to_cart'));

    // A REGRESSÃO: o stub antigo deixava isto em `queue` (fila morta) e
    // `recebidas` vazio — o AddToCart nunca saía do navegador.
    expect(f.queue.length).toBe(0);
    expect(recebidas.length).toBe(1);
    expect(recebidas[0][0]).toBe('track');
    expect(recebidas[0][1]).toBe('AddToCart');
    // O 4º argumento leva o eventID que fecha a deduplicação com a CAPI.
    expect((recebidas[0][3] as { eventID: string }).eventID).toBe('evt-regressao-123');
  });
});
