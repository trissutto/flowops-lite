import { NextResponse } from 'next/server';

/**
 * BFF DA PEÇA — usado pelo Quick Add.
 *
 * A listagem devolve a peça resumida; pra adicionar à sacola sem sair da
 * página é preciso a grade REAL da cor escolhida (cada cor tem estoque
 * próprio). Este proxy entrega isso sem expor a API no bundle.
 *
 * SEM cache: é a grade com estoque que decide se o tamanho é clicável. O
 * revalidate serve stale primeiro (SWR) — com pouco tráfego o Quick Add
 * oferecia tamanho esgotado horas depois da venda (caso VOGUE VINHO 06/08).
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
      { cache: 'no-store' },
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
