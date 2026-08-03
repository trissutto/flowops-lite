import { NextResponse } from 'next/server';

/**
 * BFF DA PEÇA — usado pelo Quick Add.
 *
 * A listagem devolve a peça resumida; pra adicionar à sacola sem sair da
 * página é preciso a grade REAL da cor escolhida (cada cor tem estoque
 * próprio). Este proxy entrega isso sem expor a API no bundle.
 *
 * Cache de 60s como o resto do catálogo: estoque muda a cada venda.
 */

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!BASE_URL) {
    return NextResponse.json({ erro: 'indisponivel' }, { status: 503 });
  }
  try {
    const upstream = await fetch(
      `${BASE_URL}/public/loja/produto/${encodeURIComponent(slug)}`,
      { next: { revalidate: 60 } },
    );
    if (!upstream.ok) {
      return NextResponse.json({ erro: 'nao-encontrado' }, { status: upstream.status });
    }
    return NextResponse.json(await upstream.json());
  } catch (error) {
    console.error('[loja] peça falhou:', error);
    return NextResponse.json({ erro: 'falha' }, { status: 502 });
  }
}
