import 'server-only';
import { cookies } from 'next/headers';

export const EDITOR_COOKIE = 'lurds_editor';
const EDITOR_MAX_AGE = 60 * 60 * 8;

export async function editorToken() {
  return (await cookies()).get(EDITOR_COOKIE)?.value ?? null;
}

export async function saveEditorToken(token: string) {
  (await cookies()).set(EDITOR_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: EDITOR_MAX_AGE,
  });
}

export async function clearEditorToken() {
  (await cookies()).delete(EDITOR_COOKIE);
}
