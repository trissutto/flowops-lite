import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/**
 * BFF DA AVALIAÇÃO — o formulário do celular falando com o FlowOps.
 *
 * O `lib/api` é `server-only` (a URL do backend não pode ir pro bundle e o
 * backend só aceita as origens da lista de CORS), então o componente client
 * passa por aqui. O token vem do CAMINHO, nunca do corpo: é ele a credencial
 * da página, e mantê-lo num lugar só evita a versão em que o corpo diz um
 * pedido e a URL diz outro.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'Link inválido.' }, { status: 400 });
  }

  let corpo: Record<string, unknown> = {};
  try {
    corpo = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: 'Não recebi suas respostas.' }, { status: 400 });
  }

  try {
    const r = await api<unknown>(`/public/avaliacoes/convite/${encodeURIComponent(token)}`, {
      method: 'POST',
      body: corpo,
      timeoutMs: 15000,
    });
    return NextResponse.json(r);
  } catch (e) {
    // O backend escreve mensagem PRONTA PRA CLIENTE ("este link expirou").
    // Trocar por um texto genérico aqui piora o que já estava certo lá.
    if (e instanceof ApiError) {
      return NextResponse.json(
        { ok: false, error: e.mensagemDoBackend ?? 'Não consegui salvar sua avaliação.' },
        { status: e.status === 404 || e.status === 400 ? e.status : 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Não consegui salvar sua avaliação. Tenta de novo?' },
      { status: 502 },
    );
  }
}
