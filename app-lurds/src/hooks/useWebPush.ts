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

    // Pré-aquece o SW: assim quando a cliente clicar "Sim, quero receber",
    // o `serviceWorker.ready` já tá resolvido (instantâneo) em vez de
    // esperar 5-15s pra acordar do background.
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      setSubscription(sub);
    }).catch(() => {});
  }, []);

  const enable = useCallback(async () => {
    if (!isSupported) {
      throw new Error('Seu navegador não suporta notificações.');
    }
    if (!isLoggedIn()) {
      throw new Error('LOGIN_REQUIRED');
    }

    setLoading(true);

    // Helper pra time-cap qualquer Promise individualmente
    const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} (${ms / 1000}s)`)), ms),
        ),
      ]);

    const log = (step: string, info?: any) =>
      // eslint-disable-next-line no-console
      console.log(`[push] ${step}`, info ?? '');

    try {
      log('1 start');

      // ════ 1) PERMISSÃO ════
      let perm = Notification.permission;
      log('1 current permission', perm);
      if (perm === 'default') {
        perm = await new Promise<NotificationPermission>((resolve) => {
          let settled = false;
          const finish = (r: NotificationPermission) => {
            if (settled) return;
            settled = true;
            log('1 permission decided', r);
            resolve(r);
          };
          try {
            const maybe = Notification.requestPermission((r) => finish(r));
            if (maybe && typeof (maybe as any).then === 'function') {
              (maybe as Promise<NotificationPermission>).then(finish, () => finish('denied'));
            }
          } catch (e: any) {
            log('1 requestPermission throw', e?.message);
            finish('denied');
          }
          // Safety 15s
          setTimeout(() => finish(Notification.permission || 'default'), 15000);
        });
      }
      setPermission(perm);
      if (perm !== 'granted') {
        throw new Error(
          perm === 'denied'
            ? 'Notificações foram bloqueadas. Vai nas Configurações do celular → Lurd\'s → Notificações → Permitir.'
            : 'Você precisa permitir as notificações pra continuar.',
        );
      }

      // ════ 2) VAPID KEY ════
      log('2 fetching VAPID key');
      let key: string | null = null;
      try {
        const r = await withTimeout(getPushPublicKey(), 8000, 'Servidor demorou demais');
        key = r.key;
      } catch (e: any) {
        log('2 vapid error', e?.message);
        throw new Error('Não consegui falar com o servidor. Tenta de novo em 30 segundos.');
      }
      if (!key) throw new Error('Notificações não configuradas — me avisa pelo WhatsApp se aparecer esse erro.');
      log('2 vapid OK');

      // ════ 3) SERVICE WORKER ════
      log('3 awaiting SW ready');
      let reg: ServiceWorkerRegistration;
      try {
        reg = await withTimeout(navigator.serviceWorker.ready, 25000, 'App ainda carregando');
      } catch (e: any) {
        log('3 SW error', e?.message);
        // Recovery: tenta registrar agora se não tem
        try {
          reg = await withTimeout(navigator.serviceWorker.register('/sw.js'), 10000, 'Não consegui preparar o app');
        } catch (e2: any) {
          log('3 SW register error', e2?.message);
          throw new Error('Fecha o app e abre de novo pelo ícone Lurd\'s na tela inicial, depois tenta ativar.');
        }
      }
      log('3 SW ready');

      // ════ 4) SUBSCRIPTION ════
      // SEMPRE desinscreve a sub anterior antes de criar nova.
      // Motivo: se VAPID key foi rotacionada (ou cliente tinha sub stale),
      // tentar reusar a antiga ou criar por cima dela falha com "applicationServerKey
      // diferente" e a cliente fica sem push pra sempre.
      const existing = await reg.pushManager.getSubscription().catch(() => null);
      if (existing) {
        log('4 unsubscribing existing (stale)');
        await existing.unsubscribe().catch(() => null);
      }
      let sub: PushSubscription;
      log('4 creating new subscription');
      try {
        sub = await withTimeout(
          reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
          }),
          20000,
          'Falha ao registrar no servidor de notificações',
        );
      } catch (e: any) {
        log('4 subscribe error', e?.message);
        // Tenta UMA segunda vez — alguns devices precisam de re-tentar após cleanup
        try {
          await new Promise((r) => setTimeout(r, 1000));
          sub = await withTimeout(
            reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
            }),
            15000,
            'Falha ao registrar no servidor (2ª tentativa)',
          );
          log('4 subscribe OK on retry');
        } catch (e2: any) {
          log('4 subscribe retry error', e2?.message);
          throw new Error('Falha registrando seu celular. Fecha o app, abre de novo e tenta — se persistir, me avisa.');
        }
      }
      setSubscription(sub);

      // ════ 5) BACKEND ════
      log('5 sending to backend');
      const json = sub.toJSON() as any;
      try {
        await withTimeout(
          pushSubscribeApi({
            endpoint: json.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
          }),
          8000,
          'Servidor demorou demais',
        );
      } catch (e: any) {
        log('5 backend error', e?.message);
        throw new Error('Funcionou no celular mas não consegui avisar nosso servidor. Tenta de novo.');
      }

      log('6 DONE — push ativo');
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
