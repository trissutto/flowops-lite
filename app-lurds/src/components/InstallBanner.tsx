'use client';

import { useState } from 'react';
import { X, Download, Apple, Smartphone, Gift } from 'lucide-react';
import Link from 'next/link';
import { usePWAInstall } from '@/hooks/usePWAInstall';

/**
 * Banner inteligente "📲 Instale o app Lurd's".
 *
 * Comportamento:
 *   - Android (Chrome): mostra botão "Instalar" → chama prompt nativo
 *   - iOS (Safari): mostra botão "Como instalar" → leva pro tutorial visual
 *   - Já instalado: nem renderiza
 *   - Cliente dismiss: guarda em localStorage e não mostra por 7 dias
 *
 * Visual: card dourado/preto sticky no rodapé, sobre Bottom Nav.
 */
const DISMISS_KEY = 'lurds_install_dismissed_at';
const DISMISS_DAYS = 7;

export default function InstallBanner({ onClose }: { onClose?: () => void }) {
  const { canInstall, isIOS, isInstalled, install } = usePWAInstall();
  const [closed, setClosed] = useState(false);

  // Já instalado? Nem mostra.
  if (isInstalled || closed) return null;

  // Já dispensou nos últimos 7 dias?
  if (typeof window !== 'undefined') {
    const dismissed = window.localStorage.getItem(DISMISS_KEY);
    if (dismissed) {
      const days = (Date.now() - parseInt(dismissed)) / (1000 * 60 * 60 * 24);
      if (days < DISMISS_DAYS) return null;
    }
  }

  // Nem Android pode instalar nem iOS — não mostra
  if (!canInstall && !isIOS) return null;

  const handleDismiss = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DISMISS_KEY, Date.now().toString());
    }
    setClosed(true);
    onClose?.();
  };

  const handleInstallClick = async () => {
    if (canInstall) {
      const outcome = await install();
      if (outcome === 'accepted') {
        setClosed(true);
        onClose?.();
      }
    }
    // iOS é tratado por Link (tutorial)
  };

  return (
    <div
      className="fixed bottom-20 left-1/2 -translate-x-1/2 w-[calc(100%-1.5rem)] max-w-[400px]
                 z-50 animate-slide-up"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-5 shadow-gold-lg">
        {/* Close */}
        <button
          aria-label="Fechar"
          onClick={handleDismiss}
          className="absolute top-3 right-3 p-1 rounded-full bg-ink/10 hover:bg-ink/20 transition"
        >
          <X className="w-4 h-4 text-ink/70" />
        </button>

        <div className="flex items-start gap-3">
          <div className="shrink-0 w-12 h-12 rounded-2xl bg-ink flex items-center justify-center shadow-lg">
            <Gift className="w-6 h-6 text-gold" />
          </div>
          <div className="flex-1 pr-6">
            <h3 className="font-serif text-lg font-black text-ink leading-tight">
              Instale o app
            </h3>
            <p className="text-xs text-ink/80 mt-0.5">
              Promoções em 1ª mão + R$ 20 grátis
            </p>

            {/* Android: instalação direta */}
            {canInstall && (
              <button
                onClick={handleInstallClick}
                className="mt-3 inline-flex items-center gap-1.5 bg-ink text-gold rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider active:scale-95 transition"
              >
                <Download className="w-3.5 h-3.5" />
                Instalar agora
              </button>
            )}

            {/* iOS: leva pro tutorial */}
            {isIOS && !canInstall && (
              <Link
                href="/install/ios"
                className="mt-3 inline-flex items-center gap-1.5 bg-ink text-gold rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider active:scale-95 transition"
              >
                <Apple className="w-3.5 h-3.5" />
                Como instalar
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
