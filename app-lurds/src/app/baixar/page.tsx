'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  Download, Share, Plus, Sparkles, Gift, Bell, Heart,
  Smartphone, Apple, CheckCircle2, ArrowDown, Loader2,
} from 'lucide-react';

/**
 * /baixar — landing pública de download/instalação do app.
 *
 * URL pra divulgar: app.lurds.com.br/baixar
 *
 * Detecta automaticamente:
 *   - Já instalado (standalone) → "Vc já tem! Abrir"
 *   - Android Chrome → botão grande "Instalar agora" (beforeinstallprompt)
 *   - iOS Safari → wizard 3 passos
 *   - Chrome iOS / desktop / outros → instruções
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export default function BaixarPage() {
  const [device, setDevice] = useState<'loading' | 'ios-safari' | 'ios-chrome' | 'android' | 'desktop' | 'installed'>('loading');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ua = window.navigator.userAgent;

    // Já instalado?
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    if (standalone) {
      setDevice('installed');
      return;
    }

    // iOS?
    const ios = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
    if (ios) {
      // Chrome iOS é WebKit camuflado — pra instalar precisa Safari
      const iosChrome = /CriOS/.test(ua);
      setDevice(iosChrome ? 'ios-chrome' : 'ios-safari');
      return;
    }

    // Android?
    if (/Android/i.test(ua)) {
      setDevice('android');
      // Captura prompt nativo do Chrome Android
      const handler = (e: Event) => {
        e.preventDefault();
        setDeferredPrompt(e as BeforeInstallPromptEvent);
      };
      window.addEventListener('beforeinstallprompt', handler);
      return () => window.removeEventListener('beforeinstallprompt', handler);
    }

    // Desktop
    setDevice('desktop');
  }, []);

  const handleAndroidInstall = async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') setDevice('installed');
      setDeferredPrompt(null);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="min-h-dvh bg-gradient-to-b from-ink to-ink-800 pb-12">
      {/* HERO */}
      <header className="px-6 pt-10 pb-6 text-center">
        <Image
          src="/images/logo-branco.png"
          alt="Lurd's Plus Size"
          width={200} height={108}
          priority
          className="h-20 w-auto mx-auto"
        />
        <h1 className="mt-6 font-serif text-3xl font-black leading-tight">
          Baixa o <span className="text-gold-gradient italic">App</span>
        </h1>
        <p className="mt-2 text-cream/70 text-sm">
          Promoções, cashback e lives em primeira mão 💛
        </p>
      </header>

      {/* BENEFÍCIOS */}
      <section className="px-6 mb-8">
        <div className="grid grid-cols-2 gap-3">
          <Benefit icon={<Gift className="w-5 h-5" />} label="R$ 20 grátis" sub="na 1ª compra" />
          <Benefit icon={<Sparkles className="w-5 h-5" />} label="10% cashback" sub="em toda compra" />
          <Benefit icon={<Bell className="w-5 h-5" />} label="Promoções" sub="exclusivas" />
          <Benefit icon={<Heart className="w-5 h-5" />} label="Aviso Live" sub="quando começar" />
        </div>
      </section>

      {/* CTA POR DEVICE */}
      <section className="px-6">
        {device === 'loading' && (
          <div className="text-center py-12">
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-gold" />
          </div>
        )}

        {device === 'installed' && <AlreadyInstalled />}
        {device === 'android' && (
          <AndroidInstall
            canPrompt={!!deferredPrompt}
            onInstall={handleAndroidInstall}
            installing={installing}
          />
        )}
        {device === 'ios-safari' && <IOSSafariInstall />}
        {device === 'ios-chrome' && <IOSChromeRedirect />}
        {device === 'desktop' && <DesktopInstructions />}
      </section>

      {/* RODAPÉ */}
      <footer className="mt-12 text-center text-xs text-cream/40">
        Lurd's Plus Size — Moda Plus
      </footer>
    </div>
  );
}

function Benefit({ icon, label, sub }: { icon: React.ReactNode; label: string; sub: string }) {
  return (
    <div className="card-dark text-center">
      <div className="text-gold flex justify-center mb-1">{icon}</div>
      <div className="font-bold text-sm">{label}</div>
      <div className="text-[10px] text-cream/60 uppercase tracking-wider mt-0.5">{sub}</div>
    </div>
  );
}

/* ═══════════════ Cenários ═══════════════ */

function AlreadyInstalled() {
  return (
    <div className="card-gold-border bg-gold/10 text-center">
      <CheckCircle2 className="w-12 h-12 mx-auto text-gold" />
      <h2 className="font-serif text-xl font-bold mt-3">Vc já tem o app!</h2>
      <p className="text-sm text-cream/70 mt-1">
        Continue navegando — está tudo pronto.
      </p>
      <Link href="/" className="btn-gold mt-4 inline-flex">
        Ir pra home
      </Link>
    </div>
  );
}

