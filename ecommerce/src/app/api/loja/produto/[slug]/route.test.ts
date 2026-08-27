import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * O que este teste protege:
 *   1. soluço curto (o caso medido em 27/08) não chega na cliente;
 *   2. peça inexistente NÃO vira 3 batidas no backend;
 *   3. a grade continua vindo FRESCA — retry não pode virar cache.
 */

const carregarRota = async () => {
  vi.resetModules();
  process.env.FLOWOPS_API_URL = 'https://api.exemplo/api';
  return import('./route');
};

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const req = new Request('https://loja.exemplo/api/loja/produto/ref-1320');

const respostaOk = (corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
const respostaStatus = (status: number) => new Response('erro', { status });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('BFF da peça — retry', () => {
  it('primeira tentativa OK: uma chamada só', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respostaOk({ ref: '1320' }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await carregarRota();

    const r = await GET(req, params('ref-1320'));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ref: '1320' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('SOLUÇO DE REDE na 1ª, sucesso na 2ª — a cliente nem vê', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(respostaOk({ ref: '1320' }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await carregarRota();

    const r = await GET(req, params('ref-1320'));
    expect(r.status).toBe(200);           // ← era 502 antes do retry
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('502 do upstream (backend reiniciando) também é retentado', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respostaStatus(502))
      .mockResolvedValueOnce(respostaOk({ ref: '1320' }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await carregarRota();

    expect((await GET(req, params('ref-1320'))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('404 NÃO é retentado — peça que não existe continua não existindo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respostaStatus(404));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await carregarRota();

    const r = await GET(req, params('nao-existe'));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ erro: 'nao-encontrado' });
    expect(fetchMock).toHaveBeenCalledTimes(1);   // ← insistir seria bater à toa
  });

  it('queda longa (deploy): tenta 3x e devolve erro', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await carregarRota();

    const r = await GET(req, params('ref-1320'));
    expect(r.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a grade continua FRESCA — no-store em toda tentativa', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(respostaOk({ ref: '1320' }));
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await carregarRota();

    await GET(req, params('ref-1320'));
    for (const chamada of fetchMock.mock.calls) {
      expect(chamada[1].cache).toBe('no-store');   // nunca stale: é estoque
    }
  });

  it('sem FLOWOPS_API_URL responde 503 sem bater em ninguém', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    delete process.env.FLOWOPS_API_URL;
    const { GET } = await import('./route');

    expect((await GET(req, params('ref-1320'))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
