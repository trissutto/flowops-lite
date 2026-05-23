'use client';

/**
 * ServiceWorkerRegister — registra /sw.js no boot do app.
 *
 * Por que precisa: Android Chrome só dispara o evento "beforeinstallprompt"
 * (que ativa o banner de instalar) se houver um SW ativo. Sem isso, o PWA
 * não é instalável.
 *
 * Roda só no browser (use client). Em dev local roda igual; em produção,
 * o Vercel serve /sw.js direto do public/ com Cache-Control correto.
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
        });
        // Log silencioso pra debug — vendedora não vê
        console.log('[SW] registrado', reg.scope);
      } catch (e) {
        console.warn('[SW] falha ao registrar:', e);
      }
    };
    // Aguarda load pra não competir com requests críticas iniciais
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }, []);

  return null;
}
