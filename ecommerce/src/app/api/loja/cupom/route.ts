/**
 * POST /api/loja/cupom — BFF da validação de cupom (01/09/2026).
 *
 * A regra de cupom deixou de morar no site: `site_cupons` no FlowOps é a
 * fonte (criada na retaguarda sem deploy, e única casa do VALE-TROCA
 * nominal). Esta rota só carrega o `x-loja-token` — que NUNCA vai pro
 * navegador — e repassa o veredito do backend com a regra pro client
 * recalcular localmente (ver `seedCouponRule` em lib/commerce/cupom).
 *
 * Backend fora do ar → o helper cai na tabela local de campanhas, então a
 * resposta daqui é SEMPRE um CouponResult utilizável; nunca 5xx pro
 * navegador confundir com erro de rede.
 */

import { NextResponse } from 'next/server';
import { validarCupomServer } from '@/lib/commerce/cupom-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Mesma regra do `/api/loja/frete`: x-forwarded-for primeiro, x-real-ip depois. */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0].trim() || req.headers.get('x-real-ip')?.trim() || '';
}

export async function POST(req: Request) {
  let body: { code?: unknown; subtotal?: unknown; cpf?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Requisição inválida.' }, { status: 400 });
  }

  const code = String(body?.code || '').trim().toUpperCase().slice(0, 30);
  if (!code) {
    return NextResponse.json(
      { ok: false, code: '', discount: 0, message: 'Digite o código do cupom.' },
      { status: 200 },
    );
  }

  const cpf = String(body?.cpf || '').replace(/\D/g, '');
  const resultado = await validarCupomServer({
    code,
    subtotal: Number(body?.subtotal) || 0,
    ...(cpf.length === 11 ? { cpf } : {}),
    clientIp: clientIp(req),
  });
  return NextResponse.json(resultado, { status: 200 });
}
