import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock, ApiErrorFalso } = vi.hoisted(() => {
  class ApiErrorFalso extends Error {
    constructor(message: string, readonly status: number, readonly path: string) {
      super(message);
    }
  }
  return { apiMock: vi.fn(), ApiErrorFalso };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({ api: apiMock, ApiError: ApiErrorFalso }));

import { CACHE_DO_FEED, comSegundaChance, feedIndisponivel, lerListaDoBackend, respostaDoFeed } from './leitura';

beforeEach(() => {
  apiMock.mockReset();
  vi.useRealTimers();
});

describe('leitura do feed — sempre fresca, com segunda chance', () => {
  it('lê SEM Data Cache: é o que faz o leitor diário receber o dado de hoje', async () => {
    apiMock.mockResolvedValue([{ ref: '8493' }]);
    await expect(lerListaDoBackend('/public/loja/feed')).resolves.toEqual([{ ref: '8493' }]);
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0][0]).toBe('/public/loja/feed');
    expect(apiMock.mock.calls[0][1]).toMatchObject({ revalidate: 0 });
  });

  it('falha passageira (rede, 502 do restart) ganha uma segunda tentativa', async () => {
    vi.useFakeTimers();
    apiMock.mockRejectedValueOnce(new ApiErrorFalso('Backend respondeu 502', 502, '/x')).mockResolvedValueOnce([1, 2]);
    const lendo = lerListaDoBackend('/public/loja/feed-local');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(lendo).resolves.toEqual([1, 2]);
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it('4xx não é retentado: repetir o mesmo pedido errado só dobra a carga', async () => {
    apiMock.mockRejectedValue(new ApiErrorFalso('Backend respondeu 404', 404, '/x'));
    await expect(lerListaDoBackend('/public/loja/feed')).rejects.toMatchObject({ status: 404 });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it('duas falhas seguidas: o erro SOBE (quem chama responde 503)', async () => {
    vi.useFakeTimers();
    apiMock.mockRejectedValue(new Error('fetch failed'));
    const lendo = lerListaDoBackend('/public/loja/feed');
    const espera = expect(lendo).rejects.toThrow('fetch failed');
    await vi.advanceTimersByTimeAsync(2000);
    await espera;
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it('resposta que não é lista é erro, não "catálogo com zero peça"', async () => {
    apiMock.mockResolvedValue({ erro: 'pagina de proxy' });
    await expect(lerListaDoBackend('/public/loja/feed')).rejects.toThrow(/não é uma lista/);
    apiMock.mockResolvedValue(null);
    await expect(lerListaDoBackend('/public/loja/feed')).rejects.toThrow(/não é uma lista \(null\)/);
  });

  it('backend PENDURADO não segura a função pelo dobro do tempo: sem sobra, não retenta', async () => {
    vi.useFakeTimers();
    let chamadas = 0;
    const lendo = comSegundaChance(async () => {
      chamadas += 1;
      await new Promise((ok) => setTimeout(ok, 39_000));
      throw new Error('timeout');
    });
    const espera = expect(lendo).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(45_000);
    await espera;
    expect(chamadas).toBe(1);
  });
});

describe('respostas do feed', () => {
  it('a boa é guardada por pouco tempo — leitor diário sempre cai fora da janela', () => {
    const r = respostaDoFeed('<rss/>');
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toContain('application/xml');
    expect(r.headers.get('Cache-Control')).toBe(CACHE_DO_FEED);
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(CACHE_DO_FEED)?.[1]);
    const swr = Number(/stale-while-revalidate=(\d+)/.exec(CACHE_DO_FEED)?.[1]);
    // A soma é o tempo máximo que uma cópia pode ser servida: bem menos que 24 h.
    expect(sMaxAge + swr).toBeLessThanOrEqual(3600);
  });

  it('a de falha é 503 sem cache — nunca feed vazio com 200', async () => {
    const r = feedIndisponivel();
    expect(r.status).toBe(503);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await r.text()).not.toContain('<rss');
  });
});
