'use client';

/**
 * /retaguarda/auditoria
 *
 * Dashboard de paridade Wincred vs Flowops por loja.
 * Suporta sprint de migração até 30/06 — destaca divergências críticas
 * nas 5 lojas migradas (INDAIATUBA, ITANHAÉM, MOEMA, SOROCABA, SANTOS).
 *
 * Atualiza a cada 30s. Linhas críticas (>=5% divergência) ficam vermelhas.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, AlertTriangle, CheckCircle2, Eye } from 'lucide-react';
import { api } from '@/lib/api';

type StatusVal = 'ok' | 'alerta' | 'critico' | 'sem_dado';
type LojaRow = {
  storeCode: string;
  storeName: string;
  migrada: boolean;
  wincred: { qtd: number; valor: number };
  flowops: { qtd: number; valor: number };
  divergencia: { valor: number; pct: number };
  status: StatusVal;
};
type AuditoriaData = {
  from: string;
  to: string;
  sumario: {
    total: number;
    criticos: number;
    alertas: number;
    ok: number;
    semDado: number;
    lojasMigradas: string[];
    totalWincredBrl: number;
    totalFlowopsBrl: number;
  };
  lojas: LojaRow[];
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function AuditoriaPage() {
  const router = useRouter();
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState<AuditoriaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login');
  }, [router]);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api<AuditoriaData>(`/faturamento/auditoria-paridade?from=${from}&to=${to}`);
      setData(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha ao carregar auditoria');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const statusBadge = (s: StatusVal) => {
    if (s === 'critico') return { color: 'bg-rose-100 text-rose-800 border-rose-300', label: '🔴 CRÍTICO' };
    if (s === 'alerta') return { color: 'bg-amber-100 text-amber-800 border-amber-300', label: '🟡 ALERTA' };
    if (s === 'ok') return { color: 'bg-emerald-100 text-emerald-800 border-emerald-300', label: '🟢 OK' };
    return { color: 'bg-slate-100 text-slate-600 border-slate-300', label: '⚪ Sem dado' };
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="font-bold text-lg">📊 Auditoria de Paridade — Wincred vs Flowops</h1>
            <p className="text-xs text-slate-500">
              Sprint migração até 30/06 — atualiza a cada 30s
            </p>
          </div>
          <button onClick={load} className="px-3 py-2 bg-slate-900 text-white rounded text-sm font-bold hover:bg-slate-800 flex items-center gap-2">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* Filtros */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex gap-3 items-end flex-wrap">
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-1">De</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-2 border border-slate-300 rounded text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-wider text-slate-600 block mb-1">Até</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-3 py-2 border border-slate-300 rounded text-sm"
            />
          </div>
          <button
            onClick={() => { setFrom(todayIso()); setTo(todayIso()); }}
            className="px-3 py-2 text-xs text-slate-500 hover:text-slate-800"
          >
            Hoje
          </button>
        </div>

        {err && (
          <div className="bg-rose-50 border border-rose-300 text-rose-800 p-3 rounded text-sm">
            {err}
          </div>
        )}

        {data && (
          <>
            {/* Sumário cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <SumarioCard
                label="Críticos"
                value={data.sumario.criticos}
                color="bg-rose-50 border-rose-300 text-rose-900"
                icon={<AlertTriangle className="w-5 h-5" />}
              />
              <SumarioCard
                label="Alertas"
                value={data.sumario.alertas}
                color="bg-amber-50 border-amber-300 text-amber-900"
                icon={<AlertTriangle className="w-5 h-5" />}
              />
              <SumarioCard
                label="OK"
                value={data.sumario.ok}
                color="bg-emerald-50 border-emerald-300 text-emerald-900"
                icon={<CheckCircle2 className="w-5 h-5" />}
              />
              <SumarioCard
                label="Sem dado (legado)"
                value={data.sumario.semDado}
                color="bg-slate-50 border-slate-300 text-slate-700"
                icon={<Eye className="w-5 h-5" />}
              />
            </div>

            {/* Totais rede */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2">
                Total da rede no período
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <div className="text-xs text-slate-500">Wincred (Giga)</div>
                  <div className="text-xl font-bold tabular-nums">{brl(data.sumario.totalWincredBrl)}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Flowops (PostgreSQL)</div>
                  <div className="text-xl font-bold tabular-nums text-blue-700">{brl(data.sumario.totalFlowopsBrl)}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">Diferença</div>
                  <div className={`text-xl font-bold tabular-nums ${
                    Math.abs(data.sumario.totalFlowopsBrl - data.sumario.totalWincredBrl) > 100
                      ? 'text-rose-700' : 'text-slate-700'
                  }`}>
                    {brl(data.sumario.totalFlowopsBrl - data.sumario.totalWincredBrl)}
                  </div>
                </div>
              </div>
            </div>

            {/* Tabela por loja */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div className="font-bold">Por loja</div>
                <div className="text-xs text-slate-500">
                  Migradas: {data.sumario.lojasMigradas.join(', ')}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">Loja</th>
                      <th className="px-3 py-2 text-center">Status</th>
                      <th className="px-3 py-2 text-right">Wincred Qtd</th>
                      <th className="px-3 py-2 text-right">Wincred R$</th>
                      <th className="px-3 py-2 text-right">Flowops Qtd</th>
                      <th className="px-3 py-2 text-right">Flowops R$</th>
                      <th className="px-3 py-2 text-right">Diferença</th>
                      <th className="px-3 py-2 text-right">%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.lojas.map((l) => {
                      const badge = statusBadge(l.status);
                      return (
                        <tr key={l.storeCode} className={l.status === 'critico' ? 'bg-rose-50/30' : 'hover:bg-slate-50'}>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono text-slate-400">{l.storeCode}</span>
                              <span className="font-bold">{l.storeName}</span>
                              {l.migrada && (
                                <span className="px-1.5 py-0.5 bg-blue-100 text-blue-800 text-[9px] font-bold rounded">
                                  MIGRADA
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold border ${badge.color}`}>
                              {badge.label}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{l.wincred.qtd}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{brl(l.wincred.valor)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-blue-700 font-bold">{l.flowops.qtd}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-blue-700 font-bold">{brl(l.flowops.valor)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums font-bold ${
                            Math.abs(l.divergencia.valor) > 100 ? 'text-rose-700' : 'text-slate-600'
                          }`}>
                            {brl(l.divergencia.valor)}
                          </td>
                          <td className={`px-3 py-2 text-right tabular-nums font-bold ${
                            Math.abs(l.divergencia.pct) >= 5 ? 'text-rose-700'
                              : Math.abs(l.divergencia.pct) >= 1 ? 'text-amber-700'
                              : 'text-slate-500'
                          }`}>
                            {l.divergencia.pct >= 0 ? '+' : ''}{l.divergencia.pct.toFixed(2)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Explicação */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
              <strong>Como ler:</strong> Status 🔴 = divergência ≥5% entre Wincred e Flowops (CRÍTICO).
              🟡 = entre 1-5% (revisar). 🟢 = abaixo de 1% (OK). ⚪ = loja sem PdvSale (esperado pra lojas ainda no Wincred legado).
              <br/>
              <strong>Lojas migradas</strong> ({data.sumario.lojasMigradas.join(', ')}) <strong>devem estar 🟢 OK</strong> até 30/06.
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function SumarioCard({
  label, value, color, icon,
}: {
  label: string; value: number; color: string; icon: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border-2 p-4 ${color}`}>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-bold uppercase tracking-wider">{label}</div>
        {icon}
      </div>
      <div className="text-3xl font-black tabular-nums">{value}</div>
    </div>
  );
}
