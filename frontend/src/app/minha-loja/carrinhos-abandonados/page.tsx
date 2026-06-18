'use client';

/**
 * /minha-loja/carrinhos-abandonados — Lista clientes que largaram o carrinho no site.
 *
 * Lê do plugin Cart Abandonment Recovery for WooCommerce (CartFlows) via wp-db.
 * Permite filtrar por período + status (abandonado/recuperado) e enviar WhatsApp
 * direto pra cada cliente com 1 clique.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, Search, MessageCircle, Mail, Phone, AlertCircle, Loader2,
  TrendingDown, TrendingUp, ShoppingCart, Percent,
} from 'lucide-react';
import { api } from '@/lib/api';

type Carrinho = {
  id: number;
  email: string;
  nome: string;
  telefone: string;
  cidade: string;
  estado: string;
  total: number;
  status: string;
  unsubscribed: boolean;
  abandonadoEm: string;
  produtos: Array<{ nome: string; qty: number; preco: number }>;
};

type Resumo = {
  abandonados: number;
  valorAbandonado: number;
  recuperados: number;
  valorRecuperado: number;
  taxaRecuperacaoPct: number;
  dias: number;
};

const BRL = (v: number) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtTime = (s: string | null) => {
  if (!s) return '-';
  return new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export default function CarrinhosAbandonadosPage() {
  const [items, setItems] = useState<Carrinho[]>([]);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [loading, setLoading] = useState(true);
  const [dias, setDias] = useState(7);
  const [status, setStatus] = useState<'abandoned' | 'completed' | 'all'>('abandoned');
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [list, res] = await Promise.all([
        api<Carrinho[]>(`/carrinhos-abandonados/list?dias=${dias}&status=${status}`),
        api<Resumo>(`/carrinhos-abandonados/resumo?dias=${dias}`),
      ]);
      setItems(Array.isArray(list) ? list : []);
      setResumo(res);
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dias, status]);

  function whatsapp(c: Carrinho) {
    const tel = (c.telefone || '').replace(/\D/g, '');
    if (!tel || tel.length < 10) {
      alert('Cliente sem telefone válido. Tente o email.');
      return;
    }
    const phone = tel.length >= 11 ? `55${tel}` : `55${tel}`;
    const nome = c.nome?.split(' ')[0] || 'cliente';
    const msg = `Olá, ${nome}! Aqui é da Lurd\'s Plus Size 🛍️\n\nVi que você visitou nosso site e separou peças no valor de ${BRL(c.total)}. Posso te ajudar a finalizar a compra?\n\nSe quiser, posso te enviar um cupom de desconto especial!`;
    const url = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const filtered = items.filter((it) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      it.email?.toLowerCase().includes(q) ||
      it.nome?.toLowerCase().includes(q) ||
      it.telefone?.includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/minha-loja/pdv" className="p-2 hover:bg-slate-100 rounded">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-800">Carrinhos Abandonados</h1>
            <p className="text-xs text-slate-500">Cliente largou no checkout sem pagar — recupere via WhatsApp</p>
          </div>
          <button onClick={load} className="p-2 hover:bg-slate-100 rounded" title="Atualizar">
            <RefreshCw className={`w-5 h-5 text-slate-600 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 space-y-4">
        {/* KPIs */}
        {resumo && (
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="Abandonados" value={String(resumo.abandonados)} sub={BRL(resumo.valorAbandonado)} icon={ShoppingCart} tone="rose" />
            <Kpi label="Recuperados" value={String(resumo.recuperados)} sub={BRL(resumo.valorRecuperado)} icon={TrendingUp} tone="emerald" />
            <Kpi label="Taxa Recuperação" value={`${resumo.taxaRecuperacaoPct}%`} sub={`Últimos ${resumo.dias} dias`} icon={Percent} tone="violet" />
            <Kpi label="Receita perdida" value={BRL(resumo.valorAbandonado)} sub="(se nada recuperar)" icon={TrendingDown} tone="amber" />
          </section>
        )}

        {/* Filtros */}
        <section className="flex flex-wrap items-center gap-2 bg-white p-3 rounded-xl border">
          <select value={dias} onChange={(e) => setDias(Number(e.target.value))} className="px-3 py-2 border-2 rounded-lg text-sm font-bold bg-white">
            <option value={1}>Hoje</option>
            <option value={3}>3 dias</option>
            <option value={7}>7 dias</option>
            <option value={15}>15 dias</option>
            <option value={30}>30 dias</option>
            <option value={90}>90 dias</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="px-3 py-2 border-2 rounded-lg text-sm font-bold bg-white">
            <option value="abandoned">Abandonados</option>
            <option value="completed">Recuperados</option>
            <option value="all">Todos</option>
          </select>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nome, email ou telefone..."
              className="w-full pl-9 pr-3 py-2 border-2 rounded-lg text-sm"
            />
          </div>
          <span className="text-xs text-slate-500 ml-auto">
            {filtered.length} {filtered.length === 1 ? 'carrinho' : 'carrinhos'}
          </span>
        </section>

        {/* Lista */}
        {loading && items.length === 0 ? (
          <div className="text-center py-10 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin inline-block mr-2" /> Carregando do site...
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-slate-500 bg-white rounded-xl border-2 border-dashed">
            <ShoppingCart className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p className="text-sm">Nenhum carrinho com esses filtros.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((c) => (
              <Card key={c.id} c={c} onWhats={() => whatsapp(c)} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Kpi({ label, value, sub, icon: Icon, tone }: { label: string; value: string; sub: string; icon: typeof ShoppingCart; tone: 'rose' | 'emerald' | 'violet' | 'amber' }) {
  const tones: Record<string, string> = {
    rose: 'border-rose-300 bg-rose-50 text-rose-800',
    emerald: 'border-emerald-300 bg-emerald-50 text-emerald-800',
    violet: 'border-violet-300 bg-violet-50 text-violet-800',
    amber: 'border-amber-300 bg-amber-50 text-amber-800',
  };
  return (
    <div className={`border-2 rounded-xl p-3 ${tones[tone]}`}>
      <div className="flex items-center justify-between mb-1">
        <Icon className="w-5 h-5 opacity-80" />
      </div>
      <div className="text-2xl font-black tabular-nums">{value}</div>
      <div className="text-[11px] font-bold uppercase opacity-80">{label}</div>
      <div className="text-[10px] opacity-70 mt-0.5">{sub}</div>
    </div>
  );
}

function Card({ c, onWhats }: { c: Carrinho; onWhats: () => void }) {
  const isCompleted = c.status === 'completed';
  return (
    <div className={`bg-white border-2 rounded-xl p-3 flex items-center gap-3 ${isCompleted ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200'}`}>
      <div className={`p-2 rounded-lg ${isCompleted ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
        <ShoppingCart className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-sm text-slate-800 truncate">
          {c.nome || c.email?.split('@')[0] || 'Cliente'}
          {isCompleted && <span className="ml-2 text-[10px] bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded font-bold uppercase">Recuperado</span>}
          {c.unsubscribed && <span className="ml-2 text-[10px] bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-bold uppercase">Optout</span>}
        </div>
        <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-2 mt-0.5">
          <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{c.email || '—'}</span>
          {c.telefone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{c.telefone}</span>}
          <span>{fmtTime(c.abandonadoEm)}</span>
        </div>
        {c.produtos.length > 0 && (
          <div className="text-[10px] text-slate-400 mt-0.5 truncate">
            {c.produtos.length} {c.produtos.length === 1 ? 'item' : 'itens'}
          </div>
        )}
      </div>
      <div className="text-right">
        <div className="font-black text-rose-700 tabular-nums text-lg">{BRL(c.total)}</div>
      </div>
      {!isCompleted && !c.unsubscribed && c.telefone && (
        <button
          onClick={onWhats}
          className="px-3 py-2 rounded-lg font-bold text-xs flex items-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <MessageCircle className="w-4 h-4" /> WhatsApp
        </button>
      )}
    </div>
  );
}
