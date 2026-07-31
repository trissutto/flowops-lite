import { NextResponse } from 'next/server';

/**
 * BFF DE RELACIONADOS (sprint 008) — produtos relacionados a uma peça.
 *
 * Mesmo desenho do BFF de listagem: o rail é client-side e o backend só
 * aceita as origens da `FRONTEND_URL`. A chamada passa por aqui —
 * server-to-server, sem CORS e sem expor a API no bundle.
 *
 * Cache curto no edge: relacionados dependem de estoque, que muda a cada
 * venda — 60s é o equilíbrio entre não martelar o backend e não recomendar
 * peça esgotada.
 */

export const revalidate = 0;

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function GET(request: Request) {
  if (!BASE_URL) {
    console.error('[loja] FLOWOPS_API_URL não configurada — relacionados indisponíveis');
    return NextResponse.json({ itens: [], erro: 'indisponivel' }, { status: 503 });
  }

  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  // Sem slug não há seed — 400 explícito é melhor que repassar lixo pro backend.
  if (!slug) {
    return NextResponse.json({ itens: [], erro: 'slug obrigatório' }, { status: 400 });
  }
  const limite = url.searchParams.get('limite') ?? '8';

  const alvo = `${BASE_URL}/public/loja/produto/${encodeURIComponent(slug)}/relacionados?limite=${encodeURIComponent(limite)}`;

  try {
    const upstream = await fetch(alvo, { next: { revalidate: 60 } });
    if (!upstream.ok) {
      return NextResponse.json({ itens: [], erro: 'falha' }, { status: 502 });
    }
    return NextResponse.json(await upstream.json());
  } catch (error) {
    console.error('[loja] relacionados falhou:', error);
    return NextResponse.json({ itens: [], erro: 'falha' }, { status: 502 });
  }
}
