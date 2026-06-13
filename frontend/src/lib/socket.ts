import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;
let socketToken: string | null = null;

/**
 * Resolve URL do socket em runtime — mesma lógica do api.ts.
 * Permite o mesmo bundle do frontend rodar tanto no servidor (localhost)
 * quanto nas máquinas cliente que acessam via IP da LAN.
 */
function resolveSocketUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_WS_URL;

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    const envIsLocalhost =
      envUrl?.includes('localhost') || envUrl?.includes('127.0.0.1');
    const hostIsLocalhost = host === 'localhost' || host === '127.0.0.1';

    if (envUrl && !envIsLocalhost) return envUrl;
    if (!hostIsLocalhost) {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${host}:3001`;
    }
    return envUrl || 'ws://localhost:3001';
  }

  return envUrl || 'ws://localhost:3001';
}

/**
 * Retorna o socket conectado ao realtime.
 *
 * ⚠️ BUG CORRIGIDO (jun/26 — caso Sorocaba):
 * Antes, era um singleton "burro" que reaproveitava `socket` enquanto não
 * fosse null. Resultado catastrófico no Electron das lojas:
 *   - Vendedora A loga (JWT_A, storeId=SOROCABA) → socket entra em
 *     room `store:SOROCABA`. Pedidos chegam certo.
 *   - Vendedora A sai, vendedora B loga com OUTRO usuário (JWT_B,
 *     role=admin/operator OU storeId diferente). `localStorage.flowops_token`
 *     muda, MAS `getSocket()` retorna o socket antigo (ainda autenticado
 *     com JWT_A). Pior: se JWT_A era role=admin, o socket está em room
 *     'admin' e recebe eventos de TODAS as lojas — daí o caso reportado
 *     ("Sorocaba aparecendo pedidos de PRAIA GRANDE e CAMPINAS").
 *
 * Fix: comparar o token usado pra abrir o socket com o token atual do
 * localStorage. Se mudou, fecha o socket antigo e abre um novo com o
 * token correto (que dispara reauth no handleConnection do gateway).
 */
function resolveToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const sessionTok = window.sessionStorage.getItem('flowops_token');
    if (sessionTok) return sessionTok;
  } catch {
    /* segue pro localStorage */
  }
  return window.localStorage.getItem('flowops_token');
}

export function getSocket(): Socket {
  const token = resolveToken();

  // Se token mudou (ou sumiu) desde o último connect, descarta socket antigo.
  if (socket && socketToken !== token) {
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch {
      /* noop */
    }
    socket = null;
    socketToken = null;
  }

  if (!socket) {
    const url = resolveSocketUrl();
    socket = io(`${url}/realtime`, { auth: { token } });
    socketToken = token;
  }
  return socket;
}

/**
 * Desconecta o socket. Usar em logout pra garantir que a próxima conexão
 * vai usar o JWT do próximo usuário (não fica receberndo eventos do antigo).
 */
export function disconnectSocket() {
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch {
      /* noop */
    }
  }
  socket = null;
  socketToken = null;
}
