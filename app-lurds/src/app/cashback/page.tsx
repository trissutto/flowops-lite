'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Wallet, TrendingUp, Gift, Sparkles, Loader2, Clock,
  ArrowDownToLine, ArrowUpFromLine, AlertCircle, ChevronDown,
} from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import {
  getCashbackStatement, isLoggedIn, type CashbackStatement, type CashbackTx,
} from '@/lib/api';

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const TYPE_INFO: Record<CashbackTx['type'], {
  icon: any; color: string; label: string; sign: '+' | '−'; group: 'in' | 'out';
}> = {
  earn:    { icon: ArrowDownToLine, color: 'text-emerald-400', label: 'Cashback compra',   sign: '+', group: 'in'  },
  welcome: { icon: Gift,            color: 'text-gold',        label: 'Bônus boas-vindas', sign: '+', group: 'in'  },
  redeem:  { icon: ArrowUpFromLine, color: 'text-rose-300',    label: 'Usado em compra',   sign: '−', group: 'out' },
  expire:  { icon: Clock,           color: 'text-amber-300',   label: 'Expirado',          sign: '−', group: 'out' },
  adjust:  { icon: Sparkles,        color: 'text-cream/60',    label: 'Ajuste',            sign: '+', group: 'in'  },
};

type Filter = 'all' | 'in' | 'out' | 'expiring';

