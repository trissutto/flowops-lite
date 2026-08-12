import { NextResponse } from 'next/server';

/**
 * BFF DO LEAD — o popup do cupom de boas-vindas.
 *
 * Server-to-server como o resto: o backend só aceita as origens da
 * `FRONTEND_URL`, e assim nome/celular/e-mail não passam pelo bundle nem
 * dependem de CORS. Sem cache nenhum — é escrita.
 */

export const revalidate = 0;

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export async function POST(request: Request) {
  if (!BASE_URL) {
    console.error('[lead] FLOWOPS_API_URL não configurada');
    return NextResponse.json({ erro: 'indisponivel' }, { status: 503 });
  }

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: 'corpo invalido' }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${BASE_URL}/public/loja/lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
      cache: 'no-store',
    });
    const dados = await upstream.json().catch(() => ({}));
    // O 400 do backend carrega a mensagem que a cliente lê ("Confira o
    // celular com DDD") — repassar o status deixa o popup dizer o que houve.
    return NextResponse.json(dados, { status: upstream.status });
  } catch (error) {
    console.error('[lead] cadastro falhou:', error);
    return NextResponse.json({ erro: 'falha' }, { status: 502 });
  }
}
