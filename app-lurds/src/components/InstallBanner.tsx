'use client';

import { useEffect, useState } from 'react';
import { X, Download, ChevronRight, ChevronLeft, Heart } from 'lucide-react';
import { usePWAInstall } from '@/hooks/usePWAInstall';

/**
 * Banner "Instalar o app" — versão MUITO DIDÁTICA pra senhoras +50.
 *
 * Princípios de design:
 *   - Linguagem maternal e simples ("amor", "vai ser fácil, vou te ensinar")
 *   - Botão GIGANTE dourado que não pode ser ignorado
 *   - Modal full-screen passo-a-passo (1 passo por tela, navega com Próximo)
 *   - Visual com emoji grandes + setas apontando + texto enorme
 *   - Sem jargão técnico ("PWA", "Service Worker", "manifest" = NÃO)
 *   - Botões de navegação na parte de baixo (mais fácil de alcançar)
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

  if (isInstalled || closed || dismissedRecently) return null;

  const handleDismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setClosed(true);
    onClose?.();
  };

  const handleInstallClick = async () => {
    if (canInstall) {
      const outcome = await install();
      if (outcome === 'accepted') {
        setClosed(true);
        onClose?.();
        return;
      }
    }
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
            className="absolute top-3 right-3 p-1.5 rounded-full bg-ink/10 hover:bg-ink/20 transition"
          >
            <X className="w-5 h-5 text-ink/70" />
          </button>

          <div className="flex items-start gap-3">
            <div className="shrink-0 w-14 h-14 rounded-2xl bg-ink flex items-center justify-center shadow-lg text-3xl">
              📲
            </div>
            <div className="flex-1 pr-6">
              <h3 className="font-serif text-xl font-black text-ink leading-tight">
                Guarda o app no seu celular
              </h3>
              <p className="text-sm text-ink/80 mt-1">
                Vai ser <strong>muito mais fácil</strong> ver as novidades! Eu te ensino, é rapidinho 💛
              </p>
              <button
                onClick={handleInstallClick}
                className="mt-3 w-full inline-flex items-center justify-center gap-2 bg-ink text-gold rounded-full px-5 py-3 text-base font-black uppercase tracking-wider active:scale-95 transition shadow-lg"
              >
                <Download className="w-5 h-5" />
                Quero instalar
              </button>
            </div>
          </div>
        </div>
      </div>

      {showModal && (
        <InstallWizard device={device} onClose={() => setShowModal(false)} onDone={() => {
          setShowModal(false);
          setClosed(true);
        }} />
      )}
    </>
  );
}

/* ══════════════════════════ HERO CARD ══════════════════════════
 * Card GIGANTE no topo da home — pra senhora não ter como perder.
 * Diferente do banner do rodapé: é grande, dourado, primeiro impacto visual.
 */
const ALREADY_INSTALLED_KEY = 'lurds_already_installed';

