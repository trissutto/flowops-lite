import { NextResponse } from 'next/server';

/**
 * BFF DAS FACETAS (sprint 008) — os filtros são GERADOS do catálogo real.
 *
 * Nada de lista fixa no front: cor, tamanho, marca e categoria saem do que
 * existe publicado E com estoque. Filtro que leva a zero resultado é pior
 * que filtro que não existe.
 *
 * Facetas mudam devagar (o backend já cacheia 10 min) — 5 min aqui evita
 * ida ao backend a cada abertura da sidebar.
 */

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function GET() {
  if (!BASE_URL) return NextResponse.json({ erro: 'indisponivel' }, { status: 503 });
  try {
    const upstream = await fetch(`${BASE_URL}/public/loja/filtros`, { next: { revalidate: 300 } });
    if (!upstream.ok) return NextResponse.json({ erro: 'falha' }, { status: 502 });
    return NextResponse.json(await upstream.json());
  } catch (error) {
    console.error('[loja] facetas falharam:', error);
    return NextResponse.json({ erro: 'falha' }, { status: 502 });
  }
}
