'use client';

import { useEffect, useState } from 'react';
import { X, Download, Apple, Share, Plus, Gift, AlertCircle } from 'lucide-react';
import { usePWAInstall } from '@/hooks/usePWAInstall';

/**
 * Banner "📲 Instale o app Lurd's" — versão pragmática:
 *   - SEMPRE aparece (até instalar), pra cliente não perder a opção
 *   - Click abre MODAL com instruções específicas por device
 *   - Android Chrome: tenta prompt nativo primeiro, fallback pra modal manual
 *   - iOS Safari: modal com 3 passos visuais (Compartilhar → Adicionar)
 *   - iOS Chrome: avisa pra abrir no Safari
 *   - Dismiss dura só 1 dia (ou seja: volta no próximo acesso)
 */
const DISMISS_KEY = 'lurds_install_dismissed_at';
const DISMISS_HOURS = 24;

type Device = 'android-chrome' | 'ios-safari' | 'ios-chrome' | 'desktop' | 'other';

function detectDevice(): Device {
  if (typeof window === 'undefined') return 'other';
  const ua = window.navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
  const isAndroid = /Android/.test(ua);
  if (isIOS) {
    const isCriOS = /CriOS|FxiOS|EdgiOS/.test(ua);
    return isCriOS ? 'ios-chrome' : 'ios-safari';
  }
  if (isAndroid) return 'android-chrome';
  // Desktop
  if (!('ontouchstart' in window)) return 'desktop';
  return 'other';
}

