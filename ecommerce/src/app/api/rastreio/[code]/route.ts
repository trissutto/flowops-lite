import { NextResponse } from 'next/server';

/**
 * BFF DO RASTREIO — o formulário público de /rastreio consulta por aqui.
 *
 * O backend só aceita as origens da `FRONTEND_URL` (CORS), então o navegador
 * não fala com ele direto — mesmo desenho de todos os BFFs em `app/api/*`.
 * O destino é `GET /public/rastreio/:code`, que lê SÓ o cache
 * `rastreio_objetos` (cron de 30min) — nunca provedor ao vivo, então esta
 * rota pode ser pública sem queimar cota nem expor token.
 *
 * Cache curto: o cron atualiza de 30 em 30min, mas a cliente ansiosa
 * recarrega — 60s aqui absorve o F5 sem esconder atualização real.
 */

const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';
const FORMATO_SRO = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  if (!BASE_URL) {
    return NextResponse.json({ erro: 'indisponivel' }, { status: 503 });
  }

  const { code } = await ctx.params;
  const codigo = String(code || '').replace(/[\s-]/g, '').toUpperCase();
  if (!FORMATO_SRO.test(codigo)) {
    return NextResponse.json({ erro: 'codigo_invalido' }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${BASE_URL}/public/rastreio/${encodeURIComponent(codigo)}`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8000),
      headers: {
        // Sem isto o rate-limit do backend conta o IP de EGRESS da Vercel —
        // um balde só pro site inteiro (mesmo padrão do /api/loja/frete).
        'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '',
      },
    });
    if (!upstream.ok) {
      return NextResponse.json({ erro: 'falha' }, { status: 502 });
    }
    return NextResponse.json(await upstream.json());
  } catch (error) {
    console.error('[rastreio] consulta falhou:', error);
    return NextResponse.json({ erro: 'falha' }, { status: 502 });
  }
}
