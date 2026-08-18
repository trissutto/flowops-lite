import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';
import { editorToken } from '@/lib/editor-session';

/**
 * A ORDEM DA VITRINE — lida e gravada de dentro do próprio site.
 *
 * Mesmo caminho das fotos da peça: o navegador nunca fala com o backend, só com
 * este BFF, que carimba a sessão do editor (a mesma do login por e-mail/senha
 * do CRM). Sem isso o token de admin teria que existir no bundle público.
 */

function falha(error: unknown) {
  const status = error instanceof ApiError ? error.status : 502;
  const message = error instanceof ApiError ? error.mensagemDoBackend : null;
  return NextResponse.json({ error: message || 'Não foi possível salvar a ordem.' }, { status });
}

async function ctx(params: Promise<{ slug: string }>) {
  const token = await editorToken();
  if (!token) return { response: NextResponse.json({ error: 'Sessão expirada.' }, { status: 401 }) };
  const { slug } = await params;
  return { token, slug };
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const c = await ctx(params);
  if ('response' in c) return c.response;
  try {
    return NextResponse.json(
      await api(`/loja-catalog/ordem-categoria/${encodeURIComponent(c.slug)}`, {
        token: c.token,
        revalidate: 0,
      }),
    );
  } catch (error) {
    return falha(error);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const c = await ctx(params);
  if ('response' in c) return c.response;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json(
      await api(`/loja-catalog/ordem-categoria/${encodeURIComponent(c.slug)}`, {
        method: 'PUT',
        token: c.token,
        // Lista vazia é o jeito de devolver a categoria pro automático — o
        // backend apaga a linha quando ela chega assim.
        body: { refs: Array.isArray(body?.refs) ? body.refs : [] },
      }),
    );
  } catch (error) {
    return falha(error);
  }
}
