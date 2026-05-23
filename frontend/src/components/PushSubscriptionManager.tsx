'use client';

/**
 * PushSubscriptionManager — gerencia subscription do Web Push.
 *
 * O que faz no boot do app (quando user tá logado):
 *  1. Verifica se browser suporta push + Notification API
 *  2. Verifica se já tem subscription ativa
 *  3. Se NÃO tem permissão: aparece um banner discreto sugerindo ativar
 *  4. Se permissão concedida: cria subscription via service worker
 *  5. Envia subscription pro backend (POST /push/subscribe)
 *
 * O banner é mostrado UMA VEZ por device (localStorage). Vendedora pode
 * dispensar; depois pode ativar via /minha-loja → menu → "Ativar notificações".
 */

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bell, X } from 'lucide-react';
import { api } from '@/lib/api';

const LS_KEY_DISMISSED = 'lurd_push_banner_dismissed_at';
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// Helper: converte VAPID key base64url → Uint8Array (requerido pela API)
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function PushSubscriptionManager() {
  const pathname = usePathname();
  const [showBanner, setShowBanner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Não mostra em /login
  const isLogin = pathname === '/login' || pathname?.startsWith('/login');

  useEffect(() => {
    if (isLogin || typeof window === 'undefined') return;

    const token = window.localStorage?.getItem('flowops_token');
    if (!token) return; // não logado → não pede

    // Browser suporta?
    if (
      !('serviceWorker' in navigator) ||
      !('PushManager' in window) ||
      !('Notification' in window)
    ) {
      console.log('[push] browser não suporta — skip');
      return;
    }

    // Já foi dispensado recentemente?
    try {
      const lastDismissed = window.localStorage.getItem(LS_KEY_DISMISSED);
      if (lastDismissed) {
        const age = Date.now() - Number(lastDismissed);
        if (age < DISMISS_TTL_MS) return;
      }
    } catch {}

    // Verifica estado atual
    (async () => {
      try {
        const perm = Notification.permission;
        if (perm === 'denied') {
          // User já negou — não insiste
          return;
        }
        if (perm === 'default') {
          // Ainda não pediu — mostra banner discreto sugerindo
          setTimeout(() => setShowBanner(true), 8000); // espera 8s pra não atrapalhar
          return;
        }
        // perm === 'granted': já tem permissão. Verifica subscription.
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (!existing) {
          // Permissão OK mas subscription perdida → recria
          await subscribe(true);
        } else {
          // Tem subscription — manda pro backend pra garantir que tá registrada
          // (idempotente, backend reaproveita endpoint)
          await sendToBackend(existing).catch(() => {});
        }
      } catch (e: any) {
        console.warn('[push] erro ao checar estado:', e?.message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLogin]);

  const subscribe = async (silent = false) => {
    setBusy(true);
    setError(null);
    try {
      // Pede permissão (mostra prompt nativo do browser)
      if (Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        if (result !== 'granted') {
          if (!silent) setError('Permissão negada');
          dismiss();
          return;
        }
      }

      // Pega chave pública VAPID do backend
      const r = await api<{ publicKey: string | null }>('/push/vapid-public-key');
      if (!r?.publicKey) {
        setError('Servidor sem chave VAPID configurada');
        return;
      }

      // Cria subscription via service worker
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // exigido pelo Chrome — push tem que mostrar UI
        applicationServerKey: urlBase64ToUint8Array(r.publicKey),
      });

      // Manda pro backend gravar
      await sendToBackend(sub);
      setShowBanner(false);
      console.log('[push] subscription ativa');
    } catch (e: any) {
      console.warn('[push] subscribe falhou:', e?.message);
      if (!silent) setError(e?.message || 'Falha ao ativar');
    } finally {
      setBusy(false);
    }
  };

  const sendToBackend = async (sub: PushSubscription) => {
    const json = sub.toJSON();
    await api('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: json }),
    });
  };

  const dismiss = () => {
    setShowBanner(false);
    try {
      window.localStorage.setItem(LS_KEY_DISMISSED, String(Date.now()));
    } catch {}
  };

  if (isLogin || !showBanner) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-[9996] flex justify-center pointer-events-none">
      <div className="pointer-events-auto max-w-md w-full bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-2xl shadow-2xl p-4 flex items-center gap-3">
        <div className="w-12 h-12 bg-white/15 rounded-xl flex items-center justify-center flex-shrink-0">
          <Bell className="w-6 h-6" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm">Ativar notificações</div>
          <div className="text-xs opacity-90 leading-snug">
            Receba alerta de pedido novo no celular, mesmo com app fechado.
          </div>
          {error && (
            <div className="text-xs mt-1 bg-red-900/30 px-2 py-0.5 rounded">{error}</div>
          )}
        </div>
        <button
          onClick={() => subscribe(false)}
          disabled={busy}
          className="px-3 py-2 bg-white text-emerald-700 rounded-lg font-bold text-sm hover:bg-emerald-50 disabled:opacity-50 flex-shrink-0"
        >
          {busy ? '...' : 'Ativar'}
        </button>
        <button
          onClick={dismiss}
          className="p-1.5 hover:bg-white/15 rounded-lg flex-shrink-0"
          title="Agora não"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
