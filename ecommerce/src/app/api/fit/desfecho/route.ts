import { NextResponse } from 'next/server';

/**
 * BFF do LURDS FIT AI — desfecho da recomendação.
 *
 * É o que fecha o ciclo de aprendizado: a cliente aceitou o tamanho sugerido
 * e levou pra sacola. Sem isso o sistema recomenda pra sempre no escuro.
 * Chamada "fire and forget" do cliente — nunca bloqueia a compra.
 */

export const dynamic = 'force-dynamic';

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function POST(request: Request) {
  if (!BASE_URL) return NextResponse.json({ ok: false }, { status: 503 });

  try {
    const body = await request.json();
    const upstream = await fetch(`${BASE_URL}/public/fit/desfecho`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for':
          request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? '',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    return NextResponse.json(await upstream.json().catch(() => ({ ok: upstream.ok })));
  } catch (error) {
    console.error('[fit] desfecho falhou:', error);
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}
