'use client';

/**
 * PwaInstallBanner — banner inferior "Instale o app" no primeiro acesso.
 *
 * Como funciona:
 *  - Android Chrome dispara evento `beforeinstallprompt` quando detecta
 *    que o site é instalável (manifest + service worker + HTTPS).
 *  - Capturamos esse evento e mostramos UM banner discreto pedindo pra
 *    vendedora instalar (vira ícone na home screen, app fullscreen).
 *  - Se ela aceitar, chamamos prompt() pra abrir o instalador nativo.
 *  - Se ela dispensar, gravamos em localStorage e não mostra mais por 7 dias.
 *
 * iOS Safari não suporta beforeinstallprompt — tem outro fluxo (compartilhar
 * → Adicionar à tela inicial). Pra iOS mostramos um popover de instrução
 * diferente (detectado por user agent).
 */

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { X, Download, Share } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const LS_KEY_DISMISSED = 'lurd_pwa_install_dismissed_at';
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

export default function PwaInstallBanner() {
  const pathname = usePathname();
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Detecta se já está rodando como PWA instalado (não precisa mostrar banner)
    const isInStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    if (isInStandalone) {
      setIsStandalone(true);
      return;
    }

    // Verifica se user dispensou recentemente
    try {
      const lastDismissed = window.localStorage.getItem(LS_KEY_DISMISSED);
      if (lastDismissed) {
        const ageMs = Date.now() - Number(lastDismissed);
        if (ageMs < DISMISS_TTL_MS) return;
      }
    } catch {}

    // Android Chrome / Edge: captura prompt nativo
    const handler = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // iOS Safari: detecta via user agent (não tem beforeinstallprompt)
    const ua = window.navigator.userAgent.toLowerCase();
    const isIos = /iphone|ipad|ipod/.test(ua) && !/chrome|crios|fxios/.test(ua);
    if (isIos) {
      // Aguarda 5s antes de mostrar (não atrapalha login)
      const t = setTimeout(() => setShowIosHint(true), 5000);
      return () => {
        clearTimeout(t);
        window.removeEventListener('beforeinstallprompt', handler);
      };
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const install = async () => {
    if (!promptEvent) return;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        setPromptEvent(null);
      } else {
        dismiss();
      }
    } catch {
      dismiss();
    }
  };

  const dismiss = () => {
    setPromptEvent(null);
    setShowIosHint(false);
    try {
      window.localStorage.setItem(LS_KEY_DISMISSED, String(Date.now()));
    } catch {}
  };

  // Páginas públicas da cliente (cadastro / fechamento da compra) — sem chrome de app
  if (pathname?.startsWith('/cadastro-live') || pathname?.startsWith('/pagar') || pathname?.startsWith('/p/') || pathname?.startsWith('/meu-pedido')) return null;

  // Já instalado → não mostra nada
  if (isStandalone) return null;

  // Android Chrome — banner padrão com botão "Instalar"
  if (promptEvent) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-[9997] flex justify-center pointer-events-none">
        <div className="pointer-events-auto max-w-md w-full bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white rounded-2xl shadow-2xl p-4 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="w-12 h-12 bg-white/15 rounded-xl flex items-center justify-center flex-shrink-0">
            <Download className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm">Instale como app</div>
            <div className="text-xs opacity-90 truncate">
              Acesso rápido + notificações de pedidos
            </div>
          </div>
          <button
            onClick={install}
            className="px-3 py-2 bg-white text-violet-700 rounded-lg font-bold text-sm hover:bg-violet-50 flex-shrink-0"
          >
            Instalar
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

  // iOS Safari — instrução manual (não tem prompt API)
  if (showIosHint) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-[9997] flex justify-center pointer-events-none">
        <div className="pointer-events-auto max-w-md w-full bg-slate-900 text-white rounded-2xl shadow-2xl p-4 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className="w-12 h-12 bg-violet-600/30 rounded-xl flex items-center justify-center flex-shrink-0">
            <Share className="w-6 h-6 text-violet-300" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm">Adicionar à tela inicial</div>
            <div className="text-xs opacity-80 leading-snug mt-0.5">
              Toque em <Share className="w-3 h-3 inline -mt-0.5" /> e depois em
              "<b>Adicionar à Tela de Início</b>"
            </div>
          </div>
          <button
            onClick={dismiss}
            className="p-1.5 hover:bg-white/15 rounded-lg flex-shrink-0"
            title="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return null;
}
