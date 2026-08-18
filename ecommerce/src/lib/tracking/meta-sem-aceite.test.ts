/**
 * O CAMINHO DE QUEM AINDA NÃO DECIDIU O BANNER — 85% do tráfego.
 *
 * Medição de 17/08/2026 que originou isto: a campanha `52531954165766` trouxe
 * 1.012 sessões e o Meta soube de **8** (0,8%). Entrando pela `/lojas`, 1.162
 * sessões viraram 19. Não era relatório torto — era o algoritmo escolhendo pra
 * quem entregar o anúncio com 8 exemplos.
 *
 * Três coisas são travadas aqui, e as três já quebraram na prática:
 *   1. sem decisão → o `_fbc` (identificador do CLIQUE) acompanha o lote;
 *   2. com "Só o necessário" → não acompanha NADA, nunca;
 *   3. o `_fbc` sobrevive à navegação — o lote sai até 5s depois do evento, e
 *      a essa altura a URL com `fbclid` já ficou pra trás.
 *
 * Cada caso recarrega os módulos: consentimento e Event Manager guardam estado
 * de módulo, e "ainda não decidiu" não dá pra montar com `setConsent` (ele
 * carimba `decided_at` por definição — decidir é o que ele faz).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackableProduct } from './events';

const VESTIDO: TrackableProduct = {
  id: '1234',
  sku: 'VST-001',
  name: 'Vestido Midi Linho',
  price: 389.9,
  category: 'Vestidos',
};

let fetchMock: ReturnType<typeof vi.fn>;

async function carregar() {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  const consent = await import('./consent');
  const manager = await import('./event-manager');
  const events = await import('./events');
  return { ...consent, ...manager, ...events };
}

/** Deixa o cron de 5s do Event Manager rodar e o fetch assentar. */
const despachar = () => vi.advanceTimersByTimeAsync(6_000);

function corpoEnviado(): { consent: { decided_at: string | null }; meta?: { fbc?: string; fbp?: string } } {
  expect(fetchMock).toHaveBeenCalled();
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body);
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('visitante que ainda não decidiu', () => {
  it('manda o _fbc do clique junto do lote', async () => {
    window.history.replaceState({}, '', '/vestido-midi?fbclid=CLIQUE-ABC');

    const m = await carregar();
    m.initTracking();
    m.trackViewItem(VESTIDO);
    await despachar();

    const corpo = corpoEnviado();
    // Ninguém tocou no banner — é este o estado que precisava passar.
    expect(corpo.consent.decided_at).toBeNull();
    expect(corpo.meta?.fbc).toContain('CLIQUE-ABC');
  });

  it('guarda o _fbc: o lote sai de uma URL que já não tem mais fbclid', async () => {
    window.history.replaceState({}, '', '/?fbclid=CLIQUE-XYZ');

    const m = await carregar();
    m.initTracking();
    m.trackViewItem(VESTIDO);

    // Ela clicou numa peça antes do lote de 5s sair.
    window.history.replaceState({}, '', '/produto/vestido-midi-linho');
    await despachar();

    // Lendo só a URL do momento, o clique pago se perdia exatamente aqui.
    expect(corpoEnviado().meta?.fbc).toContain('CLIQUE-XYZ');
  });
});

describe('visitante que clicou "Só o necessário"', () => {
  it('🚨 não manda identificador de anúncio nenhum', async () => {
    window.history.replaceState({}, '', '/vestido-midi?fbclid=CLIQUE-ABC');

    const m = await carregar();
    m.rejectAll();
    m.initTracking();
    m.trackViewItem(VESTIDO);
    await despachar();

    const corpo = corpoEnviado();
    // O evento CHEGA no nosso servidor (dado de 1ª parte, sempre foi assim) —
    // o que não pode existir é o `meta`, que é o que viaja pra Meta.
    expect(corpo.consent.decided_at).not.toBeNull();
    expect(corpo.meta).toBeUndefined();
  });
});
