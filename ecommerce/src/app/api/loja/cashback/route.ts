/**
 * POST /api/loja/cashback — quanto a cliente pode abater nesta sacola (22/09).
 *
 * Mesmo desenho do `/api/loja/cupom`: o `x-loja-token` nunca vai pro
 * navegador, quem sabe o saldo é o FlowOps, e a resposta é sempre utilizável —
 * backend fora do ar devolve zero, nunca 5xx (o checkout não pode travar
 * porque o cashback não respondeu; ela compra sem o abatimento).
 *
 * ── POR QUE MANDA O TELEFONE ──
 *
 * O cashback é preso ao CPF e não tem código. Sem uma segunda chave, digitar
 * um CPF qualquer viraria consulta ao saldo alheio — cupom não tem esse
 * problema porque é preciso SABER o código. O checkout já pediu o WhatsApp na
 * primeira etapa, antes do CPF, então a guarda não custa campo nenhum pra
 * quem está comprando de verdade. Quem valida é o backend (`saldoCashback`);
 * aqui a gente só não deixa a consulta sair sem os dois.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 6_000;

/** Mesma regra do `/api/loja/cupom`: x-forwarded-for primeiro, x-real-ip depois. */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0].trim() || req.headers.get('x-real-ip')?.trim() || '';
}

export interface SaldoCashback {
  saldo: number;
  permitido: number;
  motivo: string | null;
  ativo: boolean;
  /** O que dizer quando não deu pra confirmar que a pessoa é ela mesma. */
  dica: string | null;
}

const ZERO: SaldoCashback = { saldo: 0, permitido: 0, motivo: null, ativo: true, dica: null };

export async function POST(req: Request) {
  let body: { cpf?: unknown; phone?: unknown; subtotal?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(ZERO, { status: 200 });
  }

  const cpf = String(body?.cpf || '').replace(/\D/g, '');
  const phone = String(body?.phone || '').replace(/\D/g, '');
  // Sem as duas chaves nem sai da Vercel: economiza chamada e deixa claro no
  // código que a consulta não existe com CPF sozinho.
  if (cpf.length !== 11 || phone.length < 10) {
    return NextResponse.json(ZERO, { status: 200 });
  }

  const baseUrl = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
  const token = process.env.LOJA_ORDER_TOKEN ?? '';
  if (!baseUrl || !token) return NextResponse.json(ZERO, { status: 200 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/public/loja/cashback`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-loja-token': token,
        ...(clientIp(req) ? { 'x-cliente-ip': clientIp(req) } : {}),
      },
      body: JSON.stringify({ cpf, phone, subtotal: Number(body?.subtotal) || 0 }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const dados = (await res.json().catch(() => null)) as Partial<SaldoCashback> | null;
    if (!dados || typeof dados.permitido !== 'number') return NextResponse.json(ZERO, { status: 200 });

    return NextResponse.json(
      {
        saldo: Number(dados.saldo) || 0,
        permitido: Number(dados.permitido) || 0,
        motivo: dados.motivo ?? null,
        ativo: dados.ativo !== false,
        dica: dados.dica ?? null,
      } satisfies SaldoCashback,
      { status: 200 },
    );
  } catch (err) {
    const motivo = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'rede';
    console.warn(`[cashback] backend não respondeu (${motivo}) — checkout segue sem abatimento`);
    return NextResponse.json(ZERO, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}
