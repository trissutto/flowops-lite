/**
 * POST /api/checkout/sacola — guarda a sacola COM DONA (dono, 14/08).
 *
 * O que esta rota resolve: o `add_to_cart` que a gente grava é anônimo (só
 * `session_id`), e o pedido só nasce no submit do checkout inteiro. Quem
 * digitava nome e celular e desistia no frete não sobrava em lugar nenhum —
 * e é justamente a cliente mais quente que existe.
 *
 * Aqui é só o BFF: carrega o `x-loja-token` (que NUNCA pode ir pro navegador)
 * e repassa. Quem grava é o backend (`POST /public/loja/sacola`), que também
 * carimba a sacola como convertida quando o pedido nasce.
 *
 * SEMPRE 200 `{ ok }`: o checkout chama isto em segundo plano. Backend fora do
 * ar, env faltando, timeout — nada disso pode virar erro na tela de quem está
 * comprando. A compra segue; o que se perde é a chance de recuperação.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Curto de propósito: é escrita de métrica, não caminho da venda. */
const TIMEOUT_MS = 5_000;

/** IP real da cliente — o backend limita por pessoa, não pela Vercel inteira. */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() || '';
}

export async function POST(req: Request) {
  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  if (!baseUrl || !token) return NextResponse.json({ ok: false }, { status: 200 });

  const ip = clientIp(req);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/loja/sacola`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-loja-token': token,
        ...(ip ? { 'x-cliente-ip': ip } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    const dados = await res.json().catch(() => null);
    return NextResponse.json({ ok: Boolean(dados?.ok) }, { status: 200 });
  } catch (err) {
    const motivo = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'rede';
    console.warn(`[sacola] backend não respondeu (${motivo}) — sacola não foi guardada`);
    return NextResponse.json({ ok: false }, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}
