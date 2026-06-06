'use client';

import { useEffect, useState } from 'react';

/**
 * Hook que detecta se o app pode ser instalado e gerencia o prompt.
 *
 * Android (Chrome/Edge): captura `beforeinstallprompt` e expõe `install()`.
 * iOS (Safari): não tem evento — retorna `isIOS=true` pra mostrar tutorial.
 * Já instalado (standalone): retorna `isInstalled=true` pra esconder banner.
 */
export type PWAInstallState = {
  canInstall: boolean;        // Android: tem prompt nativo disponível
  isIOS: boolean;             // iOS Safari (precisa de tutorial)
  isInstalled: boolean;       // já está rodando em modo standalone
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export function usePWAInstall(): PWAInstallState {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Detecta iOS (Safari)
    const ua = window.navigator.userAgent;
    const ios = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
    setIsIOS(ios);

    // Detecta se já está rodando como PWA instalado
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    setIsInstalled(standalone);

    // Captura evento de instalação Android
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // Quando instalado, esconde banner
    const installedHandler = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };
    window.addEventListener('appinstalled', installedHandler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installedHandler);
    };
  }, []);

  const install = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPrompt) return 'unavailable';
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return outcome;
  };

  return {
    canInstall: !!deferredPrompt,
    isIOS,
    isInstalled,
    install,
  };
}
