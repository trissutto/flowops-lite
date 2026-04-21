'use client';

/**
 * /crm/lista-personalizada — Construtor de lista com filtros combináveis.
 *
 * Filtros disponíveis (todos opcionais, combinados via AND):
 *   - Quantidade de pedidos (min / max)
 *   - Valor total gasto (min / max em R$)
 *   - Ticket médio (min / max em R$)
 *   - Data da última compra (de / até)
 *   - Data da primeira compra (de / até)
 *   - Dias desde última compra (min / max) — útil pra janelas de reativação
 *   - Segmentos RFM (checkbox múltipla)
 *   - Exige telefone / email
 *   - Busca textual (nome/email/telefone)
 *
 * Export CSV completo + export Meta Custom Audience (formato phone,email,fn).
 * Renderizada como aba dentro de /marketing.
 */

import { useState } from 'react';
import { api } from '@/lib/api';
import {
  Filter, Search, Download, Target, MessageCircle, Phone,
  RefreshCw, X, ChevronDown, ChevronUp,
} from 'lucide-react';

type SegmentKey = 'vip' | 'em_risco' | 'novos' | 'inativos' | 'one_shot' | 'regulares';

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

interface CustomResponse {
  data: Customer[];
  total: number;
  totalValue: number;
  page: number;
  limit: number;
}

interface Filters {
  minOrderCount?: number;
  maxOrderCount?: number;
  minTotalSpent?: number;
  maxTotalSpent?: number;
  minAvgTicket?: number;
  maxAvgTicket?: number;
  lastOrderFrom?: string;
  lastOrderTo?: string;
  firstOrderFrom?: string;
  firstOrderTo?: string;
  minDaysSinceLast?: number;
  maxDaysSinceLast?: number;
  segments?: SegmentKey[];
  requirePhone?: boolean;
  requireEmail?: boolean;
  search?: string;
}

const SEGMENT_OPTIONS: { key: SegmentKey; label: string }[] = [
  { key: 'vip',       label: 'VIPs' },
  { key: 'em_risco',  label: 'Em Risco' },
  { key: 'novos',     label: 'Novos' },
  { key: 'inativos',  label: 'Inativos' },
  { key: 'one_shot',  label: 'One-Shot' },
  { key: 'regulares', label: 'Regulares' },
];

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

function normalizePhoneE164(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  const full = digits.startsWith('55') ? digits : `55${digits}`;
  return `+${full}`;
}

