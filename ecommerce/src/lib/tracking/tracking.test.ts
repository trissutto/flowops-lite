/**
 * Testes dos caminhos que, se quebrarem, quebram DINHEIRO:
 * compra duplicada, compra forjada, evento sem consentimento e preço errado.
 *
 * A observação é feita pelo comportamento visível — Data Layer e log de
 * despacho — e não espiando estado interno. Assim o teste continua valendo
 * quando o interior do Event Manager mudar.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetTracking, getLocalLogs, track } from './event-manager';
import { clearDataLayer, getDataLayer } from './data-layer';
import { acceptAll, rejectAll, setConsent } from './consent';
import { toTrackedItem, trackAddToCart, trackSearch, trackViewItem } from './events';
import type { TrackableProduct } from './events';

/** Deixa o microtask do despacho rodar antes de conferir. */
const assentar = () => new Promise((r) => setTimeout(r, 0));

const VESTIDO: TrackableProduct = {
  id: '1234',
  sku: 'VST-001',
  name: 'Vestido Midi Linho',
  price: 389.9,
  category: 'Vestidos',
  fabric: 'Linho',
};

beforeEach(() => {
  __resetTracking();
  clearDataLayer();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }));
  acceptAll();
});

describe('eventos server-only', () => {
  it('recusa purchase vindo do navegador', async () => {
    const avisar = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 'purchase' é um EventName válido (o servidor usa) — a barreira do
    // navegador é de RUNTIME, e é ela que este teste garante.
    track('purchase', {}, { value: 50_000, transaction_id: 'forjado-1' });
    await assentar();

    expect(getDataLayer()).toHaveLength(0);
    expect(avisar).toHaveBeenCalledWith(expect.stringContaining('só pode ser emitido pelo servidor'));
  });

  it('recusa refund vindo do navegador', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    track('refund', {}, { value: 100, transaction_id: 'x' });
    await assentar();
    expect(getDataLayer()).toHaveLength(0);
  });
});

describe('deduplicação', () => {
  it('conta uma vez quando o mesmo evento repete na janela', async () => {
    trackAddToCart(VESTIDO, { tamanho: '48' });
    trackAddToCart(VESTIDO, { tamanho: '48' });
    trackAddToCart(VESTIDO, { tamanho: '48' });
    await assentar();

    expect(getDataLayer().filter((e) => e.event === 'add_to_cart')).toHaveLength(1);
  });

  it('não confunde tamanhos diferentes da mesma peça', async () => {
    trackAddToCart(VESTIDO, { tamanho: '48' });
    trackAddToCart(VESTIDO, { tamanho: '52' });
    await assentar();

    expect(getDataLayer().filter((e) => e.event === 'add_to_cart')).toHaveLength(2);
  });

  it('dá event_id único a cada evento aceito (é o que casa Pixel e CAPI)', async () => {
    trackViewItem(VESTIDO);
    trackSearch('vestido', 12);
    await assentar();

    const ids = getDataLayer().map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length >= 8)).toBe(true);
  });
});

describe('gate de consentimento', () => {
  it('não manda nada ao servidor sem analytics nem marketing', async () => {
    rejectAll();
    trackViewItem(VESTIDO);
    await assentar();

    const servidor = getLocalLogs().filter((l) => l.destination === 'server');
    expect(servidor.every((l) => l.status === 'skipped')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('mantém o histórico próprio mesmo sem consentimento (dado de 1ª parte)', async () => {
    rejectAll();
    trackViewItem(VESTIDO);
    await assentar();

    // O evento existe pra depuração; o que não acontece é sair pra terceiro.
    expect(getDataLayer()).toHaveLength(1);
  });

  it('volta a despachar quando só analytics é concedido', async () => {
    setConsent({ analytics: true, marketing: false, personalization: false });
    trackViewItem(VESTIDO);
    await assentar();

    const servidor = getLocalLogs().filter((l) => l.destination === 'server');
    expect(servidor.some((l) => l.status === 'skipped')).toBe(false);
  });
});

describe('valor do item', () => {
  it('usa o preço promocional, não o cheio', () => {
    const item = toTrackedItem({ ...VESTIDO, salePrice: 299.9 });
    expect(item.valor).toBe(299.9);
    expect(item.desconto).toBe(90);
  });

  it('sem promoção, não inventa desconto', () => {
    const item = toTrackedItem(VESTIDO);
    expect(item.valor).toBe(389.9);
    expect(item.desconto).toBeUndefined();
  });

  it('multiplica pela quantidade no valor do add_to_cart', async () => {
    trackAddToCart(VESTIDO, { quantidade: 3, tamanho: '50' });
    await assentar();

    const evento = getDataLayer().find((e) => e.event === 'add_to_cart');
    expect(evento?.value).toBeCloseTo(389.9 * 3, 2);
    expect(evento?.items?.[0].quantidade).toBe(3);
  });

  it('carrega os campos da marca que as plataformas não têm', () => {
    const item = toTrackedItem(VESTIDO, { cor: 'Areia', tamanho: '48' });
    expect(item.tecido).toBe('Linho');
    expect(item.cor).toBe('Areia');
    expect(item.tamanho).toBe('48');
  });
});

describe('validação', () => {
  it('recusa evento fora da taxonomia', async () => {
    const avisar = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // @ts-expect-error — evento inexistente, recusado no schema.
    track('comprou_talvez', {});
    await assentar();

    expect(getDataLayer()).toHaveLength(0);
    expect(avisar).toHaveBeenCalled();
  });

  it('recusa item com preço negativo antes de sair do navegador', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    trackAddToCart({ ...VESTIDO, price: -10 });
    await assentar();
    expect(getDataLayer()).toHaveLength(0);
  });
});

describe('contexto', () => {
  it('mantém o mesmo anonymous_id entre eventos', async () => {
    trackViewItem(VESTIDO);
    trackSearch('linho', 4);
    await assentar();

    const [a, b] = getDataLayer();
    expect(a.context.anonymous_id).toBe(b.context.anonymous_id);
    expect(a.context.session_id).toBe(b.context.session_id);
  });

  it('preserva a campanha capturada na primeira página', async () => {
    sessionStorage.setItem(
      'lurds_attribution',
      JSON.stringify({ source: 'instagram', medium: 'cpc', campaign: 'inverno26' }),
    );

    trackViewItem(VESTIDO);
    await assentar();

    expect(getDataLayer()[0].context.attribution.campaign).toBe('inverno26');
  });
});
