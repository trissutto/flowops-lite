'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Bell, BellOff, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import { useWebPush } from '@/hooks/useWebPush';

export default function PrefNotificacoesPage() {
  const { isSupported, isSubscribed, permission, loading, enable, disable } = useWebPush();
  const [err, setErr] = useState<string | null>(null);

  const handleToggle = async () => {
    setErr(null);
    try {
      if (isSubscribed) await disable();
      else await enable();
    } catch (e: any) {
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

      {/* Card principal — push real */}
      <section className="mt-6 px-5">
        <div className="card-gold-border bg-gradient-to-br from-gold/10 to-transparent">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-xl bg-gold/20 flex items-center justify-center">
              {isSubscribed ? (
                <Bell className="w-6 h-6 text-gold" />
              ) : (
                <BellOff className="w-6 h-6 text-cream/40" />
              )}
            </div>
            <div className="flex-1">
              <h2 className="font-bold text-white">Notificações Push</h2>
              <p className="text-[11px] text-cream/60">
                {isSubscribed ? 'Ativas neste dispositivo' : 'Desativadas'}
              </p>
            </div>
          </div>

          {!isSupported && (
            <div className="text-sm text-cream/70 bg-ink-800 rounded-lg p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                Seu navegador não suporta notificações.{' '}
                <strong className="text-gold">No iPhone:</strong> abre no Safari → toca em compartilhar → "Adicionar à tela de início".
              </span>
            </div>
          )}

          {isSupported && permission === 'denied' && (
            <div className="text-sm text-rose-200 bg-rose-900/30 border border-rose-700/50 rounded-lg p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
              <span>
                Você bloqueou notificações. Pra liberar: ícone de cadeado na URL → permissões → notificações → permitir.
              </span>
            </div>
          )}

          {isSupported && permission !== 'denied' && (
            <button
              onClick={handleToggle}
              disabled={loading}
              className={isSubscribed ? 'btn-outline-gold w-full' : 'btn-gold-lg w-full'}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Carregando...
                </>
              ) : isSubscribed ? (
                'Desativar notificações'
              ) : (
                <>
                  <Bell className="w-4 h-4" />
                  Ativar notificações
                </>
              )}
            </button>
          )}

          {err && (
            <div className="mt-3 text-xs text-rose-200 bg-rose-900/30 p-2 rounded">{err}</div>
          )}
        </div>
      </section>

      {/* Lista do que cliente vai receber */}
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
