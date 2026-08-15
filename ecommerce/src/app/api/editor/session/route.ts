import { NextResponse } from 'next/server';
import { api, ApiError } from '@/lib/api';
import { clearEditorToken, editorToken, saveEditorToken } from '@/lib/editor-session';

export const dynamic = 'force-dynamic';

type LoginResponse = { accessToken: string; user: { email?: string; name?: string; role?: string } };

export async function GET() {
  const token = await editorToken();
  if (!token) return NextResponse.json({ editor: null });
  try {
    const user = await api<{ email?: string; name?: string; role?: string }>('/auth/me', { token });
    if (user.role !== 'admin') {
      await clearEditorToken();
      return NextResponse.json({ editor: null });
    }
    return NextResponse.json({ editor: user });
  } catch {
    await clearEditorToken();
    return NextResponse.json({ editor: null });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!email || password.length < 6) {
    return NextResponse.json({ error: 'Informe o e-mail e a senha do CRM.' }, { status: 400 });
  }
  try {
    const login = await api<LoginResponse>('/auth/login', {
      method: 'POST', body: { email, password }, timeoutMs: 12_000,
    });
    if (login.user?.role !== 'admin') {
      return NextResponse.json({ error: 'Somente administradores podem editar o site.' }, { status: 403 });
    }
    await saveEditorToken(login.accessToken);
    return NextResponse.json({ editor: login.user });
  } catch (error) {
    const message = error instanceof ApiError && error.status === 401
      ? 'E-mail ou senha não conferem.'
      : 'Não foi possível entrar no modo de edição.';
    return NextResponse.json({ error: message }, { status: error instanceof ApiError ? error.status : 502 });
  }
}

export async function DELETE() {
  await clearEditorToken();
  return NextResponse.json({ ok: true });
}
