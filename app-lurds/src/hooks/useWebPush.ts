'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  getPushPublicKey, pushSubscribeApi, pushUnsubscribeApi,
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

  // Detecta suporte + estado inicial
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const supported =
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      typeof Notification !== 'undefined';
    setIsSupported(supported);
    if (!supported) return;

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
    setLoading(true);
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

      // 2) Pega VAPID public key do backend
      const { key } = await getPushPublicKey();
      if (!key) throw new Error('Push não configurado no servidor.');

      // 3) Cria subscription via Service Worker
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
      setSubscription(sub);

      // 4) Manda pro backend
      const json = sub.toJSON() as any;
      await pushSubscribeApi({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      });
      return true;
    } finally {
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