function AndroidInstall({ canPrompt, onInstall, installing }: {
  canPrompt: boolean; onInstall: () => void; installing: boolean;
}) {
  if (canPrompt) {
    return (
      <div className="space-y-3">
        <button
          onClick={onInstall}
          disabled={installing}
          className="w-full btn-gold-lg shadow-gold-lg"
        >
          {installing ? (
            <><Loader2 className="w-5 h-5 animate-spin" /> Instalando...</>
          ) : (
            <><Download className="w-5 h-5" /> Instalar agora</>
          )}
        </button>
        <p className="text-center text-xs text-cream/60">
          Vai aparecer um pop-up perguntando "Adicionar". Toque em <strong>Instalar</strong>.
        </p>
      </div>
    );
  }

  // Sem prompt nativo (browser não suporta ou já dispensou) — fallback manual
  return (
    <div className="space-y-4">
      <div className="card-gold-border bg-gradient-to-br from-gold/10 to-transparent">
        <h3 className="font-bold flex items-center gap-2">
          <Smartphone className="w-5 h-5 text-gold" />
          Pra instalar no seu Android:
        </h3>
        <ol className="mt-3 space-y-2 text-sm text-cream/80">
          <li><strong>1.</strong> Toca no menu (⋮ 3 pontinhos) do navegador</li>
          <li><strong>2.</strong> Toca em <strong className="text-gold">"Instalar app"</strong> ou <strong className="text-gold">"Adicionar à tela inicial"</strong></li>
          <li><strong>3.</strong> Confirma</li>
          <li><strong>4.</strong> Abre pelo ícone "Lurd's" que apareceu</li>
        </ol>
      </div>
      <Link href="/" className="btn-outline-gold w-full">
        Continuar sem instalar
      </Link>
    </div>
  );
}

function IOSSafariInstall() {
  return (
    <div className="space-y-4">
      <div className="card-gold-border bg-gradient-to-br from-gold/15 to-transparent text-center">
        <Apple className="w-10 h-10 mx-auto text-gold" />
        <h2 className="font-serif text-xl font-black mt-2">No iPhone, 3 passos:</h2>
      </div>

      <Step
        n={1}
        title="Toca em Compartilhar"
        body={<>O ícone <span className="inline-flex items-center gap-1 bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded font-bold"><Share className="w-3.5 h-3.5" />⬆</span> no rodapé do Safari.</>}
        arrow
      />
      <Step
        n={2}
        title={'"Adicionar à Tela de Início"'}
        body={<>Rola um pouco no menu que abriu e toca em <span className="inline-flex items-center gap-1 bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded font-bold"><Plus className="w-3.5 h-3.5" /> Adicionar à Tela de Início</span></>}
      />
      <Step
        n={3}
        title="Abre pelo ícone Lurd's"
        body={<>Vai aparecer um ícone preto/dourado na sua tela. <strong>Fecha o Safari</strong> e abre pelo ícone.</>}
      />
    </div>
  );
}

function IOSChromeRedirect() {
  return (
    <div className="card-gold-border bg-amber-900/20 border-amber-600/40 text-center">
      <Apple className="w-12 h-12 mx-auto text-amber-300" />
      <h2 className="font-serif text-xl font-bold mt-3">Abre no Safari</h2>
      <p className="text-sm text-cream/80 mt-2">
        No iPhone, instalar app só funciona pelo <strong className="text-gold">Safari</strong>.
      </p>
      <p className="text-sm text-cream/70 mt-3">
        Copia este link e cola no Safari:
      </p>
      <button
        onClick={() => navigator.clipboard?.writeText('https://app.lurds.com.br/baixar')}
        className="btn-gold mt-3 inline-flex"
      >
        📋 Copiar link
      </button>
    </div>
  );
}

function DesktopInstructions() {
  return (
    <div className="card-dark text-center">
      <Smartphone className="w-12 h-12 mx-auto text-gold" />
      <h2 className="font-serif text-xl font-bold mt-3">Abre no celular</h2>
      <p className="text-sm text-cream/70 mt-2">
        Esse app é feito pra celular. Abre <strong>app.lurds.com.br/baixar</strong> no seu celular pra instalar.
      </p>
      <div className="bg-ink p-3 rounded-lg mt-4 font-mono text-xs break-all text-gold">
        app.lurds.com.br/baixar
      </div>
    </div>
  );
}

function Step({ n, title, body, arrow }: {
  n: number; title: string; body: React.ReactNode; arrow?: boolean;
}) {
  return (
    <div className="card-dark">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-10 h-10 rounded-full bg-gold text-ink font-black font-serif text-xl flex items-center justify-center shadow-gold">
          {n}
        </div>
        <div className="flex-1">
          <h4 className="font-bold text-white">{title}</h4>
          <p className="text-sm text-cream/70 mt-1">{body}</p>
        </div>
      </div>
      {arrow && (
        <div className="mt-3 flex justify-center">
          <ArrowDown className="w-5 h-5 text-gold animate-bounce" />
        </div>
      )}
    </div>
  );
}
