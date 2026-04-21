'use client';

/**
 * /crm/segmentos — Segmentação RFM da base de clientes.
 * Mostra 5 segmentos (+ Regulares fallback) com contadores e ação sugerida.
 * Clicar num card abre a lista de clientes + export CSV.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import {
  Crown, AlertTriangle, Sparkles, Moon, Target, Users,
  RefreshCw, Download, ArrowLeft, Search, Phone, MessageCircle,
} from 'lucide-react';

type SegmentKey = 'vip' | 'em_risco' | 'novos' | 'inativos' | 'one_shot' | 'regulares';

interface Segment {
  key: SegmentKey;
  label: string;
  description: string;
  action: string;
  count: number;
  totalValue: number;
}

interface SummaryResponse {
  segments: Segment[];
  thresholds: {
    p80TotalSpent: number;
    vipMinSpent: number;
    riskMinSpent: number;
    totalCustomers: number;
  };
  generatedAt: string;
}

interface Customer {
  email: string;
  name: string | null;
  phone: string | null;
  orderCount: number;
  totalSpent: number;
  avgTicket: number;
  firstOrder: string;
  lastOrder: string;
  daysSinceFirst: number;
  daysSinceLast: number;
  segment: SegmentKey;
}

interface ListResponse {
  data: Customer[];
  total: number;
  page: number;
  limit: number;
  segment: SegmentKey;
}

const SEGMENT_VISUAL: Record<SegmentKey, {
  icon: typeof Crown;
  color: string;
  bg: string;
  border: string;
  text: string;
}> = {
  vip:        { icon: Crown,         color: 'text-amber-600',   bg: 'bg-amber-50',   border: 'border-amber-300',   text: 'text-amber-900' },
  em_risco:   { icon: AlertTriangle, color: 'text-rose-600',    bg: 'bg-rose-50',    border: 'border-rose-300',    text: 'text-rose-900' },
  novos:      { icon: Sparkles,      color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-900' },
  inativos:   { icon: Moon,          color: 'text-slate-600',   bg: 'bg-slate-50',   border: 'border-slate-300',   text: 'text-slate-900' },
  one_shot:   { icon: Target,        color: 'text-blue-600',    bg: 'bg-blue-50',    border: 'border-blue-300',    text: 'text-blue-900' },
  regulares:  { icon: Users,         color: 'text-violet-600',  bg: 'bg-violet-50',  border: 'border-violet-300',  text: 'text-violet-900' },
};

function fmtMoney(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtDays(d: number) {
  if (d === 0) return 'hoje';
  if (d === 1) return 'ontem';
  if (d < 30) return `${d}d atrás`;
  if (d < 365) return `${Math.floor(d / 30)}m atrás`;
  return `${Math.floor(d / 365)}a atrás`;
}

export default function SegmentosPage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SegmentKey | null>(null);

  useEffect(() => { loadSummary(); }, []);

  // IMPORTANTE: todos os hooks precisam rodar ANTES de qualquer early-return,
  // senão o React quebra (rules of hooks).
  const totalValueAllSegments = useMemo(
    () => summary?.segments.reduce((s, x) => s + x.totalValue, 0) ?? 0,
    [summary],
  );

  async function loadSummary() {
    setLoading(true);
    try {
      const res = await api<SummaryResponse>('/crm/segments');
      setSummary(res);
    } catch (e: any) {
      alert(`Falha ao carregar segmentos: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (selected) {
    return (
      <SegmentDetail
        segment={selected}
        summary={summary}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold">CRM — Segmentação RFM</h1>
          <p className="text-sm text-slate-500 mt-1">
            Clientes classificados automaticamente por Recência, Frequência e Valor.
            Clique num segmento pra ver a lista e exportar.
          </p>
          {summary && (
            <p className="text-xs text-slate-400 mt-1">
              Base: <strong>{summary.thresholds.totalCustomers.toLocaleString('pt-BR')}</strong> clientes ·
              VIP ≥ <strong>{fmtMoney(summary.thresholds.vipMinSpent)}</strong> ·
              Em risco ≥ <strong>{fmtMoney(summary.thresholds.riskMinSpent)}</strong>
            </p>
          )}
        </div>
        <button
          onClick={loadSummary}
          className="p-2 rounded hover:bg-slate-100"
          title="Recalcular"
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading && !summary && (
        <div className="text-center text-slate-400 py-12">Calculando segmentos…</div>
      )}

      {summary && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            {summary.segments.map((seg) => {
              const v = SEGMENT_VISUAL[seg.key];
              const Icon = v.icon;
              const pct = summary.thresholds.totalCustomers > 0
                ? (seg.count / summary.thresholds.totalCustomers) * 100
                : 0;
              return (
                <button
                  key={seg.key}
                  onClick={() => setSelected(seg.key)}
                  disabled={seg.count === 0}
                  className={`text-left rounded-lg border-2 p-5 transition shadow-sm hover:shadow-md disabled:opacity-50 disabled:cursor-not-allowed ${v.bg} ${v.border}`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className={`p-2 rounded-lg bg-white/70`}>
                      <Icon className={`w-6 h-6 ${v.color}`} />
                    </div>
                    <div className="text-right">
                      <div className={`text-3xl font-bold ${v.text}`}>
                        {seg.count.toLocaleString('pt-BR')}
                      </div>
                      <div className="text-xs text-slate-500">
                        {pct.toFixed(1)}% da base
                      </div>
                    </div>
                  </div>
                  <h3 className={`text-lg font-bold mb-1 ${v.text}`}>{seg.label}</h3>
                  <p className="text-xs text-slate-600 mb-2 leading-snug">{seg.description}</p>
                  <div className={`text-sm font-mono font-bold ${v.color} mb-2`}>
                    {fmtMoney(seg.totalValue)}
                  </div>
                  <div className="text-xs bg-white/60 rounded p-2 text-slate-700 border border-white/80">
                    <strong>Ação:</strong> {seg.action}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="bg-slate-50 rounded-lg p-4 border text-sm text-slate-600">
            <strong>Receita total agregada nesses segmentos:</strong>{' '}
            <span className="font-mono font-bold text-slate-900">
              {fmtMoney(totalValueAllSegments)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Detail: lista de clientes de 1 segmento
// ============================================================================

function SegmentDetail({
  segment,
  summary,
  onBack,
}: {
  segment: SegmentKey;
  summary: SummaryResponse | null;
  onBack: () => void;
}) {
  const [list, setList] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [orderBy, setOrderBy] = useState<'totalSpent' | 'orderCount' | 'lastOrder' | 'name'>('totalSpent');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [exporting, setExporting] = useState(false);

  const v = SEGMENT_VISUAL[segment];
  const Icon = v.icon;
  const segInfo = summary?.segments.find((s) => s.key === segment);

  useEffect(() => { load(); /* eslint-disable-line */ }, [segment, search, orderBy, order, page]);

  async function load() {
    setLoading(true);
    try {
      const q = new URLSearchParams();
      q.set('page', String(page));
      q.set('limit', String(limit));
      q.set('orderBy', orderBy);
      q.set('order', order);
      if (search) q.set('search', search);
      const res = await api<ListResponse>(`/crm/segments/${segment}?${q}`);
      setList(res.data);
      setTotal(res.total);
    } catch (e: any) {
      alert(`Falha ao carregar: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const bulkLimit = Math.max(50000, (total || 0) + 1000);
      const q = new URLSearchParams();
      q.set('page', '1');
      q.set('limit', String(bulkLimit));
      q.set('orderBy', orderBy);
      q.set('order', order);
      if (search) q.set('search', search);
      const res = await api<ListResponse>(`/crm/segments/${segment}?${q}`);

      const header = [
        'Nome', 'Email', 'Telefone', 'Qtd Pedidos', 'Total Gasto',
        'Ticket Médio', 'Primeiro Pedido', 'Último Pedido', 'Dias Desde Última',
      ];
      const rows = res.data.map((c) => [
        c.name ?? '',
        c.email,
        c.phone ?? '',
        String(c.orderCount),
        c.totalSpent.toFixed(2).replace('.', ','),
        c.avgTicket.toFixed(2).replace('.', ','),
        new Date(c.firstOrder).toLocaleDateString('pt-BR'),
        new Date(c.lastOrder).toLocaleDateString('pt-BR'),
        String(c.daysSinceLast),
      ]);
      const csv = [header, ...rows]
        .map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(';'))
        .join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `segmento_${segment}_${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Falha ao exportar: ${e.message}`);
    } finally {
      setExporting(false);
    }
  }

  // Também exporta só telefones (E.164) pra colar no Meta Custom Audience
  async function exportPhonesForMeta() {
    setExporting(true);
    try {
      const bulkLimit = Math.max(50000, (total || 0) + 1000);
      const q = new URLSearchParams();
      q.set('page', '1');
      q.set('limit', String(bulkLimit));
      q.set('orderBy', orderBy);
      q.set('order', order);
      if (search) q.set('search', search);
      const res = await api<ListResponse>(`/crm/segments/${segment}?${q}`);

      // Normaliza telefone BR pra formato E.164 sem sinais
      const rows = res.data
        .map((c) => ({
          phone: normalizePhoneE164(c.phone),
          email: c.email,
          name: c.name ?? '',
        }))
        .filter((r) => r.phone || r.email);

      // CSV compatível com Meta Ads Custom Audience:
      // phone,email,fn (first name)
      const header = ['phone', 'email', 'fn'];
      const csvRows = rows.map((r) => [
        r.phone ?? '',
        r.email,
        (r.name.split(' ')[0] ?? '').toLowerCase(),
      ]);
      const csv = [header, ...csvRows]
        .map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(','))
        .join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `meta_custom_audience_${segment}_${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Falha ao exportar: ${e.message}`);
    } finally {
      setExporting(false);
    }
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function toggleSort(field: typeof orderBy) {
    if (orderBy === field) setOrder(order === 'asc' ? 'desc' : 'asc');
    else { setOrderBy(field); setOrder(field === 'name' ? 'asc' : 'desc'); }
    setPage(1);
  }

  function whatsappLink(phone: string | null, name: string | null) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    const full = digits.startsWith('55') ? digits : `55${digits}`;
    const greeting = name ? `Oi ${name.split(' ')[0]}! 💕` : 'Oi! 💕';
    return `https://wa.me/${full}?text=${encodeURIComponent(greeting)}`;
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="max-w-7xl mx-auto p-6">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Voltar aos segmentos
      </button>

      <div className={`rounded-lg border-2 p-5 mb-6 ${v.bg} ${v.border}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-white/70 rounded-lg">
              <Icon className={`w-8 h-8 ${v.color}`} />
            </div>
            <div>
              <h1 className={`text-2xl font-bold ${v.text}`}>
                {segInfo?.label ?? segment}
              </h1>
              <p className="text-sm text-slate-600">{segInfo?.description}</p>
              <p className="text-xs text-slate-500 mt-1">
                <strong>Ação sugerida:</strong> {segInfo?.action}
              </p>
            </div>
          </div>
          <div className="text-right">
            <div className={`text-3xl font-bold ${v.text}`}>
              {total.toLocaleString('pt-BR')}
            </div>
            <div className="text-xs text-slate-500">clientes</div>
            <div className={`text-sm font-mono font-bold ${v.color} mt-1`}>
              {fmtMoney(segInfo?.totalValue ?? 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <form onSubmit={onSearchSubmit} className="flex gap-2 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar por nome, email, telefone..."
              className="w-full pl-9 pr-3 py-2 border rounded text-sm"
            />
          </div>
          <button type="submit" className="px-3 py-2 border rounded hover:bg-slate-50 text-sm">
            Buscar
          </button>
          {search && (
            <button
              type="button"
              onClick={() => { setSearchInput(''); setSearch(''); setPage(1); }}
              className="px-3 py-2 text-sm text-slate-500 hover:text-slate-800"
            >Limpar</button>
          )}
        </form>
        <div className="flex gap-2 ml-auto">
          <button
            onClick={exportCsv}
            disabled={exporting || total === 0}
            className="flex items-center gap-2 px-3 py-2 border rounded hover:bg-slate-50 text-sm disabled:opacity-50"
            title="Exportar lista completa (CSV)"
          >
            <Download className="w-4 h-4" />
            Exportar CSV
          </button>
          <button
            onClick={exportPhonesForMeta}
            disabled={exporting || total === 0}
            className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50 font-semibold"
            title="CSV no formato Custom Audience (Meta Ads)"
          >
            <Target className="w-4 h-4" />
            Exportar pro Meta Ads
          </button>
        </div>
      </div>

      {/* Tabela */}
      <div className="bg-white rounded shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th
                className="p-3 text-left cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('name')}
              >Cliente</th>
              <th className="p-3 text-left">Contato</th>
              <th
                className="p-3 text-right cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('orderCount')}
              >Qtd</th>
              <th
                className="p-3 text-right cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('totalSpent')}
              >Total</th>
              <th className="p-3 text-right">Ticket</th>
              <th
                className="p-3 text-left cursor-pointer hover:bg-slate-200 select-none"
                onClick={() => toggleSort('lastOrder')}
              >Última</th>
              <th className="p-3 text-center">Ação</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">Carregando...</td></tr>
            )}
            {!loading && list.length === 0 && (
              <tr><td colSpan={7} className="p-8 text-center text-slate-400">Nenhum cliente neste segmento.</td></tr>
            )}
            {!loading && list.map((c) => {
              const wa = whatsappLink(c.phone, c.name);
              return (
                <tr key={c.email} className="border-t hover:bg-slate-50">
                  <td className="p-3">
                    <div className="font-semibold">
                      {c.name ?? <span className="text-slate-400 italic">sem nome</span>}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="text-xs text-slate-600">{c.email}</div>
                    {c.phone && (
                      <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                        <Phone className="w-3 h-3" /> {c.phone}
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-right font-mono font-semibold">{c.orderCount}</td>
                  <td className="p-3 text-right font-mono font-bold text-emerald-700">
                    {fmtMoney(c.totalSpent)}
                  </td>
                  <td className="p-3 text-right font-mono text-slate-700">
                    {fmtMoney(c.avgTicket)}
                  </td>
                  <td className="p-3 text-slate-600 text-xs">
                    {fmtDays(c.daysSinceLast)}
                  </td>
                  <td className="p-3 text-center">
                    {wa ? (
                      <a
                        href={wa}
                        target="wa-out"
                        className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-600 text-white rounded text-xs hover:bg-emerald-700"
                        title="Abrir WhatsApp Web"
                      >
                        <MessageCircle className="w-3 h-3" />
                        WhatsApp
                      </a>
                    ) : (
                      <span className="text-xs text-slate-400">sem fone</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-between items-center mt-4 text-sm text-slate-600">
          <div>{total.toLocaleString('pt-BR')} cliente(s) — página {page} de {totalPages}</div>
          <div className="flex gap-1">
            <button disabled={page === 1} onClick={() => setPage(1)} className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">«</button>
            <button disabled={page === 1} onClick={() => setPage(page - 1)} className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">‹</button>
            <span className="px-3 py-1">{page}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">›</button>
            <button disabled={page >= totalPages} onClick={() => setPage(totalPages)} className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">»</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Normaliza telefone para E.164 BR (+55XXXXXXXXXXX) ou null se inválido. */
function normalizePhoneE164(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  const full = digits.startsWith('55') ? digits : `55${digits}`;
  return `+${full}`;
}
