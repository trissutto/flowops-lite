import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

/**
 * O SITE ATUALIZA NA HORA (dono 07/08).
 *
 * A vitrine guarda as páginas prontas por 1 hora (ISR) — ótimo pra velocidade,
 * péssimo pra campanha: o dono publicava o banner na retaguarda, abria o site e
 * via o hero antigo, sem nada explicando que era cache. Ele mexia de novo,
 * achando que não tinha salvo. Era o "fiz e não funcionou" clássico.
 *
 * Agora a retaguarda avisa: gravou banner → chama aqui → a tag cai e a próxima
 * visita já monta a página nova.
 *
 * Segredo compartilhado (REVALIDATE_SECRET nos dois lados). Sem ele
 * configurado, a rota recusa tudo — não existe modo aberto: qualquer um
 * derrubando o cache de fora é um jeito barato de derrubar o site.
 */
export async function POST(req: Request) {
  const segredo = process.env.REVALIDATE_SECRET;
  if (!segredo) {
    return NextResponse.json({ ok: false, erro: 'revalidação não configurada' }, { status: 503 });
  }
  if (req.headers.get('x-revalidate-secret') !== segredo) {
    return NextResponse.json({ ok: false, erro: 'não autorizado' }, { status: 401 });
  }

  let tags: string[] = [];
  try {
    const corpo = await req.json();
    tags = Array.isArray(corpo?.tags) ? corpo.tags.filter((t: unknown) => typeof t === 'string') : [];
  } catch {
    tags = [];
  }
  if (!tags.length) tags = ['banners'];

  for (const t of tags.slice(0, 20)) revalidateTag(t);
  return NextResponse.json({ ok: true, tags });
}
