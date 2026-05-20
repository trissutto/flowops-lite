'use client';

/**
 * /retaguarda/relatorio-fiscal
 *
 * Relatório fiscal de NFC-e emitidas. Filtros + KPIs + tabela detalhada.
 * Detecta inconsistência (NFC-e emitida por CNPJ diferente do esperado pra loja).
 *
 * Acesso: admin e supervisor.
 */

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, AlertTriangle, FileText, X } from 'lucide-react';
import { api } from '@/lib/api';

type Store = { code: string; name: string; expectedCnpj?: string | null; expectedRazaoSocial?: string | null };
type Row = {
  id: string;
  storeCode: string;
  storeName: string;
  total: number;
  desconto: number;
  paymentMethod: string | null;
  sellerName: string | null;
  vendedorName: string | null;
  customerName: string | null;
  customerCpf: string | null;
  nfceStatus: string | null;
  nfceNumber: string | null;
  nfceSerie: string | null;
  nfceChave: string | null;
  nfceProtocolo: string | null;
  nfceMotivo: string | null;
  nfceAutorizadaEm: string | null;
  nfceCanceladaEm: string | null;
  finalizedAt: string | null;
  expectedCnpj: string | null;
  expectedRazaoSocial: string | null;
  emittedCnpj: string | null;
  emittedRazaoSocial: string | null;
  inconsistent: boolean;
};
type Response = {
  filtros: any;
  range: { from: string; to: string };
  totals: {
    totalGeral: number;
    qtdGeral: number;
    qtdAutorizada: number;
    totalAutorizado: number;
    qtdInconsistente: number;
    qtdSemNfce: number;
    qtdCancelada: number;
    qtdRejeitada: number;
  };
  byStatus: Record<string, { qtd: number; total: number }>;
  byStore: Record<string, { qtd: number; total: number; storeName: string }>;
  byCnpj: Record<string, { qtd: number; total: number; razaoSocial: string | null }>;
  bySerie: Record<string, { qtd: number; total: number }>;
  ultimoNumeroPorSerie: Record<string, number>;
  rows: Row[];
  generatedAt: string;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function toYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function firstDayOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  return toYmd(d);
}
function todayYmd(): string {
  return toYmd(new Date());
}

const STATUS_OPTIONS = [
  { value: 'autorizada', label: 'Autorizada', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'cancelada', label: 'Cancelada', color: 'bg-amber-100 text-amber-800' },
  { value: 'rejeitada', label: 'Rejeitada', color: 'bg-rose-100 text-rose-800' },
  { value: 'pendente', label: 'Pendente', color: 'bg-slate-100 text-slate-800' },
  { value: 'sem_nfce', label: 'Sem NFC-e', color: 'bg-slate-200 text-slate-900' },
];

