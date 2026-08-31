import { NextResponse } from 'next/server';
import { getBlocosDaHome } from '@/services/vitrines-home';

export const dynamic = 'force-static';
export const revalidate = 60;

/** Conteúdo abaixo da primeira prateleira, cacheado junto com o catálogo. */
export async function GET() {
  const blocos = await getBlocosDaHome();
  return NextResponse.json(
    { carrosseis: blocos.carrosseis.slice(1) },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
  );
}
