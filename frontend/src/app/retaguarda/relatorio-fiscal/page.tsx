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

// Relatório fiscal — só lida com notas que existem no SEFAZ.
// "Pendente" e "Sem NFC-e" não fazem sentido aqui (vendas internas sem nota).
const STATUS_OPTIONS = [
  { value: 'autorizada', label: 'Autorizada', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'cancelada', label: 'Cancelada', color: 'bg-amber-100 text-amber-800' },
  { value: 'rejeitada', label: 'Rejeitada', color: 'bg-rose-100 text-rose-800' },
];

export default function RelatorioFiscalPage() {
  const [from, setFrom] = useState(firstDayOfMonth());
  const [to, setTo] = useState(todayYmd());
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStores, setSelectedStores] = useState<Set<string>>(new Set());
  // Default = só autorizadas. Tela fiscal mostra exclusivamente NFC-e que
  // geraram imposto. Vendas internas sem nota não fazem parte do fiscal.
  const [selectedStatus, setSelectedStatus] = useState<Set<string>>(new Set(['autorizada']));
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

  // Baixa ZIP de XMLs do mesmo range de filtro (autorizados + canceladas).
  // Pro contador anexar à apuração fiscal mensal.
  async function downloadXmls() {
    try {
      const params = new URLSearchParams();
      params.set('from', from);
      params.set('to', to);
      if (selectedStores.size) params.set('storeCodes', Array.from(selectedStores).join(','));
      if (cnpjFilter.trim()) params.set('cnpjs', cnpjFilter.replace(/\D/g, ''));
      const token = localStorage.getItem('flowops_token');
      const API_URL =
        process.env.NEXT_PUBLIC_API_URL || 'https://flowops-lite-production.up.railway.app';
      // Faz fetch com Authorization e converte response em blob pra download
      const res = await fetch(`${API_URL}/api/pdv/relatorio-fiscal/xmls.zip?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const txt = await res.text();
        alert(`Erro ao baixar XMLs: ${res.status} ${txt}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nfces_${from}_a_${to}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Erro: ${e?.message || e}`);
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

          {/* Aviso fixo — esse relatório é exclusivamente fiscal */}
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-900">
            📊 <b>Relatório fiscal:</b> mostra exclusivamente NFC-e que geraram imposto
            (autorizadas, canceladas e rejeitadas pela SEFAZ).
            Vendas internas sem nota não aparecem aqui — consulta elas no <b>Super Painel</b>.
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
                  // Reset volta pra default fiscal (só autorizadas)
                  setSelectedStatus(new Set(['autorizada']));
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
                <>
                  <button
                    onClick={exportCsv}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2 rounded-lg text-sm flex items-center gap-1.5"
                  >
                    <Download className="w-4 h-4" /> Exportar CSV
                  </button>
                  <button
                    onClick={downloadXmls}
                    className="bg-violet-600 hover:bg-violet-700 text-white font-bold px-4 py-2 rounded-lg text-sm flex items-center gap-1.5"
                    title="Baixa ZIP com todos os XMLs autorizados e cancelados do período"
                  >
                    <Download className="w-4 h-4" /> Baixar XMLs (.zip)
                  </button>
                </>
              )}
            </div>
          </div>
          {error && <div className="text-sm text-rose-600">{error}</div>}
        </div>

        {/* KPIs */}
        {data && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <KpiCard label="NFC-e autorizadas" value={data.totals.qtdAutorizada.toString()} color="emerald" />
              <KpiCard label="Faturamento c/ imposto" value={brl(data.totals.totalAutorizado)} color="emerald" />
              <KpiCard
                label="Canceladas + Rejeitadas"
                value={(data.totals.qtdCancelada + data.totals.qtdRejeitada).toString()}
                color="amber"
                alert={data.totals.qtdRejeitada > 0}
              />
              <KpiCard
                label="Inconsistências CNPJ"
                value={data.totals.qtdInconsistente.toString()}
                color="rose"
                alert={data.totals.qtdInconsistente > 0}
              />
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

        {/* NF-e de transferência entre lojas (mod. 55) — pro contador */}
        <NfeTransferSection stores={stores} />
      </div>
    </div>
  );
}

/**
 * NF-e modelo 55 (transferência entre lojas) — emitidas pelo Flow.
 * Filtro por LOJA DE ORIGEM (é o CNPJ emitente) + status. DANFE em PDF e
 * XML (enviado + resposta) direto na linha, pro contador baixar.
 */
function NfeTransferSection({ stores }: { stores: Store[] }) {
  const [lojaFiltro, setLojaFiltro] = useState('');
  const [statusFiltro, setStatusFiltro] = useState('authorized');
  const [rows, setRows] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);

  const API_URL =
    process.env.NEXT_PUBLIC_API_URL || 'https://flowops-lite-production.up.railway.app';
  const authHeaders = (): Record<string, string> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const load = async (loja: string, status: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (loja) params.set('storeCode', loja);
      if (status) params.set('status', status);
      setRows(await api<any[]>(`/nfe?${params}`));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load(lojaFiltro, statusFiltro);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lojaFiltro, statusFiltro]);

  const abrirDanfe = async (d: any) => {
    try {
      const r = await fetch(`${API_URL}/api/nfe/${d.id}/danfe`, { headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || `HTTP ${r.status}`);
      const blobUrl = URL.createObjectURL(await r.blob());
      const w = window.open(blobUrl, '_blank');
      if (!w) {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `danfe-${d.numero}.pdf`;
        a.click();
      }
    } catch (e: any) {
      alert(`Erro ao gerar DANFE: ${e?.message || e}`);
    }
  };

  const baixarXml = async (d: any) => {
    try {
      const r = await fetch(`${API_URL}/api/nfe/${d.id}`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = await r.json();
      const xml = doc?.xmlAutorizado || doc?.xmlEnviado;
      if (!xml) {
        alert('Esta NF-e não tem XML gravado.');
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
      a.download = `nfe-${d.numero}.xml`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      alert(`Erro ao baixar XML: ${e?.message || e}`);
    }
  };

  const storeName = (code: string) => stores.find((s) => s.code === code)?.name || code;

  return (
    <div className="bg-white rounded-xl shadow p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-slate-700 uppercase">
          📄 NF-e de transferência entre lojas (mod. 55)
        </h2>
        <div className="flex items-center gap-2">
          <select
            value={lojaFiltro}
            onChange={(e) => setLojaFiltro(e.target.value)}
            className="p-2 border rounded-lg text-sm"
          >
            <option value="">Todas as lojas (origem)</option>
            {stores.map((s) => (
              <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
            ))}
          </select>
          <select
            value={statusFiltro}
            onChange={(e) => setStatusFiltro(e.target.value)}
            className="p-2 border rounded-lg text-sm"
          >
            <option value="authorized">Autorizadas</option>
            <option value="rejected">Rejeitadas</option>
            <option value="">Todas</option>
          </select>
        </div>
      </div>

      {loading || rows === null ? (
        <div className="text-center py-6 text-slate-400 text-sm">Carregando…</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-6 text-slate-400 text-sm">Nenhuma NF-e com esse filtro.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase text-slate-400 border-b">
                <th className="text-left py-1.5 pr-2">Quando</th>
                <th className="text-left py-1.5 pr-2">Origem → Destino</th>
                <th className="text-left py-1.5 pr-2">Nº / Série</th>
                <th className="text-left py-1.5 pr-2">Amb.</th>
                <th className="text-left py-1.5 pr-2">Status</th>
                <th className="text-right py-1.5 pr-2">Valor</th>
                <th className="text-left py-1.5 pr-2">Chave / Motivo</th>
                <th className="text-left py-1.5">Arquivos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b last:border-0 align-top">
                  <td className="py-1.5 pr-2 whitespace-nowrap text-slate-500">
                    {d.createdAt ? new Date(d.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap">
                    {d.fromStoreCode} {storeName(d.fromStoreCode)} → {d.toStoreCode} {storeName(d.toStoreCode)}
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap font-mono font-bold">{d.numero}/{d.serie}</td>
                  <td className="py-1.5 pr-2">
                    <span className={`font-bold ${d.tpAmb === '1' ? 'text-rose-700' : 'text-emerald-700'}`}>
                      {d.tpAmb === '1' ? 'PROD' : 'HOMOL'}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold border ${
                      d.status === 'authorized'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                        : d.status === 'rejected'
                        ? 'bg-rose-50 border-rose-300 text-rose-700'
                        : 'bg-amber-50 border-amber-300 text-amber-700'
                    }`}>
                      {d.status === 'authorized' ? 'AUTORIZADA' : d.status === 'rejected' ? 'REJEITADA' : (d.status || '?').toUpperCase()}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">
                    {brl(Number(d.valorTotalCents || 0) / 100)}
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-[10px] break-all max-w-[240px]">
                    {d.status === 'authorized' ? d.chave : (d.xMotivo || d.chave || '—')}
                  </td>
                  <td className="py-1.5 whitespace-nowrap">
                    <button
                      onClick={() => abrirDanfe(d)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-300 hover:bg-emerald-50 text-emerald-700 font-bold mr-1"
                      title="Abrir DANFE em PDF"
                    >
                      📄 DANFE
                    </button>
                    <button
                      onClick={() => baixarXml(d)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-slate-300 hover:bg-slate-100 text-slate-600"
                      title="Baixar o XML da NF-e"
                    >
                      ⬇ XML
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
