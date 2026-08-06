/**
 * POST /api/loja/frete — BFF da cotação.
 *
 * A regra de frete deixou de morar no site (bloco B da lista de lançamento):
 * tabela promocional, cotação do contrato, régua do frete grátis e dias de
 * separação são cadastro no FlowOps, editáveis na retaguarda sem deploy. Esta
 * rota só carrega o `x-loja-token` (que NUNCA pode ir pro navegador) e traduz
 * a resposta.
 *
 * Sem backend configurado ou fora do ar, devolve `ok:false` — quem chama
 * (`quoteShipping`) cai na tabela local, que continua existindo só pra isso.
 * Checkout parado por causa de cotação é pior que frete aproximado.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** O backend cria a cobrança; aqui é só leitura, então timeout curto. */
const TIMEOUT_MS = 9_000;

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Requisição inválida.' }, { status: 400 });
  }

  const cep = String(body?.cep || '').replace(/\D/g, '');
  if (cep.length !== 8) {
    return NextResponse.json({ ok: false, error: 'CEP inválido.' }, { status: 400 });
  }

  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  if (!baseUrl || !token) {
    console.warn('[frete] FLOWOPS_API_URL/LOJA_ORDER_TOKEN ausentes — site cai na tabela local');
    return NextResponse.json({ ok: false, error: 'indisponivel' }, { status: 200 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/loja/frete`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-loja-token': token,
      },
      body: JSON.stringify({
        cep,
        pecas: Number(body?.pecas) || 1,
        subtotal: Number(body?.subtotal) || 0,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const dados = await res.json().catch(() => null);
    if (!res.ok || !dados?.ok) {
      return NextResponse.json({ ok: false, error: 'indisponivel' }, { status: 200 });
    }
    return NextResponse.json(dados, { status: 200 });
  } catch (err) {
    const motivo = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'rede';
    console.warn(`[frete] backend não respondeu (${motivo}) — site cai na tabela local`);
    return NextResponse.json({ ok: false, error: 'indisponivel' }, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}
