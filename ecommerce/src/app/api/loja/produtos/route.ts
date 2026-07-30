import { NextResponse } from 'next/server';

/**
 * BFF DO CATÁLOGO (sprint 008) — listagem de produtos do ERP.
 *
 * A listagem é client-side (react-query, scroll infinito), e o backend só
 * aceita as origens da `FRONTEND_URL`. Então a chamada passa por aqui:
 * server-to-server, sem CORS e sem expor a API no bundle.
 *
 * Cache curto no edge: preço e estoque vêm do ERP e mudam a cada venda —
 * 60s é o equilíbrio entre não martelar o backend e não mostrar peça
 * esgotada. O detalhe do produto (ISR) tem revalidação própria.
 */

export const revalidate = 0;

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function GET(request: Request) {
  if (!BASE_URL) {
    console.error('[loja] FLOWOPS_API_URL não configurada — catálogo indisponível');
    return NextResponse.json({ itens: [], total: 0, erro: 'indisponivel' }, { status: 503 });
  }

  const url = new URL(request.url);
  const alvo = `${BASE_URL}/public/loja/produtos?${url.searchParams.toString()}`;

  try {
    const upstream = await fetch(alvo, { next: { revalidate: 60 } });
    if (!upstream.ok) {
      return NextResponse.json({ itens: [], total: 0, erro: 'falha' }, { status: 502 });
    }
    return NextResponse.json(await upstream.json());
  } catch (error) {
    console.error('[loja] listagem falhou:', error);
    return NextResponse.json({ itens: [], total: 0, erro: 'falha' }, { status: 502 });
  }
}
