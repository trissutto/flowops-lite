'use client';

/**
 * ConnectionMonitor — hook + componente visual para saber se a conexão
 * com o backend está viva.
 *
 * Por que isso existe:
 *  - O app-de-loja (Electron/browser) fica ABERTO O DIA TODO.
 *  - Roteadores, NAT, proxy corporativo, ou o próprio servidor caindo
 *    podem deixar a aba "zumbi": parece viva mas não responde.
 *  - Sem heartbeat, a vendedora só descobre que caiu quando tenta
 *    consultar um produto e vê um erro — perde tempo na frente do cliente.
 *
 * Como funciona:
 *  1. Escuta o evento global 'flowops:connection' (emitido pelo api.ts
 *     em todas as chamadas — grátis, sem polling extra).
 *  2. Roda ping() a cada 30s como heartbeat ativo.
 *  3. Se a janela volta pro foco depois de >60s fora, re-ping imediato.
 *  4. Se ficar offline > 5min E a janela estiver no foco, oferece reload.
 *  5. Expõe { status, lastOk, sinceOffline } via hook useConnection().
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { ping, type ConnectionEvent } from './api';

type Status = 'online' | 'offline' | 'checking';

interface ConnectionState {
  status: Status;
  lastOk: number | null;         // timestamp do último success
  offlineSince: number | null;   // timestamp do momento que detectou offline
  forceCheck: () => void;        // força um ping imediato
}

const Ctx = createContext<ConnectionState | null>(null);

const HEARTBEAT_MS = 30_000;           // ping a cada 30s
const FOCUS_RECHECK_AFTER_MS = 60_000; // se ficou fora da aba > 1min, recheca ao voltar
const OFFLINE_HARD_RELOAD_MS = 5 * 60_000; // > 5min offline → sugere reload

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [offlineSince, setOfflineSince] = useState<number | null>(null);
  const lastFocusRef = useRef<number>(Date.now());

  // Dispara um ping manual — usado no foco e no botão da UI
  const doPing = useCallback(async () => {
    const ok = await ping();
    if (ok) {
      setStatus('online');
      setLastOk(Date.now());
      setOfflineSince((prev) => prev); // zera só via evento pra não duplicar
    }
    return ok;
  }, []);

  const forceCheck = useCallback(() => {
    setStatus('checking');
    doPing();
  }, [doPing]);

  // 1. Escuta o evento global do api.ts
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<ConnectionEvent>).detail;
      if (!detail) return;
      if (detail.status === 'online') {
        setStatus('online');
        setLastOk(Date.now());
        setOfflineSince(null);
      } else {
        setStatus('offline');
        setOfflineSince((prev) => prev ?? Date.now());
      }
    };
    window.addEventListener('flowops:connection', handler);
    return () => window.removeEventListener('flowops:connection', handler);
  }, []);

  // 2. Heartbeat — ping a cada 30s
  useEffect(() => {
    doPing(); // inicial
    const id = window.setInterval(() => {
      doPing();
    }, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [doPing]);

  // 3. Recheca ao voltar ao foco
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onBlur = () => { lastFocusRef.current = Date.now(); };
    const onFocus = () => {
      const awayFor = Date.now() - lastFocusRef.current;
      if (awayFor > FOCUS_RECHECK_AFTER_MS) {
        doPing();
      }
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [doPing]);

  return (
    <Ctx.Provider value={{ status, lastOk, offlineSince, forceCheck }}>
      {children}
    </Ctx.Provider>
  );
}

export function useConnection(): ConnectionState {
  const v = useContext(Ctx);
  if (!v) {
    // Fora do provider — retorna um fallback pra não quebrar render
    return {
      status: 'online',
      lastOk: Date.now(),
      offlineSince: null,
      forceCheck: () => {},
    };
  }
  return v;
}

/**
 * Indicador compacto pra header — bolinha + texto curto.
 * Clique força recheck. Quando offline > 5min, mostra botão "Recarregar".
 */
export function ConnectionBadge({ compact = false }: { compact?: boolean }) {
  const { status, offlineSince, forceCheck } = useConnection();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const offlineDuration = offlineSince ? now - offlineSince : 0;
  const hardOffline = status === 'offline' && offlineDuration > OFFLINE_HARD_RELOAD_MS;

  const base = 'flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors';

  if (status === 'online') {
    return (
      <button
        onClick={forceCheck}
        className={`${base} bg-emerald-500/20 text-white hover:bg-emerald-500/30`}
        title="Conexão OK — clique pra revalidar"
      >
        <Wifi className="w-3 h-3" />
        {!compact && <span>Online</span>}
      </button>
    );
  }

  if (status === 'checking') {
    return (
      <span className={`${base} bg-white/10 text-white`} title="Verificando conexão...">
        <RefreshCw className="w-3 h-3 animate-spin" />
        {!compact && <span>Checando</span>}
      </span>
    );
  }

  // offline
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={forceCheck}
        className={`${base} bg-red-500/90 text-white font-bold animate-pulse`}
        title={`Offline${offlineSince ? ` há ${Math.floor(offlineDuration / 1000)}s` : ''}`}
      >
        <WifiOff className="w-3 h-3" />
        <span>{hardOffline ? `Offline ${Math.floor(offlineDuration / 60000)}min` : 'Offline'}</span>
      </button>
      {hardOffline && (
        <button
          onClick={() => location.reload()}
          className="text-xs px-2 py-1 rounded bg-white text-red-700 font-bold hover:bg-red-50"
          title="Recarregar a página"
        >
          Recarregar
        </button>
      )}
    </div>
  );
}
