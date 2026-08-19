import { NextResponse } from 'next/server';

/**
 * FOTO DA AVALIAÇÃO PELO LINK — mesma coisa da rota da conta, com a
 * credencial trocada: aqui quem prova quem ela é é o TOKEN do convite.
 *
 * Não usa o helper `api()` de propósito: ele serializa JSON, e aqui o corpo é
 * multipart. O `FormData` é remontado e o Content-Type fica por conta do
 * fetch — escrever o header na mão apaga o `boundary` e o upload falha em
 * silêncio (pegadinha já paga uma vez neste repo).
 */

export const dynamic = 'force-dynamic';

/** Teto do lado de cá também: o backend recusa, mas nem vale subir 20MB pra ouvir não. */
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!token) return NextResponse.json({ erro: 'Link inválido.' }, { status: 400 });

  const base = process.env.FLOWOPS_API_URL?.replace(/\/$/, '');
  if (!base) {
    console.error('[avaliar] foto: FLOWOPS_API_URL não configurada');
    return NextResponse.json({ erro: 'Envio indisponível.' }, { status: 503 });
  }

  let arquivo: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get('file');
    if (f instanceof File) arquivo = f;
  } catch {
    return NextResponse.json({ erro: 'Requisição inválida.' }, { status: 400 });
  }
  if (!arquivo) return NextResponse.json({ erro: 'Escolha uma foto.' }, { status: 400 });
  if (arquivo.size > MAX_BYTES) {
    return NextResponse.json({ erro: 'A foto é grande demais (máximo 8 MB).' }, { status: 400 });
  }

  try {
    const corpo = new FormData();
    corpo.append('file', arquivo, arquivo.name || 'foto.jpg');

    const res = await fetch(`${base}/public/avaliar/${encodeURIComponent(token)}/foto`, {
      method: 'POST',
      body: corpo,
      cache: 'no-store',
      // Foto de celular sobe devagar no 4G da rua: timeout curto derrubaria
      // upload que ia dar certo.
      signal: AbortSignal.timeout(30_000),
    });
    const dados = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { erro: dados?.message || 'Não consegui enviar a foto.' },
        { status: res.status },
      );
    }
    return NextResponse.json(dados);
  } catch (e) {
    console.error('[avaliar] foto:', e);
    return NextResponse.json({ erro: 'Não consegui enviar a foto.' }, { status: 502 });
  }
}
