/**
 * GET /api/checkout/:id/status — o endpoint que o PixPanel polla.
 *
 * Sprint 011: pergunta ao BACKEND (`GET /public/loja/pedido/:id/status`). O
 * ecommerce não guarda mais estado de pedido nenhum, e não fala com gateway:
 * quem recebe o webhook da Pagar.me e marca `paid` é o backend.
 *
 * Resposta mínima de propósito (`OrderStatusResult`): o poll roda a cada
 * poucos segundos — quanto menor o payload, melhor. O pedido completo a tela
 * já tem; aqui só interessa "pagou ou não pagou".
 *
 * Falha de rede devolve `ok:true` com o status que a tela já conhecia? NÃO —
 * não temos mais estado local pra devolver. Devolve 502, e o PixPanel trata
 * erro de poll como silêncio (tenta de novo no ciclo seguinte). Rede instável
 * nunca pode fazer a tela desistir de um PIX que a cliente vai pagar.
 */

import { NextResponse } from 'next/server';
import { getOrderStore, OrderStoreError } from '@/lib/orders/store';
import type { OrderStatusResult } from '@/types/checkout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse<OrderStatusResult>> {
  const { id } = await ctx.params;

  try {
    const snapshot = await getOrderStore().status(id);
    if (!snapshot) {
      return NextResponse.json({ ok: false }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json(
      { ok: true, status: snapshot.status, paidAt: snapshot.paidAt },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    const tecnico = err instanceof OrderStoreError ? err.message : String(err);
    console.error(`[checkout] poll de status falhou para ${id}:`, tecnico);
    return NextResponse.json({ ok: false }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
