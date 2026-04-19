import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

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

export function getSocket(): Socket {
  if (!socket) {
    const url = resolveSocketUrl();
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    socket = io(`${url}/realtime`, { auth: { token } });
  }
  return socket;
}
