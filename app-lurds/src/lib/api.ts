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
  invite?: string;
}) {
  return api<{
    token: string;
    customer: { id: string; name: string; cpf: string };
    bonusPending: number;
    invite?: { redeemed: boolean; bonus?: number; storeCode?: string; sellerName?: string };
  }>('/customers/app/register', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/* ─── App Invite (QR Code PDV) ─── */
export type AppInviteLookup = {
  valid: boolean;
  bonus?: number;
  storeCode?: string;
  sellerName?: string;
  reason?: string;
};
export async function lookupInvite(token: string) {
  return api<AppInviteLookup>(`/customers/app/invite/lookup?token=${encodeURIComponent(token)}`);
}

/** Lê invite token da URL (?invite=XXX) e guarda em localStorage. */
export function captureInviteFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  if (invite) {
    window.localStorage.setItem('lurds_invite_token', invite);
    return invite;
  }
  return window.localStorage.getItem('lurds_invite_token');
}

export function getStoredInvite(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('lurds_invite_token');
}

export function clearStoredInvite() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem('lurds_invite_token');
  }
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
  pushOptIn?: boolean;
  whatsappOptIn?: boolean;
};

export async function getMe(): Promise<CustomerMe> {
  return api<CustomerMe>('/customers/app/me');
}

/* ─── Lookup CPF (público, pré-cadastro) ─── */
export type CpfLookup = {
  exists: boolean;
  hasAppAccount: boolean;
  name?: string | null;
  nameSuggested?: string | null;
  phone?: string | null;
  phoneSuggested?: string | null;
  email?: string | null;
  stats?: {
    linkedStoresCount: number;
    orderCount: number;
    ltvBrl: number;
    vipTier: string;
  };
};

export async function lookupCpf(cpf: string): Promise<CpfLookup> {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return { exists: false, hasAppAccount: false };
  return api<CpfLookup>(`/customers/app/lookup?cpf=${digits}`);
}

/* ─── Endereços (do CRM, agregados) ─── */
export type AppAddress = {
  id: string;
  type: string;
  isPrimary: boolean;
  cep: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  reference: string | null;
};
export async function getAddresses() {
  return api<{ addresses: AppAddress[] }>('/customers/app/addresses');
}

/* ─── Pedidos consolidados (Flowops + Giga) ─── */
export type AppOrder = {
  id: string;
  number: string | null;
  status: string;
  total: number;
  date: string | null;
  tracking: { code: string; carrier: string | null } | null;
  itemsCount: number;
  firstItem: string | null;
};
export async function getOrders() {
  return api<{ orders: AppOrder[]; linkedStoresCount: number }>(
    '/customers/app/orders',
  );
}

/* ─── Cashback ─── */
export type CashbackTx = {
  id: string;
  type: 'earn' | 'welcome' | 'redeem' | 'expire' | 'adjust';
  amount: number;
  balanceAfter: number;
  description: string | null;
  date: string;
  expiresAt: string | null;
};
export type CashbackStatement = {
  balance: number;
  earned: number;
  spent: number;
  rate: number;
  ttlDays: number;
  nextExpiration: { amount: number; expiresAt: string; daysLeft: number } | null;
  transactions: CashbackTx[];
};
export async function getCashbackStatement() {
  return api<CashbackStatement>('/customers/app/cashback');
}

/* ─── Push Notifications ─── */
export async function getPushPublicKey() {
  return api<{ key: string | null }>('/customers/app/push/public-key');
}
export async function pushSubscribeApi(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}) {
  return api<{ ok: true }>('/customers/app/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(sub),
  });
}
export async function pushUnsubscribeApi(endpoint: string) {
  return api<{ ok: true }>('/customers/app/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  });
}

/** Fallback WhatsApp: recebe promoções por WA em vez de push */
export async function setWhatsappOptIn(optIn: boolean) {
  return api<{ whatsappOptIn: boolean }>('/customers/app/whatsapp-opt-in', {
    method: 'POST',
    body: JSON.stringify({ optIn }),
  });
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
