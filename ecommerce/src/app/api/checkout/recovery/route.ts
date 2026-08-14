import { NextResponse } from 'next/server';

export const revalidate = 0;
const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function POST(request: Request) {
  if (!BASE_URL) return NextResponse.json({ ok: false }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
  try {
    const upstream = await fetch(`${BASE_URL}/public/loja/checkout-recovery`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
    return NextResponse.json(await upstream.json().catch(() => ({ ok: false })), { status: upstream.status });
  } catch {
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}
