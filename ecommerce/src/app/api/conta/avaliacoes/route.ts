import { NextResponse } from 'next/server';
import { comoCliente } from '@/lib/conta';
import { ApiError } from '@/lib/api';

/**
 * ENVIAR AVALIAÇÃO — o formulário do centro de avaliação passa por aqui.
 *
 * O BFF não valida direito nenhum: quem confere se a peça é dela, se está no
 * prazo e quanto vale em pontos é o backend. Repetir a regra aqui só criaria
 * uma segunda verdade pra divergir da primeira.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: 'Requisição inválida.' }, { status: 400 });
  }

  try {
    const dados = await comoCliente('/customers/app/avaliacoes', { method: 'POST', body: corpo });
    if (dados === null) return NextResponse.json({ erro: 'sem sessao' }, { status: 401 });
    return NextResponse.json(dados);
  } catch (e) {
    // 400 do backend traz mensagem escrita PRA CLIENTE ("esta peça ainda não
    // pode ser avaliada") — trocá-la por um texto genérico piora a tela.
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
      return NextResponse.json(
        { erro: e.mensagemDoBackend || 'Não consegui enviar sua avaliação.' },
        { status: e.status },
      );
    }
    console.error('[conta] avaliacao:', e);
    return NextResponse.json({ erro: 'Não consegui enviar sua avaliação.' }, { status: 502 });
  }
}
