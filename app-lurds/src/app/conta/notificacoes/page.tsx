'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Bell, BellOff, Loader2, AlertCircle, CheckCircle2,
  Share, Plus, Smartphone, ArrowDown, Sparkles, LogIn,
} from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import { useWebPush } from '@/hooks/useWebPush';

export default function PrefNotificacoesPage() {
  const router = useRouter();
  const {
    isSupported, isSubscribed, permission, loading, enable, disable,
    isIOS, isStandalone, needsInstallFirst,
  } = useWebPush();
  const [err, setErr] = useState<string | null>(null);

  const handleToggle = async () => {
    setErr(null);
    try {
      if (isSubscribed) await disable();
      else await enable();
    } catch (e: any) {
      // Login obrigatório — redireciona em vez de mostrar erro
      if (e?.message === 'LOGIN_REQUIRED') {
        router.push('/login?next=/conta/notificacoes');
        return;
      }
      setErr(e?.message || 'Erro');
    }
  };

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/conta" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Notificações</h1>
      </header>

      {/* ═══════════════ iOS NÃO INSTALADO — wizard ═══════════════ */}
      {needsInstallFirst ? (
        <IOSInstallWizard />
      ) : (
        /* ═══════════════ Android OU iOS com PWA instalado ═══════════════ */
        <PushToggle
          isSupported={isSupported}
          isSubscribed={isSubscribed}
          permission={permission}
          loading={loading}
          err={err}
          onToggle={handleToggle}
        />
      )}

      {/* O que recebe — sempre visível */}
      <section className="mt-6 px-5 space-y-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-cream/40 px-1">
          O que você recebe quando ativa:
        </p>
        {[
          { icon: '🎯', label: 'Promoções e ofertas exclusivas' },
          { icon: '📺', label: 'Aviso quando começar uma Live' },
          { icon: '💸', label: 'Cashback expirando em 7 dias' },
          { icon: '📦', label: 'Status do seu pedido' },
          { icon: '🎁', label: 'Cupons exclusivos do app' },
        ].map((it) => (
          <div key={it.label} className="card-dark flex items-center gap-3">
            <span className="text-xl shrink-0">{it.icon}</span>
            <span className="text-sm">{it.label}</span>
            {isSubscribed && (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 ml-auto shrink-0" />
            )}
          </div>
        ))}
      </section>

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}

/* ═════════════════ COMPONENTE: TOGGLE NORMAL ═════════════════ */
function PushToggle({
  isSupported, isSubscribed, permission, loading, err, onToggle,
}: {
  isSupported: boolean; isSubscribed: boolean;
  permission: NotificationPermission; loading: boolean;
  err: string | null; onToggle: () => void;
}) {
  return (
    <section className="mt-6 px-5">
      <div className="card-gold-border bg-gradient-to-br from-gold/10 to-transparent">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-xl bg-gold/20 flex items-center justify-center">
            {isSubscribed
              ? <Bell className="w-6 h-6 text-gold" />
              : <BellOff className="w-6 h-6 text-cream/40" />}
          </div>
          <div className="flex-1">
            <h2 className="font-bold text-white">Notificações Push</h2>
            <p className="text-[11px] text-cream/60">
              {isSubscribed ? '✅ Ativas neste dispositivo' : 'Desativadas'}
            </p>
          </div>
        </div>

        {!isSupported && (
          <div className="text-sm text-cream/70 bg-ink-800 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <span>Seu navegador não suporta notificações.</span>
          </div>
        )}

        {isSupported && permission === 'denied' && (
          <div className="text-sm text-rose-200 bg-rose-900/30 border border-rose-700/50 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
            <div>
              <strong>Notificações bloqueadas pelo navegador.</strong>
              <p className="mt-1">Toca no cadeado na URL → Permissões → Notificações → Permitir.</p>
            </div>
          </div>
        )}

        {isSupported && permission !== 'denied' && (
          <button
            onClick={onToggle}
            disabled={loading}
            className={isSubscribed ? 'btn-outline-gold w-full' : 'btn-gold-lg w-full'}
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</>
            ) : isSubscribed ? (
              'Desativar notificações'
            ) : (
              <><Bell className="w-4 h-4" /> Ativar notificações</>
            )}
          </button>
        )}

        {err && (
          <div className="mt-3 text-xs text-rose-200 bg-rose-900/30 p-2 rounded">{err}</div>
        )}
      </div>
    </section>
  );
}

