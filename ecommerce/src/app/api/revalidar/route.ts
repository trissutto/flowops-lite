import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

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
 * ── POR QUE O SEGREDO TEM DOIS NOMES (13/08/2026) ──
 *
 * Este endpoint nasceu exigindo `REVALIDATE_SECRET`, uma env NOVA que tinha que
 * ser criada nos DOIS projetos (Vercel e Railway). Ninguém criou. Resultado: a
 * rota respondeu 503 "revalidação não configurada" por seis dias e TODO save da
 * retaguarda voltou a esperar a hora do ISR — exatamente a queixa que o
 * mecanismo existia pra matar ("demorando muito pra atualizar banner").
 *
 * Segredo que precisa de setup manual pra funcionar é segredo que fica
 * desligado. Então o fallback é o `LOJA_ORDER_TOKEN`: o MESMO segredo
 * compartilhado que o site já usa pra falar com o backend (checkout, config,
 * frete). Se o checkout funciona, a revalidação funciona — sem env nova,
 * sem passo manual, sem esquecer.
 *
 * `REVALIDATE_SECRET` continua valendo e tem prioridade, pra quem quiser
 * separar os dois segredos depois.
 *
 * Não existe modo aberto: sem NENHUM dos dois, a rota recusa tudo. Qualquer um
 * derrubando o cache de fora é um jeito barato de derrubar o site.
 */

export const runtime = 'nodejs';
/**
 * Sem isto o Next assa o GET no build: trocar a env depois deixaria o
 * diagnóstico respondendo o que era verdade no dia do deploy — justamente o
 * tipo de mentira que esta rota existe pra evitar.
 */
export const dynamic = 'force-dynamic';

/** Ordem de prioridade: o específico primeiro, o compartilhado como rede. */
function segredosAceitos(): string[] {
  return [process.env.REVALIDATE_SECRET, process.env.LOJA_ORDER_TOKEN]
    .map((s) => (s || '').trim())
    .filter(Boolean);
}

/** Comparação em tempo constante — mesmo padrão do `x-loja-token` no backend. */
function confere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * DIAGNÓSTICO — a retaguarda pergunta "o site atualiza na hora?" e mostra o
 * resultado na tela de banners. Sem isto a única forma de descobrir que a
 * revalidação está desligada é a que já aconteceu: o dono reclamar.
 *
 * Só devolve SE está configurado, nunca o segredo nem qual dos dois é.
 */
export async function GET() {
  return NextResponse.json({ ok: true, configurado: segredosAceitos().length > 0 });
}

export async function POST(req: Request) {
  const aceitos = segredosAceitos();
  if (!aceitos.length) {
    return NextResponse.json({ ok: false, erro: 'revalidação não configurada' }, { status: 503 });
  }

  const enviado = req.headers.get('x-revalidate-secret') || '';
  if (!enviado || !aceitos.some((s) => confere(enviado, s))) {
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
