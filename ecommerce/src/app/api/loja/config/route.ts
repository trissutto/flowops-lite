/**
 * GET /api/loja/config — a régua comercial pro navegador.
 *
 * Existe pela barra de frete grátis (item 57): ela aparece na sacola antes de
 * existir CEP, então não pode depender da cotação. Enquanto lia a constante do
 * código, mudar o mínimo na retaguarda deixava a barra prometendo o valor
 * velho — ou seja, prometendo frete grátis que o checkout não daria.
 *
 * Cacheado por 5 min na borda: é config, não preço. Backend fora do ar devolve
 * `ok:false` e o site cai na constante local.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const revalidate = 300;

const TIMEOUT_MS = 6_000;

export async function GET() {
  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  if (!baseUrl || !token) {
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/loja/config`, {
      headers: { Accept: 'application/json', 'x-loja-token': token },
      signal: controller.signal,
      next: { revalidate: 300 },
    });
    const dados = await res.json().catch(() => null);
    if (!res.ok || !dados?.ok) return NextResponse.json({ ok: false }, { status: 200 });
    return NextResponse.json(dados, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}
