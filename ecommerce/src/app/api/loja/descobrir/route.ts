import { NextResponse } from 'next/server';

/**
 * BFF DO FEED DE DESCOBERTA — a continuação da página do produto.
 *
 * O backend devolve o catálogo inteiro em UMA sequência que começa na
 * subcategoria da peça aberta (ver `LojaCatalogService.descobrir`); aqui só
 * repassamos a página pedida, server-to-server, como no resto do catálogo.
 *
 * `revalidate: 60` igual ao da listagem: a sequência é derivada do mesmo
 * catálogo, e cachear diferente faria a mesma peça ter dois preços na mesma
 * tela.
 */

export const revalidate = 0;

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function GET(request: Request) {
  if (!BASE_URL) {
    console.error('[loja] FLOWOPS_API_URL não configurada — feed indisponível');
    return NextResponse.json({ itens: [], total: 0, erro: 'indisponivel' }, { status: 503 });
  }

  const url = new URL(request.url);
  const slug = (url.searchParams.get('slug') ?? '').trim();
  if (!slug) {
    return NextResponse.json({ itens: [], total: 0, erro: 'slug obrigatorio' }, { status: 400 });
  }

  const params = new URLSearchParams({
    page: url.searchParams.get('page') ?? '1',
    perPage: url.searchParams.get('perPage') ?? '12',
  });
  const alvo = `${BASE_URL}/public/loja/produto/${encodeURIComponent(slug)}/descobrir?${params}`;

  try {
    const upstream = await fetch(alvo, { next: { revalidate: 60 } });
    if (!upstream.ok) {
      return NextResponse.json({ itens: [], total: 0, erro: 'falha' }, { status: 502 });
    }
    return NextResponse.json(await upstream.json());
  } catch (error) {
    console.error('[loja] feed de descoberta falhou:', error);
    return NextResponse.json({ itens: [], total: 0, erro: 'falha' }, { status: 502 });
  }
}
