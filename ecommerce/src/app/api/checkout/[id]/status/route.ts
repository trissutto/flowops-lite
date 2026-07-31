/**
 * GET /api/checkout/:id/status — o endpoint que o PixPanel polla.
 *
 * Resposta mínima de propósito (`OrderStatusResult`): o poll roda a cada
 * poucos segundos — quanto menor o payload, melhor. O pedido completo a tela
 * já tem; aqui só interessa "pagou ou não pagou".
 *
 * É AQUI que o check do provider roda (mock: auto-confirmação por idade do
 * pedido). Com gateway real + webhook confiável, este endpoint vira leitura
 * pura do store — o provider pode nem implementar `checkStatus`.
 */

import { NextResponse } from 'next/server';
import { getOrderStore } from '@/lib/orders/store';
import { getPaymentProvider } from '@/lib/payments/provider';
import type { OrderStatusResult } from '@/types/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse<OrderStatusResult>> {
  const { id } = await ctx.params;
  const store = getOrderStore();
  const order = await store.get(id);

  if (!order) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  let status = order.status;
  const provider = getPaymentProvider();
  if (provider.checkStatus) {
    try {
      status = await provider.checkStatus(order);
    } catch (err) {
      // Gateway fora do ar não pode derrubar o poll: devolve o que o store
      // sabe e o próximo ciclo tenta de novo.
      console.error('[checkout] checkStatus falhou (devolvendo status local):', err);
    }
  }

  // `paidAt` sai do store (o checkStatus pode ter acabado de confirmar).
  const atualizado = status === order.status ? order : await store.get(id);

  return NextResponse.json(
    { ok: true, status, paidAt: atualizado?.paidAt },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
