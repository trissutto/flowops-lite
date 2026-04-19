/**
 * Resolve a URL do backend em runtime.
 *
 * Prioridade:
 *   1. NEXT_PUBLIC_API_URL (dev local — ex: dev na máquina do Thiago)
 *   2. Mesmo host do frontend + porta 3001 (produção LAN)
 *      → cliente que abre http://192.168.1.50:3000 vira http://192.168.1.50:3001
 *   3. Fallback SSR: localhost:3001
 *
 * Isso elimina a necessidade de setar NEXT_PUBLIC_API_URL no build do servidor.
 * O mesmo bundle serve tanto a máquina servidor (localhost) quanto PCs da rede.
 */
function resolveApiUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_API_URL;

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    // Se a env var aponta pra localhost mas estamos em uma LAN IP, ignora a env.
    const envIsLocalhost =
      envUrl?.includes('localhost') || envUrl?.includes('127.0.0.1');
    const hostIsLocalhost = host === 'localhost' || host === '127.0.0.1';

    if (envUrl && !envIsLocalhost) return envUrl; // dev custom com proxy externo
    if (!hostIsLocalhost) return `${window.location.protocol}//${host}:3001`;
    return envUrl || 'http://localhost:3001';
  }

  return envUrl || 'http://localhost:3001';
}

const API_URL = resolveApiUrl();

export async function api<T = any>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
  const res = await fetch(`${API_URL}/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`${res.status}: ${msg}`);
  }
  return res.json();
}