export default function RelatorioFiscalPage() {
  const [from, setFrom] = useState(firstDayOfMonth());
  const [to, setTo] = useState(todayYmd());
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStores, setSelectedStores] = useState<Set<string>>(new Set());
  const [selectedStatus, setSelectedStatus] = useState<Set<string>>(new Set());
  const [cnpjFilter, setCnpjFilter] = useState('');
  const [serieFilter, setSerieFilter] = useState('');
  const [customerCpf, setCustomerCpf] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [chave, setChave] = useState('');
  const [minValor, setMinValor] = useState('');
  const [maxValor, setMaxValor] = useState('');
  const [onlyInconsistent, setOnlyInconsistent] = useState(false);

  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Store[]>('/stores')
      .then((r) => setStores(r || []))
      .catch(() => setStores([]));
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('from', from);
      params.set('to', to);
      if (selectedStores.size) params.set('storeCodes', Array.from(selectedStores).join(','));
      if (selectedStatus.size) params.set('nfceStatus', Array.from(selectedStatus).join(','));
      if (cnpjFilter.trim()) params.set('cnpjs', cnpjFilter.replace(/\D/g, ''));
      if (serieFilter.trim()) params.set('series', serieFilter.trim());
      if (customerCpf.trim()) params.set('customerCpf', customerCpf.replace(/\D/g, ''));
      if (customerName.trim()) params.set('customerName', customerName.trim());
      if (chave.trim()) params.set('chave', chave.replace(/\D/g, ''));
      if (minValor) params.set('minValor', minValor);
      if (maxValor) params.set('maxValor', maxValor);
      if (onlyInconsistent) params.set('onlyInconsistent', '1');
      const r = await api<Response>(`/pdv/relatorio-fiscal?${params}`);
      setData(r);
    } catch (e: any) {
      setError(e?.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    if (!data?.rows?.length) return;
    const header = [
      'Data', 'Loja', 'Total', 'Forma Pagto', 'Vendedora', 'Cliente', 'CPF',
      'Status NFC-e', 'Série', 'Número', 'Chave', 'Protocolo',
      'CNPJ Emitido', 'CNPJ Esperado', 'Inconsistente',
    ];
    const rows = data.rows.map((r) => [
      r.finalizedAt ? new Date(r.finalizedAt).toLocaleString('pt-BR') : '',
      `${r.storeCode} ${r.storeName}`,
      r.total.toFixed(2).replace('.', ','),
      r.paymentMethod || '',
      r.sellerName || r.vendedorName || '',
      r.customerName || '',
      r.customerCpf || '',
      r.nfceStatus || 'sem_nfce',
      r.nfceSerie || '',
      r.nfceNumber || '',
      r.nfceChave || '',
      r.nfceProtocolo || '',
      r.emittedCnpj || '',
      r.expectedCnpj || '',
      r.inconsistent ? 'SIM' : '',
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-fiscal-${from}-a-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const fmtCnpj = (c: string | null) =>
    c ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : '—';

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="flex items-center gap-3">
          <Link href="/retaguarda" className="text-slate-600 hover:text-slate-900">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-indigo-600" />
            Relatório Fiscal — NFC-e
          </h1>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Filtros */}
        <div className="bg-white rounded-xl shadow p-5 space-y-4">
          <h2 className="text-sm font-bold text-slate-700 uppercase">Filtros</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">De</label>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Até</label>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Lojas {selectedStores.size > 0 && `(${selectedStores.size})`}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {stores.map((s) => {
                  const on = selectedStores.has(s.code);
                  return (
                    <button
                      key={s.code}
                      type="button"
                      onClick={() => {
                        const next = new Set(selectedStores);
                        if (on) next.delete(s.code); else next.add(s.code);
                        setSelectedStores(next);
                      }}
                      className={`text-[11px] px-2 py-1 rounded-full border transition ${
                        on
                          ? 'bg-indigo-600 text-white border-indigo-700'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {s.code} {s.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">CNPJ emitente</label>
              <input type="text" value={cnpjFilter} onChange={(e) => setCnpjFilter(e.target.value)}
                placeholder="Apenas dígitos"
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Série</label>
              <input type="text" value={serieFilter} onChange={(e) => setSerieFilter(e.target.value)}
                placeholder="ex: 3 ou 3,4"
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">CPF cliente</label>
              <input type="text" value={customerCpf} onChange={(e) => setCustomerCpf(e.target.value)}
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Nome cliente</label>
              <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)}
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Chave de acesso</label>
              <input type="text" value={chave} onChange={(e) => setChave(e.target.value)}
                placeholder="44 dígitos"
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Valor mín. (R$)</label>
              <input type="number" value={minValor} onChange={(e) => setMinValor(e.target.value)}
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Valor máx. (R$)</label>
              <input type="number" value={maxValor} onChange={(e) => setMaxValor(e.target.value)}
                className="w-full p-2 border rounded-lg text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Status NFC-e {selectedStatus.size > 0 && `(${selectedStatus.size})`}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {STATUS_OPTIONS.map((s) => {
                  const on = selectedStatus.has(s.value);
                  return (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => {
                        const next = new Set(selectedStatus);
                        if (on) next.delete(s.value); else next.add(s.value);
                        setSelectedStatus(next);
                      }}
                      className={`text-[11px] px-2 py-1 rounded-full border transition ${
                        on ? `${s.color} border-current font-bold` : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Atalho rápido: filtro "Só notas efetivas" (autorizadas).
              Limpa qualquer outro status selecionado e marca só "autorizada".
              Mais visível que clicar no chip pequeno dentro de Status NFC-e. */}
          <div className="bg-emerald-50 border-2 border-emerald-200 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-emerald-900">
                📊 Mostrar só notas efetivas (com imposto gerado)
              </div>
              <div className="text-[11px] text-emerald-700">
                Filtra só NFC-e <b>autorizadas</b> pela SEFAZ — o que efetivamente virou imposto pro contador.
                Esconde pendentes, canceladas, rejeitadas e vendas sem NFC-e.
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                const onlyAutorizada =
                  selectedStatus.size === 1 && selectedStatus.has('autorizada');
                if (onlyAutorizada) {
                  setSelectedStatus(new Set()); // desativa
                } else {
                  setSelectedStatus(new Set(['autorizada']));
                }
              }}
              className={`px-4 py-2 rounded-lg font-bold text-sm transition ${
                selectedStatus.size === 1 && selectedStatus.has('autorizada')
                  ? 'bg-emerald-600 text-white shadow-md'
                  : 'bg-white text-emerald-700 border-2 border-emerald-300 hover:bg-emerald-50'
              }`}
            >
              {selectedStatus.size === 1 && selectedStatus.has('autorizada')
                ? '✓ ATIVO — só autorizadas'
                : 'Ativar filtro de notas efetivas'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={onlyInconsistent} onChange={(e) => setOnlyInconsistent(e.target.checked)} />
              <span className="font-semibold text-rose-700">⚠️ Mostrar só inconsistências (CNPJ errado)</span>
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setSelectedStores(new Set());
                  setSelectedStatus(new Set());
                  setCnpjFilter(''); setSerieFilter('');
                  setCustomerCpf(''); setCustomerName(''); setChave('');
                  setMinValor(''); setMaxValor('');
                  setOnlyInconsistent(false);
                }}
                className="text-xs text-slate-500 hover:text-slate-800 underline"
              >
                Limpar filtros
              </button>
              <button
                onClick={load}
                disabled={loading}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-4 py-2 rounded-lg text-sm disabled:opacity-50"
              >
                {loading ? 'Carregando...' : 'Aplicar filtros'}
              </button>
              {data && (
                <button
                  onClick={exportCsv}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2 rounded-lg text-sm flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4" /> Exportar CSV
                </button>
              )}
            </div>
          </div>
          {error && <div className="text-sm text-rose-600">{error}</div>}
        </div>

        {/* KPIs */}
        {data && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
              <KpiCard label="Vendas no período" value={data.totals.qtdGeral.toString()} color="indigo" />
              <KpiCard label="Total faturado (todas vendas)" value={brl(data.totals.totalGeral)} color="slate" />
              <KpiCard label="✓ NFC-e autorizadas" value={data.totals.qtdAutorizada.toString()} color="emerald" />
              <KpiCard label="✓ Faturamento c/ imposto" value={brl(data.totals.totalAutorizado)} color="emerald" />
              <KpiCard label="Sem NFC-e / Pendente" value={data.totals.qtdSemNfce.toString()} color="amber" alert={data.totals.qtdSemNfce > 0} />
              <KpiCard label="Inconsistências CNPJ" value={data.totals.qtdInconsistente.toString()} color="rose" alert={data.totals.qtdInconsistente > 0} />
            </div>

            {/* Resumos */}
            <div className="grid lg:grid-cols-3 gap-4">
              <ResumoCard title="Por CNPJ emitente" data={Object.entries(data.byCnpj).map(([k, v]) => ({
                label: v.razaoSocial || fmtCnpj(k === 'SEM_CNPJ' ? null : k),
                sub: k === 'SEM_CNPJ' ? '' : fmtCnpj(k),
                qtd: v.qtd, total: v.total,
              }))} />
              <ResumoCard title="Por loja" data={Object.entries(data.byStore).map(([k, v]) => ({
                label: `${k} ${v.storeName}`,
                qtd: v.qtd, total: v.total,
              }))} />
              <ResumoCard title="Por série (último nº)" data={Object.entries(data.bySerie).map(([k, v]) => ({
                label: `Série ${k}`,
                sub: data.ultimoNumeroPorSerie[k] ? `Último nº: ${data.ultimoNumeroPorSerie[k]}` : '',
                qtd: v.qtd, total: v.total,
              }))} />
            </div>

            {/* Tabela */}
            <div className="bg-white rounded-xl shadow overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <h3 className="font-bold text-sm">
                  Detalhes ({data.rows.length} {data.rows.length === 1 ? 'venda' : 'vendas'})
                </h3>
                {data.totals.qtdInconsistente > 0 && (
                  <div className="text-xs text-rose-700 font-semibold flex items-center gap-1">
                    <AlertTriangle className="w-4 h-4" />
                    {data.totals.qtdInconsistente} nota(s) com CNPJ divergente
                  </div>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr className="text-left text-slate-700">
                      <th className="px-2 py-2 font-semibold">Data</th>
                      <th className="px-2 py-2 font-semibold">Loja</th>
                      <th className="px-2 py-2 font-semibold text-right">Total</th>
                      <th className="px-2 py-2 font-semibold">Pagto</th>
                      <th className="px-2 py-2 font-semibold">Vendedora</th>
                      <th className="px-2 py-2 font-semibold">Cliente</th>
                      <th className="px-2 py-2 font-semibold">Status</th>
                      <th className="px-2 py-2 font-semibold">Série/Nº</th>
                      <th className="px-2 py-2 font-semibold">CNPJ emitido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} className={`border-t border-slate-100 ${
                        r.inconsistent ? 'bg-rose-50' : 'hover:bg-slate-50'
                      }`}>
                        <td className="px-2 py-1.5 whitespace-nowrap text-slate-700">
                          {r.finalizedAt ? new Date(r.finalizedAt).toLocaleString('pt-BR', {
                            day: '2-digit', month: '2-digit', year: '2-digit',
                            hour: '2-digit', minute: '2-digit',
                          }) : '—'}
                        </td>
                        <td className="px-2 py-1.5 font-mono">{r.storeCode}</td>
                        <td className="px-2 py-1.5 text-right font-mono font-bold tabular-nums">{brl(r.total)}</td>
                        <td className="px-2 py-1.5 text-slate-600">{r.paymentMethod || '—'}</td>
                        <td className="px-2 py-1.5 text-slate-700 truncate max-w-[120px]">
                          {r.sellerName || r.vendedorName || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-slate-700 truncate max-w-[140px]">{r.customerName || '—'}</td>
                        <td className="px-2 py-1.5">
                          <StatusBadge status={r.nfceStatus} />
                        </td>
                        <td className="px-2 py-1.5 font-mono text-slate-700">
                          {r.nfceSerie ? `${r.nfceSerie}/${r.nfceNumber || '?'}` : '—'}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[10px] text-slate-600">
                          {r.inconsistent ? (
                            <span className="text-rose-700 font-bold" title={`Esperado: ${fmtCnpj(r.expectedCnpj)} (${r.expectedRazaoSocial || ''})`}>
                              ⚠️ {fmtCnpj(r.emittedCnpj)}
                            </span>
                          ) : (
                            fmtCnpj(r.emittedCnpj)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.rows.length === 0 && (
                <div className="p-8 text-center text-slate-500 text-sm">
                  Nenhuma venda encontrada com esses filtros.
                </div>
              )}
            </div>
          </>
        )}

        {!data && !loading && (
          <div className="bg-white rounded-xl shadow p-8 text-center text-slate-500">
            Defina os filtros acima e clique em <b>Aplicar filtros</b> pra carregar o relatório.
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({ label, value, color, alert }: { label: string; value: string; color: string; alert?: boolean }) {
  const colors: Record<string, string> = {
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    rose: 'bg-rose-50 border-rose-200 text-rose-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    slate: 'bg-slate-50 border-slate-200 text-slate-900',
  };
  return (
    <div className={`rounded-xl border-2 p-4 ${colors[color] || colors.slate} ${alert ? 'ring-2 ring-offset-2 ring-current animate-pulse' : ''}`}>
      <div className="text-xs font-semibold opacity-75">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function ResumoCard({ title, data }: { title: string; data: Array<{ label: string; sub?: string; qtd: number; total: number }> }) {
  return (
    <div className="bg-white rounded-xl shadow p-4">
      <h3 className="font-bold text-sm text-slate-700 mb-3">{title}</h3>
      <div className="space-y-1.5">
        {data.length === 0 && <div className="text-xs text-slate-500">Sem dados</div>}
        {data.sort((a, b) => b.total - a.total).map((d, i) => (
          <div key={i} className="flex justify-between items-start text-xs gap-2">
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-slate-800 truncate">{d.label}</div>
              {d.sub && <div className="text-[10px] text-slate-500">{d.sub}</div>}
            </div>
            <div className="text-right shrink-0">
              <div className="font-mono font-bold tabular-nums">{brl(d.total)}</div>
              <div className="text-[10px] text-slate-500">{d.qtd}x</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const s = status || 'sem_nfce';
  const opt = STATUS_OPTIONS.find((o) => o.value === s);
  if (!opt) return <span className="text-slate-500">—</span>;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${opt.color}`}>
      {opt.label}
    </span>
  );
}