const MES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export default function CashbackPage() {
  const router = useRouter();
  const [data, setData] = useState<CashbackStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/entrar?next=/cashback');
      return;
    }
    getCashbackStatement()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [router]);

  /** Filtra + agrupa por mês */
  const grouped = useMemo(() => {
    if (!data) return [];
    const list = data.transactions.filter((t) => {
      if (filter === 'all') return true;
      if (filter === 'in') return TYPE_INFO[t.type].group === 'in';
      if (filter === 'out') return TYPE_INFO[t.type].group === 'out';
      if (filter === 'expiring') {
        if (TYPE_INFO[t.type].group !== 'in' || !t.expiresAt) return false;
        const days = Math.ceil((new Date(t.expiresAt).getTime() - Date.now()) / 86400000);
        return days > 0 && days <= 30;
      }
      return true;
    });
    // Agrupa por "MMM YYYY"
    const byMonth: Record<string, CashbackTx[]> = {};
    for (const t of list) {
      const d = new Date(t.date);
      const key = `${MES_PT[d.getMonth()]} ${d.getFullYear()}`;
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push(t);
    }
    return Object.entries(byMonth).map(([month, items]) => ({ month, items }));
  }, [data, filter]);

  /** Total em risco (expira nos próximos 30 dias) */
  const emRisco = useMemo(() => {
    if (!data) return 0;
    return data.transactions
      .filter((t) => {
        if (TYPE_INFO[t.type].group !== 'in' || !t.expiresAt) return false;
        const days = Math.ceil((new Date(t.expiresAt).getTime() - Date.now()) / 86400000);
        return days > 0 && days <= 30;
      })
      .reduce((sum, t) => sum + t.amount, 0);
  }, [data]);

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold flex-1">Conta Lurd's</h1>
      </header>

      {loading && (
        <div className="text-center py-16 text-cream/60">
          <Loader2 className="w-8 h-8 animate-spin mx-auto" />
        </div>
      )}

      {data && (
        <>
          {/* SALDO PRINCIPAL */}
          <section className="mt-6 px-5">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-gold via-gold-light to-gold p-6 text-ink shadow-gold-lg">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest opacity-70">
                  <Wallet className="w-4 h-4" />
                  Saldo disponível
                </div>
                <span className="text-[10px] font-black uppercase bg-ink/10 px-2 py-0.5 rounded-full">
                  Vale em qualquer loja
                </span>
              </div>
              <div className="mt-2 font-serif text-5xl font-black tabular-nums">
                {brl(data.balance)}
              </div>
              <div className="mt-2 text-sm opacity-80">
                Use no PDV de qualquer franquia ou no site
              </div>
            </div>
          </section>

          {/* ALERTA PRÓXIMA EXPIRAÇÃO (≤7 dias) */}
          {data.nextExpiration && data.nextExpiration.daysLeft <= 7 && (
            <section className="mt-3 px-5">
              <button
                onClick={() => setFilter('expiring')}
                className="w-full card-gold-border bg-amber-900/20 border-amber-600/40 flex items-start gap-3 text-left"
              >
                <AlertCircle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
                <div className="text-sm flex-1">
                  <strong className="text-amber-200">
                    {brl(data.nextExpiration.amount)} expira em {data.nextExpiration.daysLeft}{' '}
                    {data.nextExpiration.daysLeft === 1 ? 'dia' : 'dias'}
                  </strong>
                  <p className="text-amber-100/70 mt-0.5">
                    Toque pra ver tudo que tá pra expirar.
                  </p>
                </div>
              </button>
            </section>
          )}

          {/* 3 INDICADORES */}
          <section className="mt-5 px-5 grid grid-cols-3 gap-2">
            <Indicator
              icon={TrendingUp}
              label="Ganhei"
              value={brl(data.earned)}
              colorClass="text-emerald-400"
            />
            <Indicator
              icon={Sparkles}
              label="Usei"
              value={brl(data.spent)}
              colorClass="text-rose-300"
            />
            <Indicator
              icon={Clock}
              label="Em risco"
              value={brl(emRisco)}
              colorClass="text-amber-300"
              clickable={emRisco > 0}
              onClick={() => emRisco > 0 && setFilter('expiring')}
            />
          </section>

          {/* FILTROS DE EXTRATO */}
          <section className="mt-7 px-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-serif text-lg font-bold">Extrato</h2>
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="text-xs text-gold underline"
              >
                Como funciona?
              </button>
            </div>

            {showHelp && (
              <div className="card-dark mb-3 text-xs text-cream/70 space-y-2 animate-fade-in">
                <p>🛍️ <strong className="text-white">Compre</strong> em qualquer loja Lurd's usando seu CPF — o cashback cai aqui na hora.</p>
                <p>💰 <strong className="text-white">{data.rate}% de cashback</strong> sobre o valor que pagou (sem frete).</p>
                <p>⏰ Cada crédito vale por <strong className="text-white">{data.ttlDays} dias</strong> — depois disso some.</p>
                <p>🎁 Pra <strong className="text-white">usar</strong>, escolha "Pagar com cashback" no caixa da loja ou no checkout do site.</p>
              </div>
            )}

            {/* Tabs filtro */}
            <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
              <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
                Tudo
              </FilterChip>
              <FilterChip active={filter === 'in'} onClick={() => setFilter('in')}>
                Entradas
              </FilterChip>
              <FilterChip active={filter === 'out'} onClick={() => setFilter('out')}>
                Saídas
              </FilterChip>
              <FilterChip
                active={filter === 'expiring'}
                onClick={() => setFilter('expiring')}
                badge={emRisco > 0 ? brl(emRisco) : undefined}
                colorVariant="warning"
              >
                Expirando
              </FilterChip>
            </div>

            {/* Lista agrupada por mês */}
            <div className="mt-4 space-y-5">
              {grouped.length === 0 ? (
                <div className="card-dark text-center py-8 text-cream/50 text-sm">
                  {filter === 'expiring'
                    ? 'Nenhum crédito perto de expirar 👏'
                    : 'Sem movimentações nesse filtro.'}
                </div>
              ) : (
                grouped.map(({ month, items }) => (
                  <div key={month}>
                    <div className="text-[10px] font-black uppercase tracking-widest text-cream/40 mb-2 px-1">
                      {month}
                    </div>
                    <div className="space-y-2">
                      {items.map((t) => <TxItem key={t.id} t={t} />)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}

/* ════════════ COMPONENTES ════════════ */

function Indicator({
  icon: Icon, label, value, colorClass, clickable, onClick,
}: {
  icon: any; label: string; value: string; colorClass: string;
  clickable?: boolean; onClick?: () => void;
}) {
  const Cmp: any = clickable ? 'button' : 'div';
  return (
    <Cmp
      onClick={onClick}
      className={`card-dark flex flex-col items-start text-left ${clickable ? 'active:scale-95 transition' : ''}`}
    >
      <Icon className={`w-4 h-4 ${colorClass} mb-1.5`} />
      <div className="text-[10px] uppercase tracking-wider text-cream/60 font-bold">
        {label}
      </div>
      <div className="text-base font-bold mt-0.5 tabular-nums">{value}</div>
    </Cmp>
  );
}

function FilterChip({
  active, onClick, children, badge, colorVariant,
}: {
  active: boolean; onClick: () => void; children: React.ReactNode;
  badge?: string; colorVariant?: 'warning';
}) {
  const baseColor = colorVariant === 'warning'
    ? (active ? 'bg-amber-500 text-ink' : 'bg-amber-900/20 border border-amber-500/40 text-amber-200')
    : (active ? 'bg-gold text-ink' : 'bg-ink-700 text-cream/80 border border-ink-600');
  return (
    <button
      onClick={onClick}
      className={`shrink-0 px-4 py-2 rounded-full text-xs font-black uppercase tracking-wider transition ${baseColor} flex items-center gap-1.5`}
    >
      {children}
      {badge && (
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${active ? 'bg-ink/10' : 'bg-ink-800'}`}>
          {badge}
        </span>
      )}
    </button>
  );
}

function TxItem({ t }: { t: CashbackTx }) {
  const info = TYPE_INFO[t.type];
  const Icon = info.icon;
  const daysLeft = t.expiresAt
    ? Math.ceil((new Date(t.expiresAt).getTime() - Date.now()) / 86400000)
    : null;
  const expiringSoon = daysLeft !== null && daysLeft > 0 && daysLeft <= 30 && info.group === 'in';
  return (
    <div className="card-dark flex items-center gap-3">
      <div className={`w-10 h-10 rounded-xl bg-ink-700 flex items-center justify-center shrink-0 ${info.color}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-white line-clamp-1">
          {t.description || info.label}
        </div>
        <div className="text-[11px] text-cream/50 mt-0.5">
          {new Date(t.date).toLocaleDateString('pt-BR')}
          {t.expiresAt && info.group === 'in' && (
            <>
              {' · '}
              <span className={expiringSoon ? 'text-amber-300 font-bold' : ''}>
                {expiringSoon ? `expira em ${daysLeft}d` : `vale até ${new Date(t.expiresAt).toLocaleDateString('pt-BR')}`}
              </span>
            </>
          )}
        </div>
      </div>
      <div className={`text-sm font-bold tabular-nums shrink-0 ${info.color}`}>
        {info.sign}{(Math.abs(t.amount)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
      </div>
    </div>
  );
}
