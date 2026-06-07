/**
 * API client do app Lurd's — wrapper sobre fetch com:
 *   - Auto-incluir JWT do cliente (localStorage)
 *   - Trata 401 redirecionando pra login
 *   - Parsing JSON com error handling padronizado
 */

// Backend NestJS tem prefix global '/api', então URL final = ${API_BASE}/api/...
// Fallback hardcoded: URL real do Railway (caso env var não seja injetada no build do Vercel).
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://flowops-lite-production.up.railway.app';
const API_URL = `${API_BASE.replace(/\/$/, '')}/api`;

const TOKEN_KEY = 'lurds_customer_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function logout(): void {
  setToken(null);
  if (typeof window !== 'undefined') window.location.href = '/login';
}

/**
 * Faz request autenticada. Retorna JSON parseado.
 * Em 401, força logout e joga pra /login.
 */
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const token = getToken();
  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    logout();
    throw new ApiError(401, 'Sessão expirada. Faça login novamente.');
  }

  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    try {
      const body = await res.json();
      msg = body?.message || body?.error || msg;
    } catch {
      // ignore parse error
    }
    throw new ApiError(res.status, msg);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json();
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ─── Endpoints específicos do app cliente ─── */

export async function loginCustomer(cpf: string, password: string) {
  return api<{ token: string; customer: { id: string; name: string; cashbackBalance: number } }>(
    '/customers/app/login',
    {
      method: 'POST',
      body: JSON.stringify({ cpf, password }),
    },
  );
}

export async function registerCustomer(data: {
  cpf: string;
  name: string;
  phone: string;
  email?: string;
  password: string;
}) {
  return api<{ token: string; bonus: number }>('/customers/app/register', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
