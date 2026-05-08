'use client';

/**
 * /retaguarda/super-painel-caixas
 *
 * Painel ao vivo de TODAS as lojas: status do caixa, totais por modalidade,
 * ranking de vendedoras. Auto-refresh a cada 60s.
 */

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, Loader2, AlertCircle, Banknote, QrCode, CreditCard,
  TrendingUp, Lock, Unlock, Trophy,
} from 'lucide-react';
import { api } from '@/lib/api';

type Vendedora = { nome: string; qtd: number; total: number };
type Loja = {
  storeCode: string;
  storeName: string;
  sessionId: string | null;
  aberta: boolean;
  openedAt: string | null;
  openedByName: string | null;
  fundoTroco: number;
  totais: {
    totalVendas: number;
    totalDinheiro: number;
    totalPix: number;
    totalCartaoCredito: number;
    totalCartaoDebito: number;
    totalCrediario: number;
    totalSangrias: number;
    totalSuprimentos: number;
    dinheiroEsperado: number;
    qtdVendas: number;
  };
  vendedoras: Vendedora[];
};
type Painel = {
  lojas: Loja[];
  consolidado: {
    totalVendas: number;
    totalDinheiro: number;
    totalPix: number;
    totalCartaoCredito: number;
    totalCartaoDebito: number;
    totalCrediario: number;
    totalSangrias: number;
    totalSuprimentos: number;
    qtdVendas: number;
    qtdLojasAbertas: number;
    qtdLojasFechadas: number;
  };
  generatedAt: string;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const fmtTime = (iso: string | null) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
};

const POLL_INTERVAL_MS = 60_000;