export default function ListaPersonalizadaPage() {
  const [filters, setFilters] = useState<Filters>({});
  const [data, setData] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [totalValue, setTotalValue] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [orderBy, setOrderBy] = useState<'totalSpent' | 'orderCount' | 'avgTicket' | 'lastOrder' | 'daysSinceLast'>('totalSpent');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [searched, setSearched] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K] | null) {
    setFilters((f) => {
      const next = { ...f };
      if (value === null || value === undefined || value === '' as any) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  }

  function toggleSegment(seg: SegmentKey) {
    setFilters((f) => {
      const curr = new Set(f.segments ?? []);
      if (curr.has(seg)) curr.delete(seg);
      else curr.add(seg);
      return { ...f, segments: curr.size > 0 ? Array.from(curr) : undefined };
    });
  }

  function clearFilters() {
    setFilters({});
    setData([]);
    setTotal(0);
    setTotalValue(0);
    setSearched(false);
    setPage(1);
  }

  async function applyFilters(targetPage: number = 1) {
    setLoading(true);
    try {
      const payload = {
        ...filters,
        orderBy,
        order,
        page: targetPage,
        limit,
      };
      const res = await api<CustomResponse>('/crm/custom', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setData(res.data);
      setTotal(res.total);
      setTotalValue(res.totalValue);
      setPage(res.page);
      setSearched(true);
    } catch (e: any) {
      alert(`Falha ao aplicar filtros: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const bulkLimit = Math.max(50000, (total || 0) + 1000);
      const payload = {
        ...filters,
        orderBy,
        order,
        page: 1,
        limit: bulkLimit,
      };
      const res = await api<CustomResponse>('/crm/custom', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const header = [
        'Nome', 'Email', 'Telefone', 'Qtd Pedidos', 'Total Gasto', 'Ticket Médio',
        'Primeiro Pedido', 'Último Pedido', 'Dias Desde Última', 'Segmento',
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
        c.segment,
      ]);
      const csv = [header, ...rows]
        .map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(';'))
        .join('\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `lista_personalizada_${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Falha ao exportar: ${e.message}`);
    } finally {
      setExporting(false);
    }
  }

  async function exportMeta() {
    setExporting(true);
    try {
      const bulkLimit = Math.max(50000, (total || 0) + 1000);
      const payload = {
        ...filters,
        orderBy,
        order,
        page: 1,
        limit: bulkLimit,
      };
      const res = await api<CustomResponse>('/crm/custom', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      // Formato OFICIAL Meta Ads — Value-Based Audience (19 colunas).
      // Ref: https://www.facebook.com/business/help/606443329504150
      // O que importa pra nós: value (LTV) viabiliza Lookalike por valor;
      // email/phone viram a chave de match; fn/ln melhoram taxa de cadastro.
      const header = [
        'email','email','email',
        'phone','phone','phone',
        'madid','fn','ln','zip','ct','st','country',
        'dob','doby','gen','age','uid','value',
      ];

      const rows = res.data.map((c) => {
        const phone = normalizePhoneE164(c.phone) ?? '';
        const parts = (c.name ?? '').trim().split(/\s+/).filter(Boolean);
        const fn = (parts[0] ?? '').toLowerCase();
        const ln = parts.length > 1 ? parts.slice(1).join(' ').toLowerCase() : '';
        // value = TICKET MÉDIO (não LTV). Por quê:
        // LTV premia cliente que compra MUITAS vezes (frequência > valor).
        // Ticket médio premia cliente que gasta ALTO POR PEDIDO — melhor
        // pra Lookalike de lead qualificado (quem converte em compra cheia).
        // Formato . decimal (obrigatório pro Meta).
        const value = Number(c.avgTicket || 0).toFixed(2);
        return [
          c.email, '', '',        // email x3 (só temos 1)
          phone,   '', '',        // phone x3 (só temos 1)
          '',                     // madid (não temos)
          fn, ln,
          '', '', '',             // zip, ct, st (não temos)
          'BR',                   // country
          '', '', '', '',         // dob, doby, gen, age (não temos)
          c.email,                // uid estável = email
          value,                  // value = TICKET MÉDIO em R$
        ];
      });

      // Meta exige CSV simples, sem BOM, vírgula, sem aspas se não precisar.
      const csv = [header, ...rows]
        .map((r) => r.map((f) => {
          const s = String(f);
          // Só usa aspas se o campo contém vírgula, aspas ou quebra de linha
          if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
          return s;
        }).join(','))
        .join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `meta_value_based_audience_${stamp}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Falha ao exportar: ${e.message}`);
    } finally {
      setExporting(false);
    }
  }

  function whatsappLink(phone: string | null, name: string | null) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    const full = digits.startsWith('55') ? digits : `55${digits}`;
    const greeting = name ? `Oi ${name.split(' ')[0]}! 💕` : 'Oi! 💕';
    return `https://wa.me/${full}?text=${encodeURIComponent(greeting)}`;
  }

  const activeFilterCount = Object.entries(filters).filter(([_, v]) => {
    if (v === undefined || v === null || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  }).length;

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Lista Personalizada</h1>
        <p className="text-sm text-slate-500">
          Combine filtros livres (data, valor, pedidos, recência, segmento) pra gerar listas sob medida.
        </p>
      </div>

      {/* Painel de filtros */}
      <div className="bg-white rounded-lg shadow border mb-4">
        <button
          onClick={() => setFiltersOpen(!filtersOpen)}
          className="w-full flex items-center justify-between p-4 hover:bg-slate-50"
        >
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-slate-600" />
            <span className="font-semibold">Filtros</span>
            {activeFilterCount > 0 && (
              <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs font-bold">
                {activeFilterCount} ativo(s)
              </span>
            )}
          </div>
          {filtersOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
        </button>

        {filtersOpen && (
          <div className="p-4 border-t space-y-4">
            {/* Número de pedidos */}
            <RangeRow
              label="Quantidade de pedidos"
              help="Ex.: 2 a 10 = clientes recorrentes"
              minVal={filters.minOrderCount}
              maxVal={filters.maxOrderCount}
              onMin={(v) => updateFilter('minOrderCount', v)}
              onMax={(v) => updateFilter('maxOrderCount', v)}
              placeholder={['mín. 1', 'sem limite']}
            />

            {/* Valor total gasto */}
            <RangeRow
              label="Valor total gasto (R$)"
              help="Soma de todas as compras do cliente"
              minVal={filters.minTotalSpent}
              maxVal={filters.maxTotalSpent}
              onMin={(v) => updateFilter('minTotalSpent', v)}
              onMax={(v) => updateFilter('maxTotalSpent', v)}
              placeholder={['ex.: 500', 'ex.: 5000']}
            />

            {/* Ticket médio */}
            <RangeRow
              label="Ticket médio (R$)"
              help="Valor médio por pedido"
              minVal={filters.minAvgTicket}
              maxVal={filters.maxAvgTicket}
              onMin={(v) => updateFilter('minAvgTicket', v)}
              onMax={(v) => updateFilter('maxAvgTicket', v)}
              placeholder={['ex.: 200', 'ex.: 1000']}
            />

            {/* Dias desde última compra */}
            <RangeRow
              label="Dias desde última compra"
              help="Janela de recência: ex.: 60 a 180 = em risco"
              minVal={filters.minDaysSinceLast}
              maxVal={filters.maxDaysSinceLast}
              onMin={(v) => updateFilter('minDaysSinceLast', v)}
              onMax={(v) => updateFilter('maxDaysSinceLast', v)}
              placeholder={['ex.: 60', 'ex.: 180']}
            />

            {/* Data última compra */}
            <DateRangeRow
              label="Data da última compra"
              fromVal={filters.lastOrderFrom}
              toVal={filters.lastOrderTo}
              onFrom={(v) => updateFilter('lastOrderFrom', v)}
              onTo={(v) => updateFilter('lastOrderTo', v)}
            />

            {/* Data primeira compra */}
            <DateRangeRow
              label="Data da primeira compra"
              fromVal={filters.firstOrderFrom}
              toVal={filters.firstOrderTo}
              onFrom={(v) => updateFilter('firstOrderFrom', v)}
              onTo={(v) => updateFilter('firstOrderTo', v)}
            />

            {/* Segmentos RFM */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Segmentos RFM
              </label>
              <div className="flex flex-wrap gap-2">
                {SEGMENT_OPTIONS.map((s) => {
                  const on = filters.segments?.includes(s.key);
                  return (
                    <button
                      key={s.key}
                      onClick={() => toggleSegment(s.key)}
                      className={`px-3 py-1 rounded-full border text-xs font-medium transition ${
                        on
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-slate-400 mt-1">Sem seleção = todos os segmentos.</p>
            </div>

            {/* Exige contatos */}
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.requirePhone ?? false}
                  onChange={(e) => updateFilter('requirePhone', e.target.checked ? true : null)}
                  className="w-4 h-4"
                />
                Só com telefone (pra WhatsApp)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.requireEmail ?? false}
                  onChange={(e) => updateFilter('requireEmail', e.target.checked ? true : null)}
                  className="w-4 h-4"
                />
                Só com email
              </label>
            </div>

            {/* Busca textual */}
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Busca (nome, email, telefone)
              </label>
              <div className="relative max-w-md">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={filters.search ?? ''}
                  onChange={(e) => updateFilter('search', e.target.value)}
                  placeholder="deixe vazio pra ignorar"
                  className="w-full pl-9 pr-3 py-2 border rounded text-sm"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={() => applyFilters(1)}
                disabled={loading}
                className="px-5 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-semibold disabled:opacity-50"
              >
                {loading ? 'Aplicando…' : 'Aplicar filtros'}
              </button>
              <button
                onClick={clearFilters}
                className="px-4 py-2 border rounded hover:bg-slate-50 text-sm flex items-center gap-1"
              >
                <X className="w-4 h-4" /> Limpar tudo
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Resultado */}
      {searched && (
        <>
          <div className="bg-white rounded-lg shadow p-4 mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs text-slate-500 uppercase">Resultado</div>
              <div className="text-2xl font-bold">
                {total.toLocaleString('pt-BR')} cliente(s)
              </div>
              <div className="text-sm font-mono text-emerald-700 font-bold">
                {fmtMoney(totalValue)} em valor histórico
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => applyFilters(page)}
                className="p-2 border rounded hover:bg-slate-50"
                title="Recalcular"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={exportCsv}
                disabled={exporting || total === 0}
                className="flex items-center gap-2 px-3 py-2 border rounded hover:bg-slate-50 text-sm disabled:opacity-50"
              >
                <Download className="w-4 h-4" /> CSV completo
              </button>
              <button
                onClick={exportMeta}
                disabled={exporting || total === 0}
                className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50 font-semibold"
              >
                <Target className="w-4 h-4" /> Exportar pro Meta Ads
              </button>
            </div>
          </div>

          {/* Ordenação */}
          <div className="mb-2 flex items-center gap-2 text-sm text-slate-600">
            <span>Ordenar por:</span>
            <select
              value={orderBy}
              onChange={(e) => { setOrderBy(e.target.value as any); applyFilters(1); }}
              className="border rounded px-2 py-1 text-sm"
            >
              <option value="totalSpent">Total gasto</option>
              <option value="orderCount">Qtd pedidos</option>
              <option value="avgTicket">Ticket médio</option>
              <option value="lastOrder">Data última compra</option>
              <option value="daysSinceLast">Dias sem comprar</option>
            </select>
            <button
              onClick={() => { setOrder(order === 'desc' ? 'asc' : 'desc'); applyFilters(1); }}
              className="border rounded px-2 py-1 text-sm hover:bg-slate-50"
            >
              {order === 'desc' ? '↓ desc' : '↑ asc'}
            </button>
          </div>

          {/* Tabela */}
          <div className="bg-white rounded shadow overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-3 text-left">Cliente</th>
                  <th className="p-3 text-left">Contato</th>
                  <th className="p-3 text-center">Seg</th>
                  <th className="p-3 text-right">Qtd</th>
                  <th className="p-3 text-right">Total</th>
                  <th className="p-3 text-right">Ticket</th>
                  <th className="p-3 text-left">Última</th>
                  <th className="p-3 text-center">Ação</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={8} className="p-6 text-center text-slate-400">Carregando...</td></tr>
                )}
                {!loading && data.length === 0 && (
                  <tr><td colSpan={8} className="p-8 text-center text-slate-400">
                    Nenhum cliente com esses filtros. Relaxe alguma condição.
                  </td></tr>
                )}
                {!loading && data.map((c) => {
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
                      <td className="p-3 text-center">
                        <span className="px-2 py-0.5 text-xs rounded bg-slate-100">
                          {c.segment}
                        </span>
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
              <div>{total.toLocaleString('pt-BR')} — página {page} de {totalPages}</div>
              <div className="flex gap-1">
                <button disabled={page === 1} onClick={() => applyFilters(1)} className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">«</button>
                <button disabled={page === 1} onClick={() => applyFilters(page - 1)} className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">‹</button>
                <span className="px-3 py-1">{page}</span>
                <button disabled={page >= totalPages} onClick={() => applyFilters(page + 1)} className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">›</button>
                <button disabled={page >= totalPages} onClick={() => applyFilters(totalPages)} className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-slate-50">»</button>
              </div>
            </div>
          )}
        </>
      )}

      {!searched && (
        <div className="bg-slate-50 rounded-lg border p-8 text-center text-slate-500">
          Configure os filtros acima e clique em <strong>Aplicar filtros</strong> pra gerar a lista.
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Componentes auxiliares
// ============================================================================

function RangeRow({
  label, help, minVal, maxVal, onMin, onMax, placeholder,
}: {
  label: string;
  help?: string;
  minVal: number | undefined;
  maxVal: number | undefined;
  onMin: (v: number | null) => void;
  onMax: (v: number | null) => void;
  placeholder: [string, string];
}) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={minVal ?? ''}
          onChange={(e) => onMin(e.target.value === '' ? null : Number(e.target.value))}
          placeholder={placeholder[0]}
          className="w-32 border rounded px-2 py-1 text-sm"
        />
        <span className="text-slate-400">até</span>
        <input
          type="number"
          value={maxVal ?? ''}
          onChange={(e) => onMax(e.target.value === '' ? null : Number(e.target.value))}
          placeholder={placeholder[1]}
          className="w-32 border rounded px-2 py-1 text-sm"
        />
        {help && <span className="text-xs text-slate-400 ml-2">{help}</span>}
      </div>
    </div>
  );
}

function DateRangeRow({
  label, fromVal, toVal, onFrom, onTo,
}: {
  label: string;
  fromVal: string | undefined;
  toVal: string | undefined;
  onFrom: (v: string | null) => void;
  onTo: (v: string | null) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={fromVal ?? ''}
          onChange={(e) => onFrom(e.target.value || null)}
          className="border rounded px-2 py-1 text-sm"
        />
        <span className="text-slate-400">até</span>
        <input
          type="date"
          value={toVal ?? ''}
          onChange={(e) => onTo(e.target.value || null)}
          className="border rounded px-2 py-1 text-sm"
        />
      </div>
    </div>
  );
}
