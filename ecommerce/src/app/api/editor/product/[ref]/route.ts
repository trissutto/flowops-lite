import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';
import { editorToken } from '@/lib/editor-session';

function backendMessage(error: unknown) {
  return error instanceof ApiError
    ? { error: error.mensagemDoBackend || 'Não foi possível atualizar o produto.', status: error.status }
    : { error: 'Não foi possível atualizar o produto.', status: 502 };
}

async function context(request: Request, params: Promise<{ ref: string }>) {
  const token = await editorToken();
  if (!token) return { response: NextResponse.json({ error: 'Sessão de edição expirada.' }, { status: 401 }) };
  const { ref } = await params;
  const url = new URL(request.url);
  const query = new URLSearchParams();
  query.set('marca', url.searchParams.get('marca') || '');
  if (url.searchParams.get('cor')) query.set('cor', url.searchParams.get('cor')!);
  return { token, path: `/site-content-editor/product/${encodeURIComponent(ref)}?${query}` };
}

export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await context(request, params);
  if ('response' in ctx) return ctx.response;
  try {
    return NextResponse.json(await api(ctx.path, { token: ctx.token, revalidate: 0 }));
  } catch (error) {
    const failure = backendMessage(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await context(request, params);
  if ('response' in ctx) return ctx.response;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json(await api(`${ctx.path.replace('?', '/draft?')}`, {
      method: 'PUT', token: ctx.token, body, timeoutMs: 12_000,
    }));
  } catch (error) {
    const failure = backendMessage(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await context(request, params);
  if ('response' in ctx) return ctx.response;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json(await api(`${ctx.path.replace('?', '/publish?')}`, {
      method: 'POST', token: ctx.token, body, timeoutMs: 20_000,
    }));
  } catch (error) {
    const failure = backendMessage(error);
    return NextResponse.json({ error: failure.error }, { status: failure.status });
  }
}
