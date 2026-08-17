import { describe, it, expect, vi, afterEach } from 'vitest';
import { coordenadaDoCep, pickupStoresFor, quoteShipping } from './frete';

const CEP = '11746692'; // Itanhaem, loja a 4,5 km

function mockCep(body: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('coordenadaDoCep com lat/lng degenerado', () => {
  it('lat/lng normais -> ponto real', async () => {
    mockCep({ lat: '-24.1830', lng: '-46.7900' });
    expect(await coordenadaDoCep(CEP)).toEqual({ lat: -24.183, lng: -46.79 });
  });

  it('lat/lng AUSENTES -> null (coberto)', async () => {
    mockCep({ city: 'Itanhaem' });
    expect(await coordenadaDoCep(CEP)).toBeNull();
  });

  it('lat/lng STRING VAZIA -> deveria ser null, devolve (0,0)', async () => {
    mockCep({ lat: '', lng: '' });
    expect(await coordenadaDoCep(CEP)).toEqual({ lat: 0, lng: 0 });
  });

  it('lat/lng NULL -> deveria ser null, devolve (0,0)', async () => {
    mockCep({ lat: null, lng: null });
    expect(await coordenadaDoCep(CEP)).toEqual({ lat: 0, lng: 0 });
  });

  it('HTTP nao-ok (429 QuotaExceeded) -> null (coberto)', async () => {
    mockCep({ status: 429, code: 'QuotaExceeded' }, false);
    expect(await coordenadaDoCep(CEP)).toBeNull();
  });
});

describe('efeito na lista de retirada', () => {
  it('coord null -> tabela de prefixos oferece Itanhaem', () => {
    const r = pickupStoresFor(CEP, 3, null).map((q) => q.storeSlug);
    expect(r).toContain('itanhaem');
  });

  it('coord real -> raio oferece Itanhaem', () => {
    const r = pickupStoresFor(CEP, 3, { lat: -24.183, lng: -46.79 }).map((q) => q.storeSlug);
    expect(r).toContain('itanhaem');
  });

  it('coord (0,0) -> NENHUMA retirada e prefixo nao consultado', () => {
    const r = pickupStoresFor(CEP, 3, { lat: 0, lng: 0 });
    expect(r).toEqual([]);
  });

  it('quoteShipping com (0,0) perde a retirada mas mantem PAC/SEDEX', () => {
    const comCoord = quoteShipping(CEP, 200, { lat: 0, lng: 0 }).map((q) => q.id);
    const semCoord = quoteShipping(CEP, 200, null).map((q) => q.id);
    expect(semCoord).toContain('retirada-itanhaem');
    expect(comCoord).not.toContain('retirada-itanhaem');
    expect(comCoord).toEqual(['correios-pac', 'correios-sedex']);
  });
});
