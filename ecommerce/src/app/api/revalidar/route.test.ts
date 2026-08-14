import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A REGRESSÃO QUE ESTE TESTE GUARDA (13/08/2026).
 *
 * Esta rota ficou seis dias respondendo 503 em produção porque exigia uma env
 * NOVA (`REVALIDATE_SECRET`) que ninguém criou. Ninguém percebeu: o único
 * sintoma era o banner da retaguarda demorando até 1 hora pra aparecer no
 * site — que é exatamente o comportamento antigo, então parecia "normal".
 *
 * O conserto foi aceitar também o `LOJA_ORDER_TOKEN`, que JÁ está configurado
 * nos dois lados (é o segredo do checkout). Quem apagar esse fallback apaga a
 * atualização instantânea de novo, e em silêncio. Daí o teste.
 */

const revalidateTag = vi.fn();
vi.mock('next/cache', () => ({ revalidateTag: (t: string) => revalidateTag(t) }));

const ambiente = { ...process.env };

async function rota() {
  return import('./route');
}

function post(segredo?: string, tags?: string[]) {
  return new Request('http://site/api/revalidar', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(segredo ? { 'x-revalidate-secret': segredo } : {}),
    },
    body: JSON.stringify(tags ? { tags } : {}),
  });
}

beforeEach(() => {
  revalidateTag.mockClear();
  vi.resetModules();
  delete process.env.REVALIDATE_SECRET;
  delete process.env.LOJA_ORDER_TOKEN;
});

afterEach(() => {
  process.env = { ...ambiente };
});

describe('POST /api/revalidar', () => {
  it('recusa tudo quando nenhum segredo está configurado', async () => {
    const { POST } = await rota();
    const r = await POST(post('qualquer-coisa'));
    expect(r.status).toBe(503);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('aceita o LOJA_ORDER_TOKEN — o segredo que já existe nos dois lados', async () => {
    process.env.LOJA_ORDER_TOKEN = 'token-do-checkout';
    const { POST } = await rota();
    const r = await POST(post('token-do-checkout', ['banners', 'banners:lojas-hero']));
    expect(r.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith('banners');
    expect(revalidateTag).toHaveBeenCalledWith('banners:lojas-hero');
  });

  it('aceita o REVALIDATE_SECRET quando alguém quiser separar os dois', async () => {
    process.env.REVALIDATE_SECRET = 'so-pra-cache';
    process.env.LOJA_ORDER_TOKEN = 'token-do-checkout';
    const { POST } = await rota();
    expect((await POST(post('so-pra-cache'))).status).toBe(200);
  });

  it('nega segredo errado mesmo com os dois configurados', async () => {
    process.env.REVALIDATE_SECRET = 'so-pra-cache';
    process.env.LOJA_ORDER_TOKEN = 'token-do-checkout';
    const { POST } = await rota();
    const r = await POST(post('chute'));
    expect(r.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('sem tags no corpo, derruba o cache de banners', async () => {
    process.env.LOJA_ORDER_TOKEN = 'token-do-checkout';
    const { POST } = await rota();
    await POST(post('token-do-checkout'));
    expect(revalidateTag).toHaveBeenCalledWith('banners');
  });
});

describe('GET /api/revalidar', () => {
  it('conta pra retaguarda que a atualização instantânea está de pé', async () => {
    process.env.LOJA_ORDER_TOKEN = 'token-do-checkout';
    const { GET } = await rota();
    await expect((await GET()).json()).resolves.toEqual({ ok: true, configurado: true });
  });

  it('e conta quando NÃO está — é este aviso que faltou em 07/08', async () => {
    const { GET } = await rota();
    await expect((await GET()).json()).resolves.toEqual({ ok: true, configurado: false });
  });
});