export function HeroInstallCard() {
  const { canInstall, isInstalled, install } = usePWAInstall();
  const [showModal, setShowModal] = useState(false);
  const [device, setDevice] = useState<Device>('other');
  const [dismissed, setDismissed] = useState(true); // Default true pra esconder durante hydration
  const [showInstalledCelebration, setShowInstalledCelebration] = useState(false);

  useEffect(() => {
    setDevice(detectDevice());

    // 1) Já marcou que tem o app? Esconde pra sempre
    if (window.localStorage.getItem(ALREADY_INSTALLED_KEY) === '1') {
      setDismissed(true);
      return;
    }

    // 2) Tá rodando em standalone (instalou)? Marca pra sempre + esconde
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true;
    if (isStandalone) {
      window.localStorage.setItem(ALREADY_INSTALLED_KEY, '1');
      setDismissed(true);
      return;
    }

    // 3) Dismissed temporário (24h)
    const stored = window.localStorage.getItem(DISMISS_KEY);
    if (stored) {
      const hours = (Date.now() - parseInt(stored)) / (1000 * 60 * 60);
      if (hours < DISMISS_HOURS) {
        setDismissed(true);
        return;
      }
    }

    // 4) Liberado pra mostrar
    setDismissed(false);

    // 5) Listener pro evento `appinstalled` — quando Android instala via prompt,
    // dispara comemoração apontando pro ícone na tela inicial
    const onInstalled = () => {
      window.localStorage.setItem(ALREADY_INSTALLED_KEY, '1');
      setShowInstalledCelebration(true);
    };
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  // Comemoração tem prioridade — aparece mesmo após instalar
  if (showInstalledCelebration) {
    return <InstalledCelebration onClose={() => setShowInstalledCelebration(false)} />;
  }
  if (isInstalled || dismissed) return null;

  const handleClick = async () => {
    if (canInstall) {
      const outcome = await install();
      if (outcome === 'accepted') {
        window.localStorage.setItem(ALREADY_INSTALLED_KEY, '1');
        setShowInstalledCelebration(true);
        return;
      }
    }
    setShowModal(true);
  };

  const handleDismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, Date.now().toString());
    setDismissed(true);
  };

  /** Cliente já tem o app — esconde pra sempre */
  const handleAlreadyHave = () => {
    window.localStorage.setItem(ALREADY_INSTALLED_KEY, '1');
    setDismissed(true);
  };

  return (
    <>
      <div className="mx-5 mt-4 relative">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-5 shadow-gold-lg">
          {/* Detalhes decorativos */}
          <div className="absolute -right-8 -top-8 w-32 h-32 bg-ink/10 rounded-full" />
          <div className="absolute -right-4 -bottom-4 w-20 h-20 bg-ink/10 rounded-full" />

          <button
            aria-label="Fechar"
            onClick={handleDismiss}
            className="absolute top-2 right-2 p-1.5 rounded-full bg-ink/15 hover:bg-ink/25 transition z-10"
          >
            <X className="w-4 h-4 text-ink/70" />
          </button>

          <div className="relative">
            <div className="flex items-center gap-3 mb-2">
              <div className="text-4xl">📲</div>
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold text-ink/70">
                  Acesso rápido
                </p>
                <h2 className="font-serif text-xl font-black text-ink leading-none">
                  Guarda o app no seu celular
                </h2>
              </div>
            </div>

            <p className="text-sm text-ink/85 leading-relaxed mt-2 pr-6">
              Fica <strong>muito mais fácil</strong> de abrir, e você recebe nossas promoções com sininho 🔔
            </p>

            <button
              onClick={handleClick}
              className="mt-4 w-full inline-flex items-center justify-center gap-2 bg-ink text-gold rounded-2xl px-5 py-4 text-base font-black uppercase tracking-wider active:scale-95 transition shadow-xl border-2 border-ink-700"
            >
              <Download className="w-5 h-5" />
              Quero instalar — É grátis
            </button>

            <button
              onClick={handleAlreadyHave}
              className="mt-2 w-full inline-flex items-center justify-center gap-2 bg-ink/10 text-ink rounded-2xl px-5 py-3 text-sm font-bold border-2 border-ink/30 active:scale-95 transition"
            >
              ✓ Já tenho o app instalado
            </button>

            <p className="text-center text-[10px] text-ink/60 mt-2">
              Eu te ensino passo a passo, é facinho 💛
            </p>
          </div>
        </div>
      </div>

      {showModal && (
        <InstallWizard device={device} onClose={() => setShowModal(false)} onDone={() => setShowModal(false)} />
      )}
    </>
  );
}

/* ══════════════════════════ WIZARD ══════════════════════════
 * Modal full-screen com passos numerados — 1 passo por tela.
 * Senhora avança com botão "Próximo" gigante embaixo.
 */
