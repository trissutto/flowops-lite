import { NextResponse } from 'next/server';
import { ApiError } from '@/lib/api';
import { comoCliente } from '@/lib/conta';

/**
 * RESGATE DE PONTOS — pontos viram cupom nominal.
 *
 * Passa por `comoCliente` de propósito: o token da sessão mora num cookie
 * httpOnly e é o backend quem descobre DE QUEM é o saldo pelo JWT. O corpo
 * carrega só quantos pontos ela quer trocar — CPF vindo do navegador seria um
 * campo que qualquer um edita pra gastar o saldo de outra pessoa.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let pontos = 0;
  try {
    const corpo = (await request.json()) as { pontos?: number };
    pontos = Math.trunc(Number(corpo?.pontos) || 0);
  } catch {
    return NextResponse.json({ ok: false, erro: 'Requisição inválida.' }, { status: 400 });
  }
  if (pontos <= 0) {
    return NextResponse.json({ ok: false, erro: 'Escolha quantos pontos trocar.' }, { status: 400 });
  }

  try {
    const r = await comoCliente<unknown>('/me/pontos/resgatar', {
      method: 'POST',
      body: { pontos },
    });
    // `null` = sem sessão (ou expirada). A tela manda pro login em vez de
    // mostrar um erro que não explica nada.
    if (r === null) {
      return NextResponse.json({ ok: false, erro: 'Entra na sua conta pra resgatar.' }, { status: 401 });
    }
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json(
        { ok: false, erro: e.mensagemDoBackend ?? 'Não consegui gerar seu cupom.' },
        { status: e.status === 400 ? 400 : 502 },
      );
    }
    return NextResponse.json({ ok: false, erro: 'Não consegui gerar seu cupom.' }, { status: 502 });
  }
}
