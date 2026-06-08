'use client';

import { useEffect, useState, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { Loader2, Share, Plus, ArrowDown, Smartphone } from 'lucide-react';
import { isLoggedIn } from '@/lib/api';

/**
 * AppGate — proteção em camadas pra forçar o caminho ótimo:
 *
 *   1. Cliente NÃO logada → manda pra /entrar (cadastro obrigatório)
 *   2. iOS Safari mas NÃO instalou PWA → tela cheia obrigando instalação
 *   3. Tudo OK → renderiza children normal
 *
 * Aplicar nas páginas que precisam de conteúdo + push (home, conta, cashback, pedidos).
 * NÃO aplicar em: /entrar, /login, /cadastro, /privacidade, /termos, /baixar, /install/*
 */
export default function AppGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);
  const [shouldBlockIOS, setShouldBlockIOS] = useState(false);

  useEffect(() => {
    // Camada 1: login
    if (!isLoggedIn()) {
      router.replace(`/entrar?next=${encodeURIComponent(pathname || '/')}`);
      return;
    }

    // Camada 2: iOS Safari sem PWA instalado → bloqueia
    const ua = window.navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;

    if (isIOS && !isStandalone) {
      // Cliente pode ter dispensado o gate antes (5min de tolerância pra ela navegar)
      const skipUntil = Number(window.localStorage.getItem('lurds_ios_gate_skip') || 0);
      if (Date.now() < skipUntil) {
        setShouldBlockIOS(false);
      } else {
        setShouldBlockIOS(true);
      }
    }

    setChecked(true);
  }, [router, pathname]);

  if (!checked) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold" />
      </div>
    );
  }

  if (shouldBlockIOS) {
    return <IOSInstallGate onSkip={() => {
      // Cliente pode pular por 30min — mas vai voltar a aparecer
      window.localStorage.setItem('lurds_ios_gate_skip', String(Date.now() + 30 * 60 * 1000));
      setShouldBlockIOS(false);
    }} />;
  }

  return <>{children}</>;
}

/* ════════════════════ TELA BLOQUEIO iOS ════════════════════ */
function IOSInstallGate({ onSkip }: { onSkip: () => void }) {
  const [phase, setPhase] = useState<'share' | 'menu' | 'add'>('share');

  // Auto-anima a sequência share → menu → add → share (loop)
  useEffect(() => {
    const phases: Array<'share' | 'menu' | 'add'> = ['share', 'menu', 'add'];
    let i = 0;
    const interval = setInterval(() => {
      i = (i + 1) % phases.length;
      setPhase(phases[i]);
    }, 1800);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-dvh flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      {/* Header */}
      <div className="flex items-center justify-center pt-8 pb-2">
        <Image
          src="/images/logo-branco.png"
          alt="Lurd's"
          width={100} height={55}
          className="h-10 w-auto"
          priority
        />
      </div>

      <div className="flex-1 px-6 pb-8 flex flex-col items-center text-center">
        <h1 className="font-serif text-2xl font-black text-white mt-4">
          Salva o app primeiro 💛
        </h1>
        <p className="text-base text-cream/70 mt-2 max-w-xs">
          Pra você ver promoções em 1ª mão, a Apple exige que o app esteja salvo no celular. <strong className="text-gold">Leva 10 segundos.</strong>
        </p>

        {/* ANIMAÇÃO LIVE — 3 cenas em loop */}
        <div className="w-full max-w-[280px] mt-6 mb-6 bg-ink-800 border border-gold/30 rounded-3xl overflow-hidden">
          <div className="aspect-[9/16] flex items-center justify-center relative">
            {/* Cena 1: tap no Share */}
            {phase === 'share' && (
              <div className="absolute inset-0 flex flex-col justify-end p-6 animate-fade-in">
                <div className="text-xs text-cream/50 mb-1 text-center">1. Toca aqui ↓</div>
                <div className="flex justify-center">
                  <div className="bg-blue-500/20 border-2 border-blue-400 rounded-2xl p-3 animate-pulse">
                    <Share className="w-8 h-8 text-blue-300" />
                  </div>
                </div>
                <div className="mt-2 flex justify-center">
                  <ArrowDown className="w-6 h-6 text-gold animate-bounce" />
                </div>
              </div>
            )}
            {/* Cena 2: menu abre */}
            {phase === 'menu' && (
              <div className="absolute inset-0 flex flex-col p-4 animate-fade-in">
                <div className="text-xs text-cream/50 mb-2 text-center">2. Procura essa opção ↓</div>
                <div className="bg-ink-900 rounded-2xl border border-ink-600 overflow-hidden mt-auto mb-3">
                  <div className="p-2 text-[10px] text-cream/40 border-b border-ink-700">Compartilhar</div>
                  <div className="p-2 text-xs text-cream/70 border-b border-ink-700">Copiar</div>
                  <div className="p-2 text-xs text-cream/70 border-b border-ink-700">Marcador</div>
                  <div className="p-2 bg-emerald-500/20 border-2 border-emerald-400 flex items-center gap-2 animate-pulse">
                    <div className="w-5 h-5 rounded bg-emerald-400 text-ink font-black text-xs flex items-center justify-center">＋</div>
                    <span className="text-xs font-bold text-emerald-300">Adicionar à Tela de Início</span>
                  </div>
                  <div className="p-2 text-xs text-cream/40">Imprimir</div>
                </div>
              </div>
            )}
            {/* Cena 3: dialog Adicionar */}
            {phase === 'add' && (
              <div className="absolute inset-0 flex flex-col justify-center p-6 animate-fade-in">
                <div className="text-xs text-cream/50 mb-3 text-center">3. Toca em Adicionar</div>
                <div className="bg-ink-900 border border-ink-600 rounded-2xl p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-10 h-10 rounded-xl bg-gold flex items-center justify-center font-serif font-black text-ink">L</div>
                    <div className="text-left">
                      <div className="text-xs font-bold text-white">Lurd's Plus Size</div>
                      <div className="text-[9px] text-cream/40">app.lurds.com.br</div>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <div className="bg-gold text-ink font-black rounded-full px-4 py-1.5 text-xs animate-pulse shadow-lg">
                      Adicionar
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <Link
          href="/install/ios"
          className="btn-gold-lg w-full max-w-sm"
        >
          Me ensina passo a passo
        </Link>

        <button
          onClick={onSkip}
          className="mt-4 text-xs text-cream/40 underline"
        >
          Continuar sem instalar (não recebo promoções)
        </button>
      </div>
    </div>
  );
}