/* ═════════════════ COMPONENTE: WIZARD iOS ═════════════════ */
function IOSInstallWizard() {
  return (
    <>
      {/* Banner topo: explicação amigável */}
      <section className="mt-6 px-5">
        <div className="card-gold-border bg-gradient-to-br from-gold/15 to-transparent text-center">
          <div className="text-4xl mb-2">📱✨</div>
          <h2 className="font-serif text-xl font-bold text-white">
            Falta 1 passo no iPhone
          </h2>
          <p className="text-sm text-cream/70 mt-2">
            A Apple não deixa receber notificações enquanto vc usa pelo navegador.<br/>
            <strong className="text-gold">Adiciona o app à tela inicial primeiro</strong> (leva 10 segundos).
          </p>
        </div>
      </section>

      {/* 3 passos visuais GRANDES */}
      <section className="mt-6 px-5 space-y-4">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 px-1">
          ⤵️ Faz nesta ordem:
        </h3>

        {/* Passo 1 */}
        <div className="card-gold-border bg-ink-800 p-5">
          <div className="flex items-start gap-4">
            <div className="shrink-0 w-12 h-12 rounded-full bg-gold text-ink font-black font-serif text-2xl flex items-center justify-center shadow-gold">
              1
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-white mb-1">Toca em compartilhar</h4>
              <p className="text-sm text-cream/70">
                Olha pra <strong>baixo</strong> no Safari.
                Toca no botão{' '}
                <span className="inline-flex items-center gap-1 bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded font-bold">
                  <Share className="w-4 h-4" /> Compartilhar
                </span>{' '}
                (quadrado com seta pra cima).
              </p>
            </div>
          </div>
          {/* Seta indicando rodapé */}
          <div className="mt-3 flex justify-center">
            <ArrowDown className="w-6 h-6 text-gold animate-bounce" />
          </div>
        </div>

        {/* Passo 2 */}
        <div className="card-gold-border bg-ink-800 p-5">
          <div className="flex items-start gap-4">
            <div className="shrink-0 w-12 h-12 rounded-full bg-gold text-ink font-black font-serif text-2xl flex items-center justify-center shadow-gold">
              2
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-white mb-1">"Adicionar à Tela de Início"</h4>
              <p className="text-sm text-cream/70">
                Rola um pouco pra baixo no menu que abriu. Toca em{' '}
                <span className="inline-flex items-center gap-1 bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded font-bold">
                  <Plus className="w-4 h-4" /> Adicionar à Tela de Início
                </span>.
              </p>
            </div>
          </div>
        </div>

        {/* Passo 3 */}
        <div className="card-gold-border bg-ink-800 p-5">
          <div className="flex items-start gap-4">
            <div className="shrink-0 w-12 h-12 rounded-full bg-gold text-ink font-black font-serif text-2xl flex items-center justify-center shadow-gold">
              3
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-white mb-1">Abre pelo ÍCONE</h4>
              <p className="text-sm text-cream/70">
                Vai aparecer um <strong className="text-gold">ícone Lurd's</strong> na sua tela inicial.
                <strong> Fecha o Safari</strong> e abre o app tocando nesse ícone.
              </p>
              <div className="mt-3 flex items-center gap-2 p-3 bg-gold/10 border border-gold/30 rounded-xl">
                <Smartphone className="w-5 h-5 text-gold shrink-0" />
                <span className="text-xs text-cream/90">
                  Quando abrir pelo ícone, esta tela vai mudar e o botão "Ativar" vai aparecer.
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Resultado esperado */}
      <section className="mt-6 px-5">
        <div className="rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-5 text-ink">
          <div className="flex items-start gap-3">
            <Sparkles className="w-6 h-6 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-serif text-lg font-black">Por que esse trabalho?</h3>
              <p className="text-sm mt-1 opacity-90">
                A Apple só libera notificações no iPhone pra apps "instalados".
                Depois desse passo único, vc recebe ofertas direto na tela como qualquer app normal 💛
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Alternativa: tutorial visual completo */}
      <section className="mt-5 px-5">
        <Link
          href="/install/ios"
          className="block text-center text-sm text-gold/80 underline"
        >
          Quer ver com mais detalhes? Tutorial completo →
        </Link>
      </section>
    </>
  );
}
