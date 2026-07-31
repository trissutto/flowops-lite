/**
 * GET /api/checkout/:id — o pedido pra tela de confirmação/acompanhamento.
 *
 * Sprint 011: lê do BACKEND FlowOps (`GET /public/loja/pedido/:id`), não mais
 * de memória. O `id` é o UUID do Order no Postgres do Flow.
 *
 * Devolve o pedido SEM o que a tela não precisa:
 *   - `tracking` fica fora (fbp/fbc/attribution são sinal interno, não dado
 *     de pedido — em log de rede seria vazamento bobo);
 *   - CPF sai MASCARADO (***.***.**9-10) — a tela só precisa provar pra
 *     cliente que é o pedido dela, não reexibir o documento inteiro.
 *
 * A sanitização fica AQUI mesmo que o backend já sanitize: defesa em
 * profundidade. Se um dia o endpoint público do backend passar a devolver o
 * CPF inteiro (por engano ou por outro consumidor precisar), esta rota
 * continua não vazando — a regra da memória "live-sacolinha-seguranca" vale
 * pra todo endpoint que o navegador alcança.
 *
 * O id é um UUID aleatório — funciona como capability token: quem tem o link
 * vê o pedido. Sem conta de cliente (MVP), é o mesmo modelo do rastreio dos
 * Correios. Quando o login entrar, a checagem de dono entra aqui.
 */

import { NextResponse } from 'next/server';
import { getOrderStore, OrderStoreError } from '@/lib/orders/store';
import type { Order } from '@/types/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ***.***.**9-10 — só o 9º dígito e os verificadores ficam visíveis. */
function mascararCpf(cpf: string): string {
  if (!/^\d{11}$/.test(cpf)) return '***.***.***-**';
  return `***.***.**${cpf[8]}-${cpf.slice(9)}`;
}

function sanitizar(order: Order): Order {
  const { tracking: _tracking, ...resto } = order;
  return {
    ...resto,
    customer: { ...order.customer, cpf: mascararCpf(order.customer.cpf) },
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  let order: Order | undefined;
  try {
    order = await getOrderStore().get(id);
  } catch (err) {
    // Backend fora do ar não é "pedido inexistente": 404 aqui mandaria a
    // cliente pro estado "não encontramos esse pedido" logo depois de ela
    // pagar. 502 + mensagem elegante deixa ela tentar de novo.
    const tecnico = err instanceof OrderStoreError ? err.message : String(err);
    console.error(`[checkout] falha ao buscar pedido ${id}:`, tecnico);
    return NextResponse.json(
      { ok: false, error: 'Não conseguimos carregar seu pedido agora. Atualize a página em instantes.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!order) {
    return NextResponse.json({ ok: false, error: 'Pedido não encontrado.' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, order: sanitizar(order) }, { headers: { 'Cache-Control': 'no-store' } });
}
