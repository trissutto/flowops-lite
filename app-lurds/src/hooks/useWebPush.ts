'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  getPushPublicKey, pushSubscribeApi, pushUnsubscribeApi, isLoggedIn,
} from '@/lib/api';

/**
 * Hook que gerencia Web Push subscription do cliente.
 *
 * Estados:
 *   - permission: 'default' | 'granted' | 'denied'
 *   - subscription: null | PushSubscription
 *   - isSupported: boolean — navegador suporta Web Push
 *
 * Métodos:
 *   - enable() — pede permissão + cria subscription + manda pro backend
 *   - disable() — desinscreve no backend e no browser
 *
 * iOS: Web Push só funciona em iOS 16.4+ E SOMENTE depois que o cliente
 * adicionou o app à tela de início. Antes disso, `Notification` é undefined.
 */
export function useWebPush() {
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [isSupported, setIsSupported] = useState(false);
  const [loading, setLoading] = useState(false);
  // iOS detection — push exige PWA INSTALADO (display-mode standalone)
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  // Detecta suporte + estado inicial
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Detecta iOS (iPhone/iPad)
    const ua = window.navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
    setIsIOS(ios);

    // Detecta se app está rodando como PWA (Add to Home Screen no iOS)
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    setIsStandalone(standalone);

    // Suporte real: Notification API existe E (no iOS) está em standalone
    const supported =
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      typeof Notification !== 'undefined' &&
      (!ios || standalone);

    setIsSupported(supported);
    if (!supported || typeof Notification === 'undefined') return;

    setPermission(Notification.permission);

    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      setSubscription(sub);
    }).catch(() => {});
  }, []);

  const enable = useCallback(async () => {
    if (!isSupported) {
      throw new Error('Seu navegador não suporta notificações.');
    }

    // ⚠️ CRÍTICO: verifica login ANTES — sem JWT, backend rejeita e a UI
    // ficaria travada em "Carregando" durante o redirect pro login.
    if (!isLoggedIn()) {
      throw new Error('LOGIN_REQUIRED');
    }

    setLoading(true);
    // Timeout de segurança: se qualquer etapa travar > 15s, libera o botão
    const safetyTimeout = setTimeout(() => setLoading(false), 15000);

    try {
      // 1) Pede permissão (se ainda não pediu)
      let perm = Notification.permission;
      if (perm === 'default') {
        perm = await Notification.requestPermission();
      }
      setPermission(perm);
      if (perm !== 'granted') {
        throw new Error(
          perm === 'denied'
            ? 'Notificações foram bloqueadas. Libera nas configurações do navegador.'
            : 'Você precisa permitir notificações.',
        );
      }

      // 2) Pega VAPID public key do backend (público, sem JWT)
      const { key } = await getPushPublicKey();
      if (!key) throw new Error('Push não configurado no servidor.');

      // 3) Cria subscription via Service Worker
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
      setSubscription(sub);

      // 4) Manda pro backend (precisa de JWT — já verificamos acima)
      const json = sub.toJSON() as any;
      await pushSubscribeApi({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      });
      return true;
    } finally {
      clearTimeout(safetyTimeout);
      setLoading(false);
    }
  }, [isSupported]);

  const disable = useCallback(async () => {
    if (!subscription) return;
    setLoading(true);
    try {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe().catch(() => null);
      await pushUnsubscribeApi(endpoint).catch(() => null);
      setSubscription(null);
    } finally {
      setLoading(false);
    }
  }, [subscription]);

  return {
    isSupported,
    permission,
    isSubscribed: !!subscription,
    loading,
    enable,
    disable,
    // iOS state — UI decide se mostra wizard ou botão direto
    isIOS,
    isStandalone,
    needsInstallFirst: isIOS && !isStandalone,
  };
}

/** Converte base64 URL-safe pra Uint8Array (formato exigido pelo PushManager) */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
