import 'server-only';

/**
 * CLIENTE HTTP DO BACKEND FLOWOPS — **somente servidor**.
 *
 * Por que server-only (o import no topo garante isso em build):
 *
 * 1. **CORS.** Em produção o backend só aceita as origens listadas na env
 *    `FRONTEND_URL`. O domínio deste ecommerce não está lá, então chamada
 *    direta do navegador seria bloqueada. Server-to-server não passa por CORS.
 * 2. **Segurança.** A URL da API e qualquer credencial nunca chegam ao bundle.
 * 3. **Cache.** O `fetch` do Next cacheia e revalida no servidor de graça.
 *
 * Se um componente client precisar falar com o backend, o caminho é uma Route
 * Handler em `app/api/*` (BFF) — nunca importar este módulo.
 *
 * Ver docs/architecture.md.
 */

/**
 * URL do backend, com `/api` no fim (o Nest usa esse prefixo global).
 * SEM default de produção de propósito: um endereço chutado falharia em
 * silêncio e a vitrine viria vazia sem ninguém entender por quê. Não
 * configurado = erro explícito no log e fallback limpo nas telas.
 */
const BASE_URL = process.env.FLOWOPS_API_URL?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiOptions {
  /** Segundos até revalidar. 0 = sempre fresco. */
  revalidate?: number;
  /** Tags de cache pro revalidateTag. */
  tags?: string[];
  /** JWT do cliente final, quando a rota exigir. */
  token?: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Aborta a requisição depois de N ms (o Giga já nos ensinou a temer pendura). */
  timeoutMs?: number;
  /**
   * IP REAL DA CLIENTE, repassado pro backend limitar por pessoa.
   *
   * Sem isto o backend só enxerga o IP da Vercel — todas as clientes caem no
   * MESMO balde de 20 requisições por minuto, e a 21ª pessoa a tentar fechar
   * pedido no mesmo minuto leva "Muitas tentativas seguidas". Numa live ou
   * campanha, isso não é proteção: é o site recusando venda boa.
   *
   * O backend só confia neste header porque a chamada já foi autenticada pelo
   * `x-loja-token` (server-to-server). Vindo do navegador, seria só um
   * cabeçalho que qualquer um forja pra furar o limite.
   */
  clientIp?: string;
}

/**
 * Chama o backend e devolve JSON tipado.
 *
 * Timeout explícito por padrão: o backend pode pendurar em queries pesadas
 * (histórico de incidentes do ERP), e uma página inteira travar por causa
 * disso é inaceitável. Quem chama decide o fallback.
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const {
    revalidate = 300,
    tags,
    token,
    method = 'GET',
    body,
    timeoutMs = 8000,
    clientIp,
  } = options;

  if (!BASE_URL) {
    throw new ApiError(
      'FLOWOPS_API_URL não configurada — defina a env no projeto da Vercel.',
      503,
      path,
    );
  }

  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(clientIp ? { 'x-cliente-ip': clientIp } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // Rota autenticada nunca entra em cache compartilhado.
      ...(token || method !== 'GET'
        ? { cache: 'no-store' as const }
        : { next: { revalidate, ...(tags ? { tags } : {}) } }),
    });

    if (!response.ok) {
      throw new ApiError(
        `Backend respondeu ${response.status} em ${path}`,
        response.status,
        path,
      );
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Versão tolerante: devolve `fallback` em vez de explodir.
 *
 * Usada nas seções de vitrine — se o catálogo cair, a página continua de pé
 * mostrando o resto (a lição da live de 01/07: dependência externa nunca
 * pode derrubar a tela inteira).
 */
export async function apiSafe<T>(
  path: string,
  fallback: T,
  options: ApiOptions = {},
): Promise<T> {
  try {
    return await api<T>(path, options);
  } catch (error) {
    console.error(`[api] falhou em ${path}:`, error instanceof Error ? error.message : error);
    return fallback;
  }
}
