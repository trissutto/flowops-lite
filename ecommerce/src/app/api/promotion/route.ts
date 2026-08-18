import { NextResponse } from 'next/server';
import { getPublicPromotion } from '@/services/promotion';

export async function GET() {
  return NextResponse.json(await getPublicPromotion(), {
    headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
  });
}