export default function SuperPainelCaixas() {
  const [data, setData] = useState<Painel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [secsToRefresh, setSecsToRefresh] = useState(POLL_INTERVAL_MS / 1000);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const r = await api<Painel>('/pdv/caixa/super-painel');
      setData(r);
      setSecsToRefresh(POLL_INTERVAL_MS / 1000);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  // Polling automático a cada 60s
  useEffect(() => {
    load();
    intervalRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Countdown do próximo refresh
  useEffect(() => {
    const t = setInterval(() => setSecsToRefresh((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-7xl mx-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-200 text-slate-700">
              <ArrowLeft size={22} />
            </Link>
            <div>
              <h1 className="text-3xl font-black text-slate-900">SUPER PAINEL · CAIXAS</h1>
              <p className="text-xs text-slate-500">
                Ao vivo · todas as lojas · refresh a cada {POLL_INTERVAL_MS / 1000}s
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              próximo em {secsToRefresh}s
            </span>
            <button
              onClick={() => load()}
              disabled={loading}
              className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-sm font-bold flex items-center gap-1 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Atualizar
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-300 text-rose-800 rounded-lg p-3 text-sm flex items-center gap-2">
            <AlertCircle size={18} /> {error}
          </div>
        )}

        {/* Loading inicial */}
        {loading && !data && (
          <div className="text-center p-16">
            <Loader2 size={40} className="mx-auto animate-spin text-rose-600" />
            <div className="text-sm text-slate-500 mt-3">Carregando painel…</div>
          </div>
        )}

        {data && (
          <>
            {/* CARD CONSOLIDADO — destaque máximo */}
            <div className="bg-gradient-to-br from-rose-600 to-rose-800 text-white rounded-2xl shadow-2xl p-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-xs uppercase tracking-wider opacity-80 font-bold">Vendas hoje · TODAS as lojas</div>
                  <div className="text-5xl font-black tabular-nums mt-1">{brl(data.consolidado.totalVendas)}</div>
                </div>
                <div className="flex flex-col gap-1 text-sm">
                  <div className="bg-white/20 px-3 py-1.5 rounded-lg flex items-center gap-2 backdrop-blur">
                    <TrendingUp size={16} />
                    <span className="font-bold">{data.consolidado.qtdVendas}</span> ticket{data.consolidado.qtdVendas !== 1 ? 's' : ''}
                  </div>
                  <div className="bg-white/20 px-3 py-1.5 rounded-lg flex items-center gap-2 backdrop-blur">
                    <Unlock size={14} />
                    <span className="font-bold">{data.consolidado.qtdLojasAbertas}</span> abertas
                    <span className="opacity-60">·</span>
                    <Lock size={14} />
                    <span className="font-bold">{data.consolidado.qtdLojasFechadas}</span> fechadas
                  </div>
                </div>
              </div>
              {/* Breakdown consolidado */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-2 border-t border-white/20">
                <ConsolidadoItem label="Dinheiro" valor={data.consolidado.totalDinheiro} icon={<Banknote size={14} />} />
                <ConsolidadoItem label="PIX" valor={data.consolidado.totalPix} icon={<QrCode size={14} />} />
                <ConsolidadoItem label="Cartão Crédito" valor={data.consolidado.totalCartaoCredito} icon={<CreditCard size={14} />} />
                <ConsolidadoItem label="Cartão Débito" valor={data.consolidado.totalCartaoDebito} icon={<CreditCard size={14} />} />
                <ConsolidadoItem label="Crediário" valor={data.consolidado.totalCrediario} icon={<TrendingUp size={14} />} />
              </div>
            </div>

            {/* Grid de lojas */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {data.lojas.map((l) => (
                <LojaCard key={l.storeCode} loja={l} />
              ))}
            </div>

            {/* Footer */}
            <div className="text-center text-[10px] text-slate-400 pt-2">
              Última atualização: {new Date(data.generatedAt).toLocaleString('pt-BR')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ConsolidadoItem({ label, valor, icon }: { label: string; valor: number; icon: React.ReactNode }) {
  return (
    <div className="bg-white/10 backdrop-blur rounded-lg p-2 space-y-0.5">
      <div className="text-[10px] uppercase opacity-80 font-bold tracking-wide flex items-center gap-1">
        {icon} {label}
      </div>
      <div className="text-base font-black tabular-nums">{brl(valor)}</div>
    </div>
  );
}

function LojaCard({ loja }: { loja: Loja }) {
  const t = loja.totais;
  return (
    <div className={`rounded-xl shadow-lg overflow-hidden border-2 ${
      loja.aberta ? 'bg-white border-emerald-300' : 'bg-slate-100 border-slate-300 opacity-75'
    }`}>
      {/* Header da loja */}
      <div className={`px-3 py-2 flex items-center justify-between ${
        loja.aberta ? 'bg-emerald-600 text-white' : 'bg-slate-400 text-white'
      }`}>
        <div className="flex items-center gap-1.5">
          {loja.aberta ? <Unlock size={14} /> : <Lock size={14} />}
          <span className="font-black text-sm uppercase">{loja.storeName}</span>
          <span className="text-[10px] opacity-80 font-mono">{loja.storeCode}</span>
        </div>
        {loja.aberta ? (
          <span className="text-[10px] opacity-90 font-bold">desde {fmtTime(loja.openedAt)}</span>
        ) : (
          <span className="text-[10px] opacity-90 font-bold uppercase">Fechado</span>
        )}
      </div>

      {/* Total grande */}
      <div className="p-3 space-y-2">
        <div className="flex items-end justify-between">
          <div>
            <div className="text-[10px] uppercase font-bold text-slate-500">Vendas hoje</div>
            <div className={`text-3xl font-black tabular-nums ${loja.aberta ? 'text-emerald-700' : 'text-slate-400'}`}>
              {brl(t.totalVendas)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-slate-500 font-bold">{t.qtdVendas} ticket{t.qtdVendas !== 1 ? 's' : ''}</div>
            {loja.openedByName && (
              <div className="text-[10px] text-slate-400 italic truncate max-w-[120px]">{loja.openedByName}</div>
            )}
          </div>
        </div>

        {/* Breakdown por modalidade */}
        <div className="grid grid-cols-5 gap-1 pt-2 border-t border-slate-200">
          <ModItem label="Dinheiro" valor={t.totalDinheiro} cor="emerald" />
          <ModItem label="PIX" valor={t.totalPix} cor="cyan" />
          <ModItem label="Crédito" valor={t.totalCartaoCredito} cor="blue" />
          <ModItem label="Débito" valor={t.totalCartaoDebito} cor="indigo" />
          <ModItem label="Crediário" valor={t.totalCrediario} cor="rose" />
        </div>

        {/* Sangria/Suprimento (só se houver) */}
        {(t.totalSangrias > 0 || t.totalSuprimentos > 0) && (
          <div className="flex justify-between text-[10px] pt-1 border-t border-slate-100">
            {t.totalSangrias > 0 && (
              <span className="text-rose-600 font-bold">↓ Sangria {brl(t.totalSangrias)}</span>
            )}
            {t.totalSuprimentos > 0 && (
              <span className="text-amber-600 font-bold">↑ Suprim. {brl(t.totalSuprimentos)}</span>
            )}
          </div>
        )}

        {/* Ranking de vendedoras */}
        {loja.vendedoras.length > 0 && (
          <div className="pt-2 border-t border-slate-100">
            <div className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1">
              <Trophy size={10} className="text-amber-500" /> Ranking vendedoras
            </div>
            <div className="space-y-0.5">
              {loja.vendedoras.slice(0, 5).map((v, i) => (
                <div key={i} className="flex items-center justify-between text-[11px]">
                  <span className="font-bold text-slate-700 truncate flex items-center gap-1">
                    {i === 0 && <span className="text-amber-500">🏆</span>}
                    {v.nome.split(' ')[0]}
                  </span>
                  <span className="font-mono tabular-nums text-slate-600">
                    {v.qtd} · <span className="font-bold text-emerald-700">{brl(v.total)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ModItem({ label, valor, cor }: { label: string; valor: number; cor: 'emerald' | 'cyan' | 'blue' | 'indigo' | 'rose' }) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    cyan: 'bg-cyan-50 text-cyan-800 border-cyan-200',
    blue: 'bg-blue-50 text-blue-800 border-blue-200',
    indigo: 'bg-indigo-50 text-indigo-800 border-indigo-200',
    rose: 'bg-rose-50 text-rose-800 border-rose-200',
  };
  const ativo = valor > 0;
  return (
    <div className={`rounded-md border px-1.5 py-1 text-center ${ativo ? tones[cor] : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
      <div className="text-[8px] uppercase font-bold tracking-tight">{label}</div>
      <div className="text-[11px] font-black tabular-nums leading-tight">{brl(valor)}</div>
    </div>
  );
}
