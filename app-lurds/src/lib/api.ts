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

/** Lê dados básicos do JWT pra mostrar "Olá Thiago" sem precisar bater no /me. */
export function getCustomerFromToken(): { id: string; name: string | null; cpf: string | null } | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (!payload?.sub) return null;
    return {
      id: payload.sub,
      name: payload.name || null,
      cpf: payload.cpf || null,
    };
  } catch {
    return null;
  }
}

/** Primeiro nome (ex: "Thiago Rissutto" → "Thiago"). */
export function getFirstName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.trim().split(/\s+/)[0];
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
  /** ISO YYYY-MM-DD — opcional, pra campanha de aniversário */
  birthDate?: string;
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

export type AddressPayload = {
  type?: string;
  cep?: string;
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  reference?: string;
  isPrimary?: boolean;
};
export async function createAddress(data: AddressPayload) {
  return api<{ id: string }>('/customers/app/addresses', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
export async function updateAddress(id: string, data: AddressPayload) {
  return api<{ id: string }>(`/customers/app/addresses/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}
export async function deleteAddress(id: string) {
  return api<{ ok: true }>(`/customers/app/addresses/${id}`, {
    method: 'DELETE',
  });
}

/** Lookup CEP no ViaCEP (frontend-side, sem auth, gratuito) */
export async function lookupCep(cep: string) {
  const digits = cep.replace(/\D/g, '');
  if (digits.length !== 8) throw new Error('CEP inválido');
  const r = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
  if (!r.ok) throw new Error('Falha consultando CEP');
  const data = await r.json();
  if (data.erro) throw new Error('CEP não encontrado');
  return {
    cep: digits,
    street: data.logradouro as string,
    district: data.bairro as string,
    city: data.localidade as string,
    state: data.uf as string,
  };
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

/* ─── Histórico de notificações (caixa do app) ─── */
export type AppNotification = {
  id: string;
  title: string;
  body: string | null;
  url: string | null;
  image: string | null;
  category: 'promo' | 'order' | 'cashback' | 'live' | 'system';
  read: boolean;
  createdAt: string;
};
export async function getNotifications() {
  return api<{ notifications: AppNotification[]; unreadCount: number }>(
    '/customers/app/notifications',
  );
}
export async function markAllNotificationsRead() {
  return api<{ marked: number }>('/customers/app/notifications/read-all', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
export async function getUnreadNotificationsCount() {
  return api<{ count: number }>('/customers/app/notifications/unread-count');
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

/** Tamanhos disponíveis (puxa do atributo pa_tamanho do WC). */
export type WcSize = { id: number; name: string; slug: string; count: number };
export async function getSizes() {
  return api<{ sizes: WcSize[] }>('/catalog/sizes');
}

/* ───── Tamanho preferido da cliente (localStorage) ───── */
const PREFERRED_SIZE_KEY = 'lurds_preferred_size';

export function getPreferredSize(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(PREFERRED_SIZE_KEY);
  } catch {
    return null;
  }
}

export function setPreferredSize(size: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (size) {
      window.localStorage.setItem(PREFERRED_SIZE_KEY, size);
    } else {
      window.localStorage.removeItem(PREFERRED_SIZE_KEY);
    }
    // Dispara evento pra outros componentes reagirem
    window.dispatchEvent(new CustomEvent('lurds:size-changed', { detail: { size } }));
  } catch {}
}

/** Produto completo: galeria, variações, atributos */
export type WcProductImage = { id: number; src: string; alt: string };
export type WcAttribute = {
  id: number;
  name: string;
  slug: string;
  options: string[];
  variation: boolean;
};
export type WcVariation = {
  id: number;
  sku: string;
  price: number;
  regularPrice: number;
  onSale: boolean;
  stockStatus: 'instock' | 'outofstock' | 'onbackorder';
  stockQuantity: number | null;
  image: string | null;
  attributes: Array<{ name: string; option: string }>;
};
export type WcProductDetail = {
  id: number;
  slug: string;
  name: string;
  description: string;
  shortDescription: string;
  type: 'simple' | 'variable';
  price: number;
  regularPrice: number;
  salePrice: number;
  onSale: boolean;
  stockStatus: 'instock' | 'outofstock' | 'onbackorder';
  stockQuantity: number | null;
  permalink: string;
  images: WcProductImage[];
  categories: Array<{ id: number; name: string; slug: string }>;
  attributes: WcAttribute[];
  variations: WcVariation[];
  relatedIds: number[];
};

export async function getProductBySlug(slug: string) {
  return api<WcProductDetail>(`/catalog/products/${encodeURIComponent(slug)}`);
}

/** Cross-sell: produtos sugeridos pra um productId */
export type RelatedProduct = {
  id: number;
  slug: string;
  name: string;
  price: number;
  regularPrice: number;
  salePrice: number;
  onSale: boolean;
  image: string | null;
  permalink: string;
};
export async function getRelatedProducts(productId: number, limit: number = 6) {
  return api<{ products: RelatedProduct[] }>(
    `/catalog/products/${productId}/related?limit=${limit}`,
  );
}

/** Frete: retorna opções (PAC, SEDEX, retirar em loja, etc) */
export type ShippingOption = {
  code: string;
  name: string;
  price: number;
  days: number;
  type: 'shipping' | 'pickup';
  storeCode?: string;
  storeAddress?: string;
};
export async function calculateShipping(cep: string, subtotal?: number) {
  return api<{ options: ShippingOption[] }>('/catalog/shipping/calculate', {
    method: 'POST',
    body: JSON.stringify({ cep, subtotal }),
  });
}

/** Cria pedido no WC e retorna URL pra pagar (PIX/cartão) */
export type CreateOrderPayload = {
  customer: { first_name: string; last_name?: string; email: string; phone: string; cpf: string };
  shipping: { address_1: string; number?: string; address_2?: string; city: string; state: string; postcode: string };
  lineItems: Array<{ product_id: number; variation_id?: number; quantity: number }>;
  couponCode?: string;
  paymentMethod: 'pix' | 'credit_card' | 'boleto';
  cashbackUsedCents?: number;
  shippingMethod?: string;
  shippingCost?: number;
  pickupStoreCode?: string;
};
export type CreatedOrder = {
  id: number;
  number: string;
  status: string;
  total: number;
  paymentUrl: string;
};
export async function createWcOrder(payload: CreateOrderPayload) {
  return api<CreatedOrder>('/catalog/orders/create', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** App Checkout via plugin WP — prepara cart nativo e retorna URL */
export type AppCheckoutResult = { checkoutUrl: string; token: string };
export async function appCheckout(payload: CreateOrderPayload) {
  return api<AppCheckoutResult>('/catalog/app-checkout', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/* ─── Acompanhamento de pedido ─── */
export type WcOrderDetail = {
  id: number;
  number: string;
  status: string;
  statusLabel: string;
  paymentMethod: string;
  paymentMethodTitle: string;
  total: number;
  shippingTotal: number;
  discountTotal: number;
  cashbackUsed: number;
  dateCreated: string;
  datePaid: string | null;
  items: Array<{
    id: number;
    name: string;
    quantity: number;
    price: number;
    subtotal: number;
    total: number;
    image: string | null;
    variation: string;
  }>;
  shipping: {
    name: string;
    address: string;
    address2: string;
    city: string;
    state: string;
    postcode: string;
  };
  shippingMethod: string | null;
  pix: {
    qrCodeBase64: string | null;
    qrCodeUrl: string | null;
    copyPaste: string | null;
    expiresAt: string | null;
  } | null;
  tracking: { code: string; url: string; carrier: string } | null;
  paymentUrl: string | null;
};
export async function getOrderById(wcOrderId: number | string) {
  return api<WcOrderDetail>(`/catalog/orders/${encodeURIComponent(String(wcOrderId))}`);
}

export async function getProducts(opts: {
  category?: string;
  search?: string;
  size?: string;
  page?: number;
  perPage?: number;
  orderby?: 'date' | 'popularity' | 'price' | 'rating';
  onSale?: boolean;
} = {}) {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.search) params.set('search', opts.search);
  if (opts.size) params.set('size', opts.size);
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
