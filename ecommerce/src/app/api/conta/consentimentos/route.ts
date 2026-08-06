import { NextResponse } from 'next/server';
import { comoCliente } from '@/lib/conta';

/**
 * CONSENTIMENTO LGPD — o que a cliente autorizou receber (item 67).
 *
 * A tabela `customer_consents` existe no CRM desde sempre e é append-only,
 * mas o site nunca leu nem escreveu nela: a cliente não tinha como ver — nem
 * mudar — o que autorizou. Isso é exigência da lei, não recurso.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const dados = await comoCliente<unknown>('/customers/app/consents');
    if (dados === null) return NextResponse.json({ erro: 'sem sessao' }, { status: 401 });
    return NextResponse.json(dados);
  } catch (e) {
    console.error('[conta] consentimentos:', e);
    return NextResponse.json({ erro: 'indisponivel' }, { status: 502 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const dados = await comoCliente('/customers/app/consents', { method: 'POST', body });
    if (dados === null) return NextResponse.json({ erro: 'sem sessao' }, { status: 401 });
    return NextResponse.json(dados);
  } catch (e) {
    console.error('[conta] salvar consentimento:', e);
    return NextResponse.json({ erro: 'Não consegui salvar sua preferência.' }, { status: 502 });
  }
}
