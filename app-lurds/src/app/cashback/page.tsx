'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Wallet, TrendingUp, Gift, Sparkles, Loader2, Clock,
  ArrowDownToLine, ArrowUpFromLine, AlertCircle, CheckCircle2,
} from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import {
  getCashbackStatement, isLoggedIn, type CashbackStatement, type CashbackTx,
} from '@/lib/api';

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const TYPE_INFO: Record<CashbackTx['type'], {
  icon: any; color: string; label: string; sign: '+' | '−';
}> = {
  earn:    { icon: ArrowDownToLine, color: 'text-emerald-400', label: 'Cashback compra', sign: '+' },
  welcome: { icon: Gift,            color: 'text-gold',        label: 'Bônus boas-vindas', sign: '+' },
  redeem:  { icon: ArrowUpFromLine, color: 'text-rose-300',    label: 'Usado em compra',   sign: '−' },
  expire:  { icon: Clock,           color: 'text-amber-300',   label: 'Expirado',          sign: '−' },
  adjust:  { icon: Sparkles,        color: 'text-cream/60',    label: 'Ajuste',            sign: '+' },
};

export default function CashbackPage() {
  const router = useRouter();
  const [data, setData] = useState<CashbackStatement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/login?next=/cashback');
      return;
    }
    getCashbackStatement()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [router]);

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Meu Cashback</h1>
      </header>

      {loading && (
        <div className="text-center py-16 text-cream/60">
          <Loader2 className="w-8 h-8 animate-spin mx-auto" />
        </div>
      )}

      {data && (
        <>
          {/* Saldo principal */}
          <section className="mt-6 px-5">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-6 text-ink shadow-gold-lg">
              <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest opacity-70">
                <Wallet className="w-4 h-4" />
                Saldo disponível
              </div>
              <div className="mt-2 font-serif text-5xl font-black tabular-nums">
                {brl(data.balance)}
              </div>
              <div className="mt-2 text-sm opacity-80">
                Use na sua próxima compra (loja física ou site)
              </div>
            </div>
          </section>

          {/* Alerta de expiração próxima */}
          {data.nextExpiration && data.nextExpiration.daysLeft <= 7 && (
            <section className="mt-3 px-5">
              <div className="card-gold-border bg-amber-900/20 border-amber-600/40 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <strong className="text-amber-200">
                    {brl(data.nextExpiration.amount)} expira em {data.nextExpiration.daysLeft}{' '}
                    {data.nextExpiration.daysLeft === 1 ? 'dia' : 'dias'}
                  </strong>
                  <p className="text-amber-100/70 mt-0.5">
                    Aproveita pra usar — depois disso, o valor some.
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* Cards de status */}
          <section className="mt-5 px-5 grid grid-cols-2 gap-3">
            <div className="card-dark">
              <TrendingUp className="w-5 h-5 text-gold mb-2" />
              <div className="text-[10px] uppercase tracking-wider text-cream/60 font-bold">
                Já ganhei
              </div>
              <div className="text-xl font-bold mt-0.5">{brl(data.earned)}</div>
            </div>
            <div className="card-dark">
              <Sparkles className="w-5 h-5 text-gold mb-2" />
              <div className="text-[10px] uppercase tracking-wider text-cream/60 font-bold">
                Já usei
              </div>
              <div className="text-xl font-bold mt-0.5">{brl(data.spent)}</div>
            </div>
          </section>

          {/* Como funciona */}
          <section className="mt-7 px-5">
            <h2 className="font-serif text-lg font-bold mb-3">Como funciona</h2>
            <div className="space-y-3 text-sm text-cream/70">
              <div className="card-dark flex items-start gap-3">
                <span className="text-2xl">🛍️</span>
                <div>
                  <strong className="text-white">Compre</strong> em qualquer loja Lurd's ou no site usando seu CPF.
                </div>
              </div>
              <div className="card-dark flex items-start gap-3">
                <span className="text-2xl">💰</span>
                <div>
                  <strong className="text-white">Ganhe {data.rate}%</strong> do valor em cashback,
                  válido por <strong>{data.ttlDays} dias</strong>.
                </div>
              </div>
              <div className="card-dark flex items-start gap-3">
                <span className="text-2xl">🎁</span>
                <div>
                  <strong className="text-white">Use</strong> na próxima compra — desconto direto no caixa.
                </div>
              </div>
            </div>
          </section>

          {/* Extrato */}
          <section className="mt-8 px-5">
            <h2 className="font-serif text-lg font-bold mb-3">Extrato</h2>
            {data.transactions.length === 0 ? (
              <div className="card-dark text-center py-8 text-cream/50 text-sm">
                Sem movimentações ainda.<br />
                Faça sua primeira compra pra começar 💛
              </div>
            ) : (
              <div className="space-y-2">
                {data.transactions.map((t) => {
                  const info = TYPE_INFO[t.type];
                  const Icon = info.icon;
                  return (
                    <div key={t.id} className="card-dark flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl bg-ink-700 flex items-center justify-center shrink-0 ${info.color}`}>
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-white line-clamp-1">
                          {t.description || info.label}
                        </div>
                        <div className="text-[11px] text-cream/50 mt-0.5">
                          {new Date(t.date).toLocaleDateString('pt-BR')}
                          {t.expiresAt && t.type === 'earn' && (
                            <> · vale até {new Date(t.expiresAt).toLocaleDateString('pt-BR')}</>
                          )}
                        </div>
                      </div>
                      <div className={`text-sm font-bold tabular-nums shrink-0 ${info.color}`}>
                        {info.sign}{brl(Math.abs(t.amount))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}
