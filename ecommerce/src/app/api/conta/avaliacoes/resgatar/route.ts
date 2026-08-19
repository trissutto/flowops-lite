import { NextResponse } from 'next/server';
import { comoCliente } from '@/lib/conta';
import { ApiError } from '@/lib/api';

/**
 * TROCAR PONTOS POR DESCONTO.
 *
 * O corpo carrega só QUANTOS pontos — de quem é o saldo, quem diz é o token da
 * sessão (cookie httpOnly, lido no servidor). CPF vindo do navegador seria um
 * campo que qualquer um edita pra gastar o saldo de outra pessoa.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let pontos = 0;
  try {
    const corpo = (await request.json()) as { pontos?: number };
    pontos = Math.trunc(Number(corpo?.pontos) || 0);
  } catch {
    return NextResponse.json({ erro: 'Requisição inválida.' }, { status: 400 });
  }
  if (pontos <= 0) {
    return NextResponse.json({ erro: 'Escolha quantos pontos trocar.' }, { status: 400 });
  }

  try {
    const dados = await comoCliente('/customers/app/avaliacoes/resgatar', {
      method: 'POST',
      body: { pontos },
    });
    if (dados === null) return NextResponse.json({ erro: 'sem sessao' }, { status: 401 });
    return NextResponse.json(dados);
  } catch (e) {
    // O 400 do backend traz frase pronta ("o resgate mínimo é de 500 pontos").
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
      return NextResponse.json(
        { erro: e.mensagemDoBackend || 'Não consegui gerar seu cupom.' },
        { status: e.status },
      );
    }
    console.error('[conta] resgate de pontos:', e);
    return NextResponse.json({ erro: 'Não consegui gerar seu cupom.' }, { status: 502 });
  }
}
