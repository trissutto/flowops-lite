'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, User, Phone, Mail, Hash, Store as StoreIcon,
  TrendingUp, ShoppingBag, Calendar, Loader2, AlertCircle,
} from 'lucide-react';
import { getMe, isLoggedIn, type CustomerMe } from '@/lib/api';

/**
 * /conta/dados — perfil consolidado do CustomerAccount.
 * Mostra dados pessoais + stats agregados de TODAS as lojas linkadas.
 */
export default function DadosPessoaisPage() {
  const router = useRouter();
  const [data, setData] = useState<CustomerMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/login?next=/conta/dados');
      return;
    }
    getMe()
      .then(setData)
      .catch((e) => setError(e?.message || 'Erro ao carregar perfil'))
      .finally(() => setLoading(false));
  }, [router]);

  const fmtBrl = (v: number) =>
    v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const fmtDate = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR');
  };

  return (
    <div className="min-h-dvh pb-12">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/conta" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Dados pessoais</h1>
      </header>

      {loading && (
        <div className="text-center py-16 text-cream/60">
          <Loader2 className="w-8 h-8 animate-spin mx-auto" />
          <div className="text-sm mt-2">Carregando...</div>
        </div>
      )}

      {error && (
        <div className="mx-5 mt-6 flex items-start gap-2 p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-sm text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {data && (
        <>
          {/* Avatar gigante + nome */}
          <section className="mt-6 px-5 text-center">
            <div className="mx-auto w-20 h-20 rounded-full bg-gradient-to-br from-gold to-gold-dark flex items-center justify-center font-serif text-3xl font-bold text-ink">
              {(data.name || 'C').charAt(0).toUpperCase()}
            </div>
            <h2 className="mt-3 font-serif text-xl font-bold">{data.name || 'Cliente'}</h2>
            <p className="text-xs text-cream/60 font-mono">{data.cpf}</p>
          </section>

          {/* Dados de contato */}
          <section className="mt-7 px-5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 mb-2 px-1">
              Contato
            </h3>
            <div className="card-dark divide-y divide-ink-600 !p-0 overflow-hidden">
              <InfoRow icon={<Hash className="w-4 h-4 text-gold/70" />}
                       label="CPF" value={data.cpf} />
              <InfoRow icon={<Phone className="w-4 h-4 text-gold/70" />}
                       label="WhatsApp" value={data.phone || '—'} />
              <InfoRow icon={<Mail className="w-4 h-4 text-gold/70" />}
                       label="E-mail" value={data.email || '— (cadastre)'} />
            </div>
          </section>

          {/* Stats agregados — Opção C em ação */}
          <section className="mt-7 px-5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 mb-2 px-1">
              Sua jornada na Lurd's
            </h3>
            <div className="card-gold-border bg-gold/5">
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  icon={<StoreIcon className="w-5 h-5" />}
                  value={data.stats.linkedStoresCount}
                  label={data.stats.linkedStoresCount === 1 ? 'Loja' : 'Lojas'}
                />
                <StatCard
                  icon={<ShoppingBag className="w-5 h-5" />}
                  value={data.stats.orderCount}
                  label={data.stats.orderCount === 1 ? 'Compra' : 'Compras'}
                />
                <StatCard
                  icon={<TrendingUp className="w-5 h-5" />}
                  value={fmtBrl(data.stats.ltvBrl)}
                  label="Total gasto"
                  small
                />
                <StatCard
                  icon={<Calendar className="w-5 h-5" />}
                  value={fmtDate(data.stats.lastOrderAt)}
                  label="Última compra"
                  small
                />
              </div>
              {data.stats.linkedStoresCount > 1 && (
                <p className="mt-3 text-[11px] text-gold/80 text-center italic">
                  ✨ Seu cadastro está unificado em {data.stats.linkedStoresCount} lojas
                </p>
              )}
            </div>
          </section>

          {/* Cashback resumo */}
          <section className="mt-7 px-5">
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-cream/40 mb-2 px-1">
              Cashback
            </h3>
            <Link href="/cashback" className="card-dark block hover:border-gold/50 transition">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs text-cream/60">Saldo disponível</div>
                  <div className="font-serif text-2xl font-black text-gold mt-0.5">
                    {fmtBrl(data.cashback.balance)}
                  </div>
                </div>
                <div className="text-right text-[11px] text-cream/60">
                  <div>Acumulado: {fmtBrl(data.cashback.earned)}</div>
                  <div>Usado: {fmtBrl(data.cashback.spent)}</div>
                </div>
              </div>
            </Link>
          </section>

          {/* Edição — placeholder Semana 2 */}
          <section className="mt-7 px-5">
            <div className="card-dark text-center text-sm text-cream/50">
              ✏️ Edição de dados em breve.<br />
              <span className="text-[11px]">Por enquanto, peça pra qualquer loja Lurd's atualizar.</span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function InfoRow({ icon, label, value }: {
  icon: React.ReactNode; label: string; value: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      {icon}
      <div className="flex-1">
        <div className="text-[10px] uppercase tracking-wider text-cream/40 font-bold">
          {label}
        </div>
        <div className="text-sm font-medium text-white">{value}</div>
      </div>
    </div>
  );
}

function StatCard({ icon, value, label, small }: {
  icon: React.ReactNode; value: string | number; label: string; small?: boolean;
}) {
  return (
    <div className="bg-ink-800 rounded-xl p-3 text-center">
      <div className="text-gold flex justify-center mb-1">{icon}</div>
      <div className={small ? 'text-base font-bold' : 'text-2xl font-black'}>
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-cream/50 font-bold mt-0.5">
        {label}
      </div>
    </div>
  );
}
