import { NextResponse } from 'next/server';
import { comoCliente } from '@/lib/conta';

/**
 * ENDEREÇOS DA CLIENTE — espelho do que o app já usa (/customers/app/addresses).
 * Sem sessão devolve 401 limpo: a tela mostra o login em vez de lista vazia.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const lista = await comoCliente<unknown[]>('/customers/app/addresses');
    if (lista === null) return NextResponse.json({ erro: 'sem sessao' }, { status: 401 });
    return NextResponse.json(lista);
  } catch (e) {
    console.error('[conta] endereços:', e);
    return NextResponse.json({ erro: 'indisponivel' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const criado = await comoCliente('/customers/app/addresses', { method: 'POST', body });
    if (criado === null) return NextResponse.json({ erro: 'sem sessao' }, { status: 401 });
    return NextResponse.json(criado, { status: 201 });
  } catch (e) {
    console.error('[conta] novo endereço:', e);
    return NextResponse.json({ erro: 'Não consegui salvar o endereço.' }, { status: 502 });
  }
}
