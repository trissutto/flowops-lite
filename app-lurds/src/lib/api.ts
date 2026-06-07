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

/** GET /me — perfil consolidado do account (cashback + stats + lojas) */
export type CustomerMe = {
  id: string;
  name: string | null;
  cpf: string;        // mascarado: 123.***.***-45
  phone: string | null;
  email: string | null;
  cashback: { balance: number; earned: number; spent: number };
  stats: {
    ltvBrl: number;
    orderCount: number;
    lastOrderAt: string | null;
    linkedStoresCount: number;
  };
  pwaInstalled: boolean;
  welcomeBonusReceived: boolean;
};

export async function getMe(): Promise<CustomerMe> {
  return api<CustomerMe>('/customers/app/me');
}

/* ─── Catálogo (público, sem auth) ─── */

export type WcCategory = {
  id: number;
  name: string;
  slug: string;
  count: number;
  image: string | null;
};
export type WcProduct = {
  id: number;
  name: string;
  slug: string;
  price: number;
  regularPrice: number;
  onSale: boolean;
  image: string | null;
  permalink: string;
  categories: string[];
};

export async function getCategories() {
  return api<{ categories: WcCategory[] }>('/catalog/categories');
}

export async function getProducts(opts: {
  category?: string;
  search?: string;
  page?: number;
  perPage?: number;
  orderby?: 'date' | 'popularity' | 'price' | 'rating';
  onSale?: boolean;
} = {}) {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.search) params.set('search', opts.search);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.perPage) params.set('perPage', String(opts.perPage));
  if (opts.orderby) params.set('orderby', opts.orderby);
  if (opts.onSale) params.set('onSale', '1');
  const qs = params.toString();
  return api<{
    products: WcProduct[];
    total: number;
    page: number;
    perPage: number;
  }>(`/catalog/products${qs ? '?' + qs : ''}`);
}
