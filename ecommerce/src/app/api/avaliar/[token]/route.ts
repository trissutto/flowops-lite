import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/**
 * ENVIAR AVALIAÇÃO PELO LINK DO WHATSAPP.
 *
 * Gêmea de `/api/conta/avaliacoes`, com uma diferença só: lá quem prova a
 * identidade é o cookie da sessão; aqui é o TOKEN do convite, que vem no
 * caminho. O resto — prazo, direito à peça, quanto vale em pontos — continua
 * sendo decidido pelo backend. Repetir regra aqui criaria uma segunda verdade
 * pra divergir da primeira.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token) return NextResponse.json({ erro: 'Link inválido.' }, { status: 400 });

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: 'Requisição inválida.' }, { status: 400 });
  }

  try {
    const dados = await api(`/public/avaliar/${encodeURIComponent(token)}`, {
      method: 'POST',
      body: corpo,
      timeoutMs: 15000,
    });
    return NextResponse.json(dados);
  } catch (e) {
    // O backend escreve mensagem PRONTA PRA CLIENTE ("este link expirou",
    // "esta peça ainda não pode ser avaliada") — trocar por um texto genérico
    // aqui piora o que já estava certo lá.
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
      return NextResponse.json(
        { erro: e.mensagemDoBackend || 'Não consegui enviar sua avaliação.' },
        { status: e.status },
      );
    }
    console.error('[avaliar] envio:', e);
    return NextResponse.json({ erro: 'Não consegui enviar sua avaliação.' }, { status: 502 });
  }
}
