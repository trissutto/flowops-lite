import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';
import { editorToken } from '@/lib/editor-session';

function failure(error: unknown) {
  const status = error instanceof ApiError ? error.status : 502;
  const message = error instanceof ApiError ? error.mensagemDoBackend : null;
  return NextResponse.json({ error: message || 'Não foi possível atualizar as fotos.' }, { status });
}

async function ctx(request: Request, params: Promise<{ ref: string }>) {
  const token = await editorToken();
  if (!token) return { response: NextResponse.json({ error: 'Sessão expirada.' }, { status: 401 }) };
  const { ref } = await params;
  const url = new URL(request.url);
  const cor = url.searchParams.get('cor') || '';
  return { token, ref, cor };
}

export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const c = await ctx(request, params); if ('response' in c) return c.response;
  try { return NextResponse.json(await api(`/product-photos/galeria?ref=${encodeURIComponent(c.ref)}&cor=${encodeURIComponent(c.cor)}`, { token: c.token, revalidate: 0 })); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const c = await ctx(request, params); if ('response' in c) return c.response;
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === 'prepare') {
      return NextResponse.json(await api('/site-media/direct-upload', { method: 'POST', token: c.token, body: { filename: body.filename, kind: 'product', resourceKey: [c.ref.toUpperCase(), c.cor.toUpperCase()].filter(Boolean).join('|') } }));
    }
    if (body.action === 'confirm') {
      return NextResponse.json(await api(`/site-media/${encodeURIComponent(body.id)}/confirm`, { method: 'POST', token: c.token, body: { ref: c.ref, cor: c.cor, substituirId: body.substituirId }, timeoutMs: 20_000 }));
    }
    return NextResponse.json({ error: 'Ação inválida.' }, { status: 400 });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const c = await ctx(request, params); if ('response' in c) return c.response;
  const body = await request.json().catch(() => ({}));
  try { return NextResponse.json(await api('/product-photos/reorder', { method: 'POST', token: c.token, body: { ids: body.ids } })); }
  catch (error) { return failure(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const c = await ctx(request, params); if ('response' in c) return c.response;
  const id = new URL(request.url).searchParams.get('id');
  const cloudflare = new URL(request.url).searchParams.get('cloudflare') === '1';
  if (!id) return NextResponse.json({ error: 'Foto não informada.' }, { status: 400 });
  try { return NextResponse.json(await api(cloudflare ? `/site-media/photo/${encodeURIComponent(id)}` : `/product-photos/${encodeURIComponent(id)}`, { method: 'DELETE', token: c.token })); }
  catch (error) { return failure(error); }
}
