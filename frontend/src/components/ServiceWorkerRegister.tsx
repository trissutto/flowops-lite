'use client';

/**
 * ServiceWorkerRegister — registra /sw.js no boot do app.
 *
 * Auto-update: check imediato + a cada 5 min. Quando descobre versão
 * nova, recarrega automaticamente. Resolve o problema do PWA instalado
 * que nunca pegava UI nova até desinstalar/reinstalar.
 */

import { useEffect } from 'react';

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          // SEMPRE busca o sw.js do servidor (sem cache HTTP)
          updateViaCache: 'none',
        });
        console.log('[SW] registrado', reg.scope);

        // Check imediato — pega versão nova mesmo se PWA tá aberto há dias
        reg.update().catch(() => {});

        // Quando descobre versão nova, recarrega automaticamente
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'activated' && navigator.serviceWorker.controller) {
              console.log('[SW] versao nova ativa — recarregando');
              setTimeout(() => window.location.reload(), 500);
            }
          });
        });

        // Check periódico a cada 5 min
        setInterval(() => {
          reg.update().catch(() => {});
        }, 5 * 60 * 1000);
      } catch (e) {
        console.warn('[SW] falha ao registrar:', e);
      }
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }, []);

  return null;
}
