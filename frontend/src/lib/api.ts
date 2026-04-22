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

export const API_URL = resolveApiUrl();

/**
 * Evento global de sinalização de saúde da conexão.
 * Os componentes de UI (ex.: bolinha de status) escutam esse evento pra
 * atualizar a representação visual sem precisar de polling próprio.
 *
 * Fluxo:
 *   - toda chamada bem-sucedida → dispatch 'online'
 *   - toda falha de rede/5xx → dispatch 'offline' com detalhe do erro
 */
export type ConnectionEvent = { status: 'online' | 'offline'; detail?: string };

function emitConnection(ev: ConnectionEvent) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ConnectionEvent>('flowops:connection', { detail: ev }));
}

/**
 * Flag pra não disparar múltiplos alertas/redirect quando várias chamadas
 * paralelas em um bulk recebem 401 ao mesmo tempo.
 */
let unauthorizedHandled = false;

function handleUnauthorized() {
  if (typeof window === 'undefined') return;
  if (unauthorizedHandled) return;
  unauthorizedHandled = true;

  try {
    localStorage.removeItem('flowops_token');
  } catch {}

  // Dispara evento pra qualquer listener (ex.: layout) e também mostra alert
  // crú como fallback, garantindo que o user SEMPRE veja que a sessão caiu.
  window.dispatchEvent(new CustomEvent('flowops:unauthorized'));

  // Avisa o user na hora e redireciona pra login mantendo a rota atual
  // pra voltar depois do login. setTimeout pra não bloquear o throw da chamada.
  setTimeout(() => {
    const here =
      window.location.pathname + window.location.search + window.location.hash;
    alert(
      'Sua sessão expirou.\n\n' +
        'Algumas operações em lote podem ter sido interrompidas. ' +
        'Você vai ser redirecionado pro login — ao voltar, confira o que foi processado ' +
        'antes de reprocessar.',
    );
    const target = here && here !== '/login'
      ? `/login?redirect=${encodeURIComponent(here)}`
      : '/login';
    window.location.href = target;
  }, 50);
}

export async function api<T = any>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
  try {
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
      // 401 = sessão expirou → força logout com alerta (1x só, mesmo em paralelo)
      // Isola o endpoint /auth/me pois ele é usado pelo ping de heartbeat e
      // não queremos disparar alerta em ping silencioso.
      if (res.status === 401 && !path.startsWith('/auth/me')) {
        handleUnauthorized();
      }
      // 5xx = servidor com problema → marca offline pra UI reagir
      if (res.status >= 500) emitConnection({ status: 'offline', detail: `HTTP ${res.status}` });
      throw new Error(`${res.status}: ${msg}`);
    }
    emitConnection({ status: 'online' });
    return res.json();
  } catch (e: any) {
    // TypeError "Failed to fetch" = rede caiu / cors / dns
    if (e?.name === 'TypeError') emitConnection({ status: 'offline', detail: 'rede' });
    throw e;
  }
}

/**
 * Versão com retry exponencial — usa em telas críticas que "ficam o dia todo abertas"
 * (ex.: /minha-loja/consultar). Retenta 3x com delay 400ms → 1s → 2.5s.
 *
 * Retorna o erro original se esgotar tentativas, pra caller decidir o que exibir.
 * Falhas 4xx (client error) NÃO são retentadas — é erro de uso, retry não ajuda.
 */
export async function apiRetry<T = any>(
  path: string,
  opts: RequestInit = {},
  tries = 3,
): Promise<T> {
  const delays = [0, 400, 1000, 2500]; // tries=3 usa 400,1000,2500
  let lastErr: any = null;
  for (let i = 0; i <= tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, delays[i] ?? 2500));
    try {
      return await api<T>(path, opts);
    } catch (e: any) {
      lastErr = e;
      // 4xx = não adianta retentar
      const m = String(e?.message || '').match(/^(\d{3}):/);
      if (m) {
        const code = Number(m[1]);
        if (code >= 400 && code < 500) throw e;
      }
      // senão, próximo loop tenta de novo
    }
  }
  throw lastErr;
}

/**
 * Ping leve pra manter a conexão viva e confirmar que o backend tá vivo.
 * Usado por componentes de "heartbeat" que o app-de-loja fica o dia todo aberto.
 */
export async function ping(): Promise<boolean> {
  try {
    await api('/auth/me');
    return true;
  } catch {
    return false;
  }
}
