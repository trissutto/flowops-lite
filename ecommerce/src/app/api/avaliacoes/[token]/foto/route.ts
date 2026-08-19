import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';

/**
 * O ENDEREÇO PRA MANDAR A FOTO.
 *
 * O arquivo NÃO passa por aqui nem pelo backend: esta rota só pede ao FlowOps
 * um endereço de upload direto do Cloudflare Images, e o navegador manda a foto
 * pra lá. Foto de celular tem 3–8 MB e a Vercel cobra por tempo de função —
 * empurrar bytes de graça pelo caminho mais caro seria pagar duas vezes pra
 * fazer pior.
 *
 * O endereço vale 15 minutos e carrega, na metadata, a qual CONVITE pertence.
 * É por isso que o backend consegue recusar uma foto que veio de outro pedido.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'Link inválido.' }, { status: 400 });
  }

  let filename = 'foto.jpg';
  try {
    const corpo = (await req.json()) as { filename?: string };
    if (corpo?.filename) filename = String(corpo.filename).slice(0, 120);
  } catch {
    /* sem nome é aceitável — o Cloudflare só usa pra exibição */
  }

  try {
    const r = await api<{ id: string; uploadURL: string }>(
      `/public/avaliacoes/convite/${encodeURIComponent(token)}/foto`,
      { method: 'POST', body: { filename }, timeoutMs: 15000 },
    );
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json(
        { ok: false, error: e.mensagemDoBackend ?? 'Não consegui preparar o envio da foto.' },
        { status: e.status === 400 || e.status === 404 ? e.status : 502 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Não consegui preparar o envio da foto.' },
      { status: 502 },
    );
  }
}