export default function InstallBanner({ onClose }: { onClose?: () => void }) {
  const { canInstall, isInstalled, install } = usePWAInstall();
  const [closed, setClosed] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [device, setDevice] = useState<Device>('other');
  const [dismissedRecently, setDismissedRecently] = useState(false);

  useEffect(() => {
    setDevice(detectDevice());
    const dismissed = window.localStorage.getItem(DISMISS_KEY);
    if (dismissed) {
      const hours = (Date.now() - parseInt(dismissed)) / (1000 * 60 * 60);
      if (hours < DISMISS_HOURS) setDismissedRecently(true);
    }
  }, []);

  // Já instalado? Nem mostra.
  if (isInstalled || closed || dismissedRecently) return null;

  const handleDismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setClosed(true);
    onClose?.();
  };

  const handleInstallClick = async () => {
    // Android Chrome: tenta prompt nativo
    if (canInstall) {
      const outcome = await install();
      if (outcome === 'accepted') {
        setClosed(true);
        onClose?.();
        return;
      }
    }
    // Senão: abre modal com instruções manuais
    setShowModal(true);
  };

  return (
    <>
      <div
        className="fixed bottom-20 left-1/2 -translate-x-1/2 w-[calc(100%-1.5rem)] max-w-[400px] z-50"
        style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-5 shadow-gold-lg">
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
              <button
                onClick={handleInstallClick}
                className="mt-3 inline-flex items-center gap-1.5 bg-ink text-gold rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider active:scale-95 transition"
              >
                <Download className="w-3.5 h-3.5" />
                Instalar agora
              </button>
            </div>
          </div>
        </div>
      </div>

      {showModal && (
        <InstallInstructionsModal device={device} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}

/* ──────────────────── MODAL DE INSTRUÇÕES ──────────────────── */
function InstallInstructionsModal({
  device,
  onClose,
}: {
  device: Device;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] bg-ink/90 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-ink-800 border border-gold/30 rounded-3xl p-6 shadow-2xl animate-slide-up"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-serif text-xl font-black text-gold">
            Instalar o app Lurd's
          </h3>
          <button
            aria-label="Fechar"
            onClick={onClose}
            className="p-1.5 rounded-full bg-ink-700 hover:bg-ink-600 transition"
          >
            <X className="w-5 h-5 text-cream" />
          </button>
        </div>

        {device === 'ios-safari' && (
          <div className="space-y-4">
            <p className="text-sm text-cream/80">
              No iPhone, é em 3 toques:
            </p>
            <div className="space-y-3">
              <Step
                n={1}
                title="Toque no botão Compartilhar"
                desc="Embaixo no centro do Safari"
                icon={<Share className="w-5 h-5" />}
              />
              <Step
                n={2}
                title='Procure "Adicionar à Tela de Início"'
                desc="Role um pouquinho pra baixo"
                icon={<Plus className="w-5 h-5" />}
              />
              <Step
                n={3}
                title='Toque em "Adicionar"'
                desc="Pronto! O ícone Lurd's vai aparecer na tela inicial"
                icon={<Download className="w-5 h-5" />}
              />
            </div>
            <div className="mt-4 p-3 bg-gold/10 border border-gold/30 rounded-xl text-xs text-cream/80">
              💡 Depois de instalar, abra pelo <strong>ícone Lurd's</strong> na sua tela — não pelo Safari.
            </div>
          </div>
        )}

        {device === 'ios-chrome' && (
          <div className="space-y-4">
            <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl flex gap-3">
              <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm text-cream">
                <p className="font-bold mb-1">No iPhone, só dá pra instalar pelo Safari</p>
                <p className="text-xs text-cream/70">
                  O Chrome do iPhone não tem o botão de instalar. É uma restrição da Apple.
                </p>
              </div>
            </div>
            <div className="space-y-2 text-sm text-cream/80">
              <p className="font-bold">Como fazer:</p>
              <ol className="list-decimal list-inside space-y-1 text-xs">
                <li>Copie este endereço: <strong className="text-gold">app.lurds.com.br</strong></li>
                <li>Abra o Safari (ícone azul de bússola)</li>
                <li>Cole na barra e abra</li>
                <li>Toque em Compartilhar → Adicionar à Tela de Início</li>
              </ol>
            </div>
          </div>
        )}

        {device === 'android-chrome' && (
          <div className="space-y-4">
            <p className="text-sm text-cream/80">
              No Android é em 2 toques:
            </p>
            <div className="space-y-3">
              <Step
                n={1}
                title="Toque nos 3 pontinhos do Chrome"
                desc="Canto superior direito"
              />
              <Step
                n={2}
                title='Escolha "Instalar app" ou "Adicionar à tela inicial"'
                desc="O ícone Lurd's vai aparecer na sua tela"
                icon={<Download className="w-5 h-5" />}
              />
            </div>
            <div className="mt-4 p-3 bg-gold/10 border border-gold/30 rounded-xl text-xs text-cream/80">
              💡 Se o botão de instalar aparecer em cima, é mais rápido — pode tocar ali direto.
            </div>
          </div>
        )}

        {(device === 'desktop' || device === 'other') && (
          <div className="space-y-3 text-sm text-cream/80">
            <p>
              Abra <strong className="text-gold">app.lurds.com.br</strong> direto no celular pra instalar:
            </p>
            <div className="bg-ink-900 rounded-xl p-4 font-mono text-xs text-gold text-center">
              app.lurds.com.br
            </div>
            <p className="text-xs text-cream/60">
              No Android você verá um botão "Instalar" no Chrome.<br />
              No iPhone, abra no Safari, toque em Compartilhar → Adicionar à Tela de Início.
            </p>
          </div>
        )}

        <button
          onClick={onClose}
          className="btn-gold w-full mt-5"
        >
          Entendi
        </button>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  desc,
  icon,
}: {
  n: number;
  title: string;
  desc: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-8 h-8 rounded-full bg-gold text-ink font-black flex items-center justify-center text-sm">
        {n}
      </div>
      <div className="flex-1">
        <div className="font-bold text-sm text-white flex items-center gap-2">
          {icon && <span className="text-gold">{icon}</span>}
          {title}
        </div>
        <p className="text-xs text-cream/60 mt-0.5">{desc}</p>
      </div>
    </div>
  );
}
