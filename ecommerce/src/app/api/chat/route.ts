import { NextResponse } from 'next/server';
import { lerToken } from '@/lib/conta';

/**
 * BFF DA ASSISTENTE.
 *
 * Existe por um motivo específico: o token da cliente vive num cookie
 * httpOnly, que o JavaScript da página não alcança (de propósito — ver
 * lib/conta.ts). Só o servidor pode lê-lo e repassar pro backend, e é isso que
 * permite a assistente responder "cadê meu pedido" sem a cliente digitar nada.
 *
 * Cliente deslogada segue conversando normalmente, sem a parte de pedidos.
 */

export const dynamic = 'force-dynamic';

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function POST(request: Request) {
  if (!BASE_URL) {
    return NextResponse.json({ erro: 'indisponivel' }, { status: 503 });
  }

  let corpo: Record<string, unknown>;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: 'Requisição inválida.' }, { status: 400 });
  }

  const token = await lerToken();

  try {
    const upstream = await fetch(`${BASE_URL}/public/loja/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-cliente-token': token } : {}),
      },
      body: JSON.stringify(corpo),
      cache: 'no-store',
    });

    const dados = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return NextResponse.json(
        { erro: dados?.message || 'Não consegui responder agora.' },
        { status: upstream.status },
      );
    }
    return NextResponse.json(dados);
  } catch (e) {
    console.error('[chat] falhou:', e);
    return NextResponse.json({ erro: 'Não consegui responder agora.' }, { status: 502 });
  }
}
