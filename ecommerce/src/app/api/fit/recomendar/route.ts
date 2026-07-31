import { NextResponse } from 'next/server';

/**
 * BFF do LURDS FIT AI — recomendação de tamanho.
 *
 * Por que existe (ver docs/architecture.md): `src/lib/api.ts` é server-only e
 * o backend só aceita as origens da env `FRONTEND_URL`. O assistente roda no
 * navegador, então a chamada passa por aqui: server-to-server, sem CORS e sem
 * expor a URL da API no bundle.
 *
 * Não cacheia: cada corpo é um corpo.
 */

export const dynamic = 'force-dynamic';

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function POST(request: Request) {
  if (!BASE_URL) {
    console.error('[fit] FLOWOPS_API_URL não configurada — assistente indisponível');
    return NextResponse.json({ error: 'indisponivel' }, { status: 503 });
  }

  try {
    const body = await request.json();
    const upstream = await fetch(`${BASE_URL}/public/fit/recomendar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Preserva o IP real da visitante pro rate-limit do backend
        'x-forwarded-for':
          request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? '',
      },
      body: JSON.stringify({ ...body, origem: 'ecommerce' }),
      cache: 'no-store',
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return NextResponse.json(
        { error: data?.message ?? 'falha' },
        { status: upstream.status === 403 ? 429 : 502 },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error('[fit] recomendar falhou:', error);
    return NextResponse.json({ error: 'falha' }, { status: 502 });
  }
}
