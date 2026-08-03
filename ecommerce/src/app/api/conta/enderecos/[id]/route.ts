import { NextResponse } from 'next/server';
import { comoCliente } from '@/lib/conta';

/** Editar e apagar um endereço da cliente logada. */

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const salvo = await comoCliente(`/customers/app/addresses/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    });
    if (salvo === null) return NextResponse.json({ erro: 'sem sessao' }, { status: 401 });
    return NextResponse.json(salvo);
  } catch (e) {
    console.error('[conta] editar endereço:', e);
    return NextResponse.json({ erro: 'Não consegui salvar.' }, { status: 502 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const r = await comoCliente(`/customers/app/addresses/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (r === null) return NextResponse.json({ erro: 'sem sessao' }, { status: 401 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[conta] apagar endereço:', e);
    return NextResponse.json({ erro: 'Não consegui apagar.' }, { status: 502 });
  }
}