function InstallWizard({
  device,
  onClose,
  onDone,
}: {
  device: Device;
  onClose: () => void;
  onDone: () => void;
}) {
  const steps = getSteps(device);
  const [step, setStep] = useState(0);
  const isLast = step === steps.length - 1;
  const isFirst = step === 0;

  return (
    <div className="fixed inset-0 z-[100] bg-ink flex flex-col">
      {/* Header */}
      <div
        className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-ink-700"
        style={{ paddingTop: 'calc(1.25rem + env(safe-area-inset-top))' }}
      >
        <div>
          <p className="text-[10px] uppercase tracking-wider text-cream/50">
            Passo {step + 1} de {steps.length}
          </p>
          <h2 className="font-serif text-lg font-bold text-gold">Vamos instalar?</h2>
        </div>
        <button
          aria-label="Fechar"
          onClick={onClose}
          className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition"
        >
          <X className="w-6 h-6 text-cream" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="px-5 mt-3">
        <div className="h-1.5 bg-ink-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-gold to-gold-light transition-all"
            style={{ width: `${((step + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto px-5 py-6">
        {steps[step]}
      </div>

      {/* Bottom nav */}
      <div
        className="px-5 pt-3 pb-5 border-t border-ink-700 flex gap-3"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
      >
        {!isFirst && (
          <button
            onClick={() => setStep(step - 1)}
            className="flex-1 inline-flex items-center justify-center gap-2 bg-ink-800 text-cream rounded-full py-4 font-bold border border-ink-600"
          >
            <ChevronLeft className="w-5 h-5" />
            Voltar
          </button>
        )}
        <button
          onClick={() => (isLast ? onDone() : setStep(step + 1))}
          className="flex-1 inline-flex items-center justify-center gap-2 bg-gradient-to-br from-gold to-gold-light text-ink rounded-full py-4 font-black text-base uppercase tracking-wider active:scale-95 transition"
        >
          {isLast ? (
            <>Pronto! <Heart className="w-5 h-5" /></>
          ) : (
            <>Próximo <ChevronRight className="w-5 h-5" /></>
          )}
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════ STEPS POR DEVICE ══════════════════════════ */

function getSteps(device: Device) {
  if (device === 'ios-safari') return iosSafariSteps();
  if (device === 'ios-chrome') return iosChromeSteps();
  if (device === 'android-chrome') return androidSteps();
  return desktopSteps();
}

/* ─────── iOS Safari ─────── */
function iosSafariSteps() {
  return [
    <StepCard
      key="intro"
      emoji="💛"
      title="Oi, meu amor!"
      lead="Vou te mostrar como guardar o app Lurd's no seu iPhone"
      body={
        <>
          <p>É super rapidinho — <strong>3 toques</strong> e tá pronto.</p>
          <p className="mt-3">Depois você abre o app direto pela tela inicial, sem precisar digitar nada.</p>
        </>
      }
    />,
    <StepCard
      key="s1"
      emoji="👇"
      title="Toque AQUI embaixo"
      lead='No quadradinho com setinha pra cima'
      body={
        <>
          <div className="my-6 flex items-center justify-center">
            <ArrowDownAnimation>
              <div className="bg-ink-800 border border-gold rounded-2xl px-6 py-4 flex items-center gap-3">
                <ShareIconBig />
                <div className="text-left">
                  <div className="text-xs text-cream/60">É esse aqui</div>
                  <div className="text-sm font-bold text-gold">Compartilhar</div>
                </div>
              </div>
            </ArrowDownAnimation>
          </div>
          <p className="text-center text-cream/80">
            Tá <strong>embaixo no meio</strong> da tela do Safari.
          </p>
          <p className="text-center text-xs text-cream/50 mt-1">
            Se não aparecer, role a página pra cima.
          </p>
        </>
      }
    />,
    <StepCard
      key="s2"
      emoji="📲"
      title='Procure "Adicionar à Tela de Início"'
      lead='Vai abrir um menu — role pra baixo um pouquinho'
      body={
        <>
          <div className="my-6 mx-auto max-w-[260px]">
            <div className="bg-ink-800 border border-ink-600 rounded-2xl overflow-hidden">
              <div className="p-3 border-b border-ink-700 text-xs text-cream/50">Compartilhar</div>
              <div className="p-3 border-b border-ink-700 text-sm">Copiar</div>
              <div className="p-3 border-b border-ink-700 text-sm">Imprimir</div>
              <div className="p-3 bg-gold/20 border-2 border-gold flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gold flex items-center justify-center font-black text-ink">＋</div>
                <span className="text-sm font-bold text-gold">Adicionar à Tela de Início</span>
              </div>
              <div className="p-3 text-sm text-cream/50">Marcador</div>
            </div>
          </div>
          <p className="text-center text-cream/80">
            Toque nessa opção <strong className="text-gold">"Adicionar à Tela de Início"</strong>.
          </p>
        </>
      }
    />,
    <StepCard
      key="s3"
      emoji="✅"
      title='Toque em "Adicionar"'
      lead="Tá quase!"
      body={
        <>
          <div className="my-6 mx-auto max-w-[280px]">
            <div className="bg-ink-800 border border-ink-600 rounded-2xl p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-12 h-12 rounded-xl bg-gold flex items-center justify-center font-serif font-black text-ink text-lg">L</div>
                <div>
                  <div className="text-sm font-bold text-white">Lurd's Plus Size</div>
                  <div className="text-[10px] text-cream/50">app.lurds.com.br</div>
                </div>
              </div>
              <div className="flex justify-end">
                <div className="bg-gold text-ink font-black rounded-full px-6 py-2 text-sm shadow-lg border-2 border-gold animate-pulse">
                  Adicionar
                </div>
              </div>
            </div>
          </div>
          <p className="text-center text-cream/80">
            Vai aparecer um botão <strong className="text-gold">"Adicionar"</strong> no canto superior direito. Toque nele!
          </p>
        </>
      }
    />,
    <StepCard
      key="done"
      emoji="🎉"
      title="Prontinho, amor!"
      lead="Agora o app tá no seu celular"
      body={
        <>
          <p>Quando quiser abrir, é só procurar o <strong className="text-gold">ícone Lurd's</strong> na sua tela inicial, igual qualquer outro app.</p>
          <div className="mt-5 p-4 bg-gold/10 border border-gold/30 rounded-xl">
            <p className="text-sm">
              💡 <strong>Importante:</strong> da próxima vez, abra pelo ícone na tela — não pelo Safari. Aí você recebe nossas promoções com sininho 🔔
            </p>
          </div>
          <p className="mt-4 text-center text-sm text-cream/70">
            Qualquer dúvida, manda mensagem aqui pra gente 💛
          </p>
        </>
      }
    />,
  ];
}

/* ─────── iOS Chrome (não dá pra instalar) ─────── */
function iosChromeSteps() {
  return [
    <StepCard
      key="intro"
      emoji="⚠️"
      title="Oi, querida!"
      lead="No iPhone, só dá pra instalar pelo Safari"
      body={
        <>
          <p>O Chrome do iPhone não tem o botão de instalar — é uma regra da Apple, não tem como fugir.</p>
          <p className="mt-3">Mas é fácil resolver! Vou te ensinar.</p>
        </>
      }
    />,
    <StepCard
      key="s1"
      emoji="🧭"
      title="Procure o Safari no seu iPhone"
      lead="É o ícone azul de bússola"
      body={
        <>
          <div className="my-6 flex flex-col items-center gap-2">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-4xl shadow-xl">
              🧭
            </div>
            <p className="text-xs text-cream/50">Safari</p>
          </div>
          <p className="text-center text-cream/80">
            Toque nele pra abrir.
          </p>
        </>
      }
    />,
    <StepCard
      key="s2"
      emoji="⌨️"
      title="Digite o endereço"
      lead="Na barra de cima do Safari"
      body={
        <>
          <div className="my-6 mx-auto max-w-[300px]">
            <div className="bg-ink-800 border border-gold/40 rounded-xl p-3">
              <div className="text-[10px] text-cream/40 mb-1">Endereço</div>
              <div className="text-base font-mono font-bold text-gold">
                app.lurds.com.br
              </div>
            </div>
          </div>
          <p className="text-center text-cream/80">
            Digite <strong className="text-gold">app.lurds.com.br</strong> e toque em <strong>Ir</strong> no teclado.
          </p>
        </>
      }
    />,
    <StepCard
      key="s3"
      emoji="📲"
      title="Toque em Compartilhar e instalar"
      lead="Quando o app abrir no Safari"
      body={
        <>
          <p>
            Você vai ver de novo essa tela, e aí basta tocar em <strong className="text-gold">"Quero instalar"</strong>.
          </p>
          <p className="mt-3">
            Eu te mostro o passo a passo de novo, dessa vez no Safari, e vai dar certo 💛
          </p>
        </>
      }
    />,
  ];
}

/* ─────── Android Chrome ─────── */
function androidSteps() {
  return [
    <StepCard
      key="intro"
      emoji="💛"
      title="Oi, meu amor!"
      lead="No Android é facinho — 2 toques só"
      body={
        <>
          <p>Vou te mostrar onde clicar pra guardar o app no seu celular.</p>
          <p className="mt-3">Depois é só abrir o ícone Lurd's na tela inicial, igual qualquer outro app.</p>
        </>
      }
    />,
    <StepCard
      key="s1"
      emoji="👆"
      title="Toque nos 3 pontinhos"
      lead="No canto superior direito do Chrome"
      body={
        <>
          <div className="my-6 mx-auto max-w-[280px]">
            <div className="bg-ink-800 border border-ink-600 rounded-2xl p-3 flex items-center justify-between">
              <div className="text-xs text-cream/50">app.lurds.com.br</div>
              <div className="flex items-center gap-3">
                <div className="text-cream/40">🔄</div>
                <div className="flex flex-col gap-0.5 p-2 rounded-full bg-gold/20 border-2 border-gold animate-pulse">
                  <span className="w-1 h-1 bg-gold rounded-full" />
                  <span className="w-1 h-1 bg-gold rounded-full" />
                  <span className="w-1 h-1 bg-gold rounded-full" />
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-gold/80 mt-2">↑ É aqui</p>
          </div>
          <p className="text-center text-cream/80">
            Os 3 pontinhos ficam <strong>em cima, no lado direito</strong>.
          </p>
        </>
      }
    />,
    <StepCard
      key="s2"
      emoji="📲"
      title='Escolha "Instalar app"'
      lead='Ou "Adicionar à tela inicial"'
      body={
        <>
          <div className="my-6 mx-auto max-w-[260px]">
            <div className="bg-ink-800 border border-ink-600 rounded-2xl overflow-hidden">
              <div className="p-3 border-b border-ink-700 text-sm">Nova guia</div>
              <div className="p-3 border-b border-ink-700 text-sm">Histórico</div>
              <div className="p-3 bg-gold/20 border-2 border-gold flex items-center gap-3">
                <Download className="w-5 h-5 text-gold" />
                <span className="text-sm font-bold text-gold">Instalar app</span>
              </div>
              <div className="p-3 border-b border-ink-700 text-sm">Compartilhar</div>
              <div className="p-3 text-sm text-cream/50">Configurações</div>
            </div>
          </div>
          <p className="text-center text-cream/80">
            Vai abrir um menu — escolha <strong className="text-gold">"Instalar app"</strong>.
          </p>
        </>
      }
    />,
    <StepCard
      key="done"
      emoji="🎉"
      title="Prontinho!"
      lead="O app já tá no seu celular"
      body={
        <>
          <p>O ícone Lurd's vai aparecer junto com seus outros aplicativos.</p>
          <div className="mt-5 p-4 bg-gold/10 border border-gold/30 rounded-xl">
            <p className="text-sm">
              💡 Da próxima vez, abra pelo ícone na tela inicial — vai dar pra receber promoções com notificação 🔔
            </p>
          </div>
        </>
      }
    />,
  ];
}

/* ─────── Desktop ─────── */
function desktopSteps() {
  return [
    <StepCard
      key="intro"
      emoji="📱"
      title="Pra instalar, abra no celular"
      lead="O app foi feito pro telefone"
      body={
        <>
          <p>Abra esse endereço no Chrome ou Safari do seu celular:</p>
          <div className="mt-4 bg-ink-900 rounded-xl p-5 font-mono text-lg text-gold text-center font-bold border border-gold/30">
            app.lurds.com.br
          </div>
          <p className="mt-4 text-sm text-cream/70 text-center">
            No iPhone, abra no <strong>Safari</strong>. No Android, <strong>Chrome</strong>.
          </p>
        </>
      }
    />,
  ];
}

/* ══════════════════════════ ATOMS ══════════════════════════ */

function StepCard({
  emoji,
  title,
  lead,
  body,
}: {
  emoji: string;
  title: string;
  lead: string;
  body: React.ReactNode;
}) {
  return (
    <div className="max-w-md mx-auto text-cream">
      <div className="text-center mb-5">
        <div className="text-6xl mb-3">{emoji}</div>
        <h3 className="font-serif text-2xl font-black text-gold leading-tight">{title}</h3>
        <p className="text-base text-cream/80 mt-1">{lead}</p>
      </div>
      <div className="text-base leading-relaxed">{body}</div>
    </div>
  );
}

function ShareIconBig() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d4af37" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M12 14V3" />
      <path d="M8 7l4-4 4 4" />
    </svg>
  );
}

function ArrowDownAnimation({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 text-gold animate-bounce">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <polyline points="19 12 12 19 5 12" />
        </svg>
      </div>
    </div>
  );
}

/* ════════════════════ COMEMORAÇÃO APÓS INSTALAR ════════════════════
 * Tela cheia comemorando que cliente acabou de instalar.
 * Não dá pra abrir o app standalone automaticamente (limitação Android/iOS),
 * então mostramos uma tela GIGANTE pra ela sair do navegador e procurar
 * o ícone Lurd's na tela inicial.
 */
function InstalledCelebration({ onClose }: { onClose: () => void }) {
  // Auto-fecha após 30s (caso ela não interaja)
  useEffect(() => {
    const t = setTimeout(onClose, 30000);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] bg-gradient-to-br from-ink via-ink-800 to-ink flex flex-col"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Confetti decorativo */}
      <div className="absolute top-10 left-8 text-3xl animate-bounce" style={{ animationDelay: '0s' }}>🎉</div>
      <div className="absolute top-20 right-10 text-2xl animate-bounce" style={{ animationDelay: '0.3s' }}>✨</div>
      <div className="absolute top-32 left-16 text-2xl animate-bounce" style={{ animationDelay: '0.6s' }}>💛</div>
      <div className="absolute top-12 right-20 text-3xl animate-bounce" style={{ animationDelay: '0.9s' }}>🎊</div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="text-7xl mb-4 animate-pulse">🎉</div>
        <h1 className="font-serif text-3xl font-black text-gold leading-tight">
          Instalado!
        </h1>
        <p className="text-base text-cream/80 mt-3 max-w-xs">
          Seu app Lurd's tá guardado no seu celular 💛
        </p>

        {/* Card com instrução */}
        <div className="mt-8 w-full max-w-sm bg-ink-800 border-2 border-gold/40 rounded-3xl p-5">
          <div className="text-center text-xs uppercase tracking-widest text-gold/70 font-bold mb-3">
            Como abrir daqui pra frente:
          </div>

          <div className="flex items-start gap-3 mb-3">
            <div className="shrink-0 w-9 h-9 rounded-full bg-gold text-ink font-black font-serif text-lg flex items-center justify-center">
              1
            </div>
            <div className="text-sm text-cream/90 text-left pt-1">
              Sai dessa tela do navegador
            </div>
          </div>

          <div className="flex items-start gap-3 mb-3">
            <div className="shrink-0 w-9 h-9 rounded-full bg-gold text-ink font-black font-serif text-lg flex items-center justify-center">
              2
            </div>
            <div className="text-sm text-cream/90 text-left pt-1">
              Procura o ícone <strong className="text-gold">Lurd's</strong> na sua tela inicial
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="shrink-0 w-9 h-9 rounded-full bg-gold text-ink font-black font-serif text-lg flex items-center justify-center">
              3
            </div>
            <div className="text-sm text-cream/90 text-left pt-1">
              Abre tocando nele
            </div>
          </div>

          {/* Preview do ícone */}
          <div className="mt-5 flex justify-center">
            <div className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-gold via-gold-light to-gold flex items-center justify-center font-serif font-black text-ink text-3xl shadow-2xl animate-pulse">
                L
              </div>
              <div className="text-[10px] text-cream/60 mt-1">Lurd's</div>
            </div>
          </div>
        </div>

        <div className="mt-6 p-3 bg-emerald-900/30 border border-emerald-500/30 rounded-2xl flex items-center gap-2">
          <div className="text-xl">🔔</div>
          <div className="text-xs text-cream/85 text-left leading-relaxed">
            <strong className="text-emerald-300">Importante:</strong> só abrindo pelo ícone que você recebe nossas promoções com notificação.
          </div>
        </div>
      </div>

      <div className="px-6 pb-6">
        <button
          onClick={onClose}
          className="btn-gold-lg w-full"
        >
          Entendi! Vou abrir pelo ícone 💛
        </button>
      </div>
    </div>
  );
}
