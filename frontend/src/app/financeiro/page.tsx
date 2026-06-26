'use client';

/**
 * /financeiro — Dashboard Financeiro/Analítico dos pedidos.
 *
 * Seletor de período OBRIGATÓRIO (sem default) — user define from/to a cada acesso.
 * Fonte: GET /orders/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD (banco local, espelho WC).
 *
 * O que mostra:
 *   - KPIs: total pedidos, faturamento, ticket médio, enviados, pickup vs frete,
 *     transferências entre lojas, taxa de envio, cancelados.
 *   - Ranking de lojas (quem separou mais, faturamento rateado, taxa de envio).
 *   - Gráfico de volume diário (barra CSS, sem dependência extra).
 *   - Top 20 produtos (quantidade + receita).
 *   - Breakdown por status.
 *   - Export CSV do período completo.
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import {
  BarChart3, Calendar, Download, Loader2, Package, Store as StoreIcon,
  Truck, TrendingUp, DollarSign, ShoppingBag, AlertTriangle, ArrowRightLeft,
} from 'lucide-react';

interface Analytics {
  period: { from: string; to: string; days: number };
  kpis: {
    totalOrders: number;
    totalRevenue: number;
    avgTicket: number;
    cancelledCount: number;
    cancelledRevenue: number;
    shippedCount: number;
    shippedRevenue: number;
    inProgressCount: number;
    pickupCount: number;
    pickupRevenue: number;
    shippingCount: number;
    shippingRevenue: number;
    transferCount: number;
    shipmentRate: number;
  };
  byStatus: Array<{ status: string; count: number; revenue: number }>;
  byStore: Array<{
    storeCode: string; storeName: string;
    pickOrders: number; shipped: number; transferOut: number;
    revenue: number; approved: number;
  }>;
  byDay: Array<{ date: string; count: number; revenue: number }>;
  topProducts: Array<{ sku: string; productName: string; quantity: number; revenue: number }>;
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pagamento pendente',
  processing: 'Processando',
  routing: 'Roteando',
  awaiting_stock: 'Aguardando estoque',
  separating: 'Em separação',
  separated: 'Separado',
  ready: 'Pronto',
  shipped: 'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
  failed: 'Malsucedido',
};

function fmtMoney(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtInt(v: number) {
  return v.toLocaleString('pt-BR');
}
function fmtPct(v: number) {
  return `${(v * 100).toFixed(1)}%`;
}
function todayIso() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

export default function FinanceiroPage() {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard de auth — mesmo padrão das outras telas
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) window.location.href = '/login';
  }, []);

  async function carregar(e?: React.FormEvent) {
    e?.preventDefault();
    if (!from || !to) {
      setError('Escolhe o período (de / até) antes de gerar.');
      return;
    }
    if (from > to) {
      setError('Data inicial não pode ser maior que a final.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ from, to });
      const res = await api<Analytics>(`/orders/analytics?${q}`);
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? 'Falha ao carregar');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  function setAtalho(dias: number) {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (dias - 1));
    const fmt = (d: Date) => {
      const o = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - o).toISOString().slice(0, 10);
    };
    setFrom(fmt(start));
    setTo(fmt(end));
  }

  function exportCSV() {
    if (!data) return;
    const lines: string[] = [];
    // Cabeçalho do relatório
    lines.push(`Relatório Financeiro — ${data.period.from} até ${data.period.to} (${data.period.days} dia(s))`);
    lines.push('');
    // KPIs
    lines.push('INDICADORES');
    lines.push(`Total de pedidos;${data.kpis.totalOrders}`);
    lines.push(`Faturamento;${data.kpis.totalRevenue.toFixed(2).replace('.', ',')}`);
    lines.push(`Ticket médio;${data.kpis.avgTicket.toFixed(2).replace('.', ',')}`);
    lines.push(`Enviados;${data.kpis.shippedCount};${data.kpis.shippedRevenue.toFixed(2).replace('.', ',')}`);
    lines.push(`Em andamento;${data.kpis.inProgressCount}`);
    lines.push(`Cancelados;${data.kpis.cancelledCount};${data.kpis.cancelledRevenue.toFixed(2).replace('.', ',')}`);
    lines.push(`Pickup (retirada);${data.kpis.pickupCount};${data.kpis.pickupRevenue.toFixed(2).replace('.', ',')}`);
    lines.push(`Frete (envio);${data.kpis.shippingCount};${data.kpis.shippingRevenue.toFixed(2).replace('.', ',')}`);
    lines.push(`Transferências entre lojas;${data.kpis.transferCount}`);
    lines.push(`Taxa de envio;${(data.kpis.shipmentRate * 100).toFixed(1)}%`);
    lines.push('');
    // Lojas
    lines.push('POR LOJA');
    lines.push('Código;Nome;Separações;Enviadas;Transferências;Aprovadas;Faturamento');
    for (const s of data.byStore) {
      lines.push([
        s.storeCode, s.storeName, s.pickOrders, s.shipped, s.transferOut, s.approved,
        s.revenue.toFixed(2).replace('.', ','),
      ].join(';'));
    }
    lines.push('');
    // Dia a dia
    lines.push('POR DIA');
    lines.push('Data;Pedidos;Faturamento');
    for (const d of data.byDay) {
      lines.push([d.date, d.count, d.revenue.toFixed(2).replace('.', ',')].join(';'));
    }
    lines.push('');
    // Produtos
    lines.push('TOP PRODUTOS');
    lines.push('SKU;Produto;Quantidade;Receita');
    for (const p of data.topProducts) {
      lines.push([p.sku, p.productName, p.quantity, p.revenue.toFixed(2).replace('.', ',')].join(';'));
    }
    lines.push('');
    // Status
    lines.push('POR STATUS');
    lines.push('Status;Qtd;Valor');
    for (const s of data.byStatus) {
      lines.push([STATUS_LABELS[s.status] ?? s.status, s.count, s.revenue.toFixed(2).replace('.', ',')].join(';'));
    }

    const csv = lines.join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `financeiro_${data.period.from}_a_${data.period.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // pico pra normalizar barras do mini-gráfico
  const maxDayRevenue = data ? Math.max(...data.byDay.map((d) => d.revenue), 1) : 1;

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="w-6 h-6" /> Financeiro / Analítico
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Escolhe o período, aperta Gerar. Fonte: banco local espelhando o WooCommerce.
        </p>
      </div>

      {/* Seletor de período */}
      <form
        onSubmit={carregar}
        className="bg-white rounded-lg shadow border p-4 mb-6 flex flex-wrap items-end gap-3"
      >
        <div>
          <label className="block text-xs text-slate-500 mb-1">De</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            max={todayIso()}
            className="px-3 py-2 border rounded text-sm"
            required
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Até</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            max={todayIso()}
            className="px-3 py-2 border rounded text-sm"
            required
          />
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAtalho(1)}
            className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50"
          >
            Hoje
          </button>
          <button
            type="button"
            onClick={() => setAtalho(7)}
            className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50"
          >
            7 dias
          </button>
          <button
            type="button"
            onClick={() => setAtalho(30)}
            className="px-3 py-2 text-xs text-slate-600 border rounded hover:bg-slate-50"
          >
            30 dias
          </button>
        </div>
        <button
          type="submit"
          disabled={loading || !from || !to}
          className="px-4 py-2 bg-brand text-white rounded hover:bg-brand-dark text-sm font-semibold disabled:opacity-50 flex items-center gap-2"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
          Gerar
        </button>
        {data && (
          <button
            type="button"
            onClick={exportCSV}
            className="px-3 py-2 bg-white border rounded text-sm hover:bg-slate-50 flex items-center gap-2 ml-auto"
          >
            <Download className="w-4 h-4" /> Exportar CSV
          </button>
        )}
      </form>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-3 mb-4 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {!data && !loading && !error && (
        <div className="bg-white rounded-lg shadow p-12 text-center text-slate-400">
          Selecione o período acima e aperte <b>Gerar</b> pra ver o relatório.
        </div>
      )}

      {data && (
        <>
          {/* KPIs principais */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Kpi
              icon={<ShoppingBag className="w-5 h-5" />}
              label="Pedidos"
              value={fmtInt(data.kpis.totalOrders)}
              sub={`${fmtInt(data.kpis.cancelledCount)} cancelado(s)`}
              tone="slate"
            />
            <Kpi
              icon={<DollarSign className="w-5 h-5" />}
              label="Faturamento"
              value={fmtMoney(data.kpis.totalRevenue)}
              sub={`Ticket médio ${fmtMoney(data.kpis.avgTicket)}`}
              tone="emerald"
            />
            <Kpi
              icon={<Truck className="w-5 h-5" />}
              label="Enviados"
              value={fmtInt(data.kpis.shippedCount)}
              sub={`${fmtPct(data.kpis.shipmentRate)} dos válidos · ${fmtMoney(data.kpis.shippedRevenue)}`}
              tone="blue"
            />
            <Kpi
              icon={<TrendingUp className="w-5 h-5" />}
              label="Em andamento"
              value={fmtInt(data.kpis.inProgressCount)}
              sub={`Ainda não enviados`}
              tone="amber"
            />
          </div>

          {/* KPIs secundários — origem do envio */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <Kpi
              icon={<StoreIcon className="w-5 h-5" />}
              label="Retirada em loja"
              value={fmtInt(data.kpis.pickupCount)}
              sub={fmtMoney(data.kpis.pickupRevenue)}
              tone="violet"
            />
            <Kpi
              icon={<Truck className="w-5 h-5" />}
              label="Frete (envio postal)"
              value={fmtInt(data.kpis.shippingCount)}
              sub={fmtMoney(data.kpis.shippingRevenue)}
              tone="slate"
            />
            <Kpi
              icon={<ArrowRightLeft className="w-5 h-5" />}
              label="Transferências"
              value={fmtInt(data.kpis.transferCount)}
              sub="Pedidos que mudaram de loja"
              tone="amber"
            />
            <Kpi
              icon={<AlertTriangle className="w-5 h-5" />}
              label="Período"
              value={`${data.period.days} dia(s)`}
              sub={`${data.period.from} → ${data.period.to}`}
              tone="slate"
            />
          </div>

          {/* Volume diário (barra CSS simples) */}
          <div className="bg-white rounded-lg shadow border p-5 mb-6">
            <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" /> Faturamento por dia
            </h2>
            {data.byDay.length === 0 ? (
              <div className="text-sm text-slate-400 py-4">Sem pedidos nesse período.</div>
            ) : (
              <div className="space-y-1.5">
                {data.byDay.map((d) => {
                  const pct = (d.revenue / maxDayRevenue) * 100;
                  return (
                    <div key={d.date} className="flex items-center gap-3 text-xs">
                      <div className="w-20 font-mono text-slate-500 shrink-0">
                        {d.date.slice(5)}
                      </div>
                      <div className="flex-1 bg-slate-100 rounded h-6 relative overflow-hidden">
                        <div
                          className="h-full bg-emerald-500 rounded transition-all"
                          style={{ width: `${pct}%` }}
                        />
                        <div className="absolute inset-0 flex items-center px-2 font-medium text-slate-800">
                          {fmtMoney(d.revenue)}
                        </div>
                      </div>
                      <div className="w-20 text-right font-mono text-slate-600 shrink-0">
                        {d.count} ped.
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            {/* Ranking por loja */}
            <div className="bg-white rounded-lg shadow border p-5">
              <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <StoreIcon className="w-4 h-4" /> Por loja (de onde saiu)
              </h2>
              {data.byStore.length === 0 ? (
                <div className="text-sm text-slate-400 py-4">Sem separações nesse período.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-500 border-b">
                      <tr>
                        <th className="text-left py-2 pr-2">Loja</th>
                        <th className="text-right py-2 px-1">Sepa.</th>
                        <th className="text-right py-2 px-1">Envi.</th>
                        <th className="text-right py-2 px-1" title="Pedidos transferidos pra outra loja">Transf.</th>
                        <th className="text-right py-2 px-1" title="Baixa já aprovada pela matriz">Aprov.</th>
                        <th className="text-right py-2 pl-1">Faturamento</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byStore.map((s) => (
                        <tr key={s.storeCode} className="border-b last:border-0">
                          <td className="py-2 pr-2">
                            <div className="font-semibold">{s.storeName}</div>
                            <div className="font-mono text-slate-400 text-[10px]">{s.storeCode}</div>
                          </td>
                          <td className="text-right py-2 px-1 font-mono">{s.pickOrders}</td>
                          <td className="text-right py-2 px-1 font-mono text-emerald-700">{s.shipped}</td>
                          <td className="text-right py-2 px-1 font-mono text-amber-700">{s.transferOut || '—'}</td>
                          <td className="text-right py-2 px-1 font-mono text-blue-700">{s.approved}</td>
                          <td className="text-right py-2 pl-1 font-mono font-semibold">
                            {fmtMoney(s.revenue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Breakdown por status */}
            <div className="bg-white rounded-lg shadow border p-5">
              <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" /> Por status
              </h2>
              <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-500 border-b">
                  <tr>
                    <th className="text-left py-2">Status</th>
                    <th className="text-right py-2">Qtd</th>
                    <th className="text-right py-2">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byStatus.map((s) => (
                    <tr key={s.status} className="border-b last:border-0">
                      <td className="py-2">{STATUS_LABELS[s.status] ?? s.status}</td>
                      <td className="text-right py-2 font-mono">{s.count}</td>
                      <td className="text-right py-2 font-mono">{fmtMoney(s.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          </div>

          {/* Top produtos */}
          <div className="bg-white rounded-lg shadow border p-5 mb-6">
            <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
              <Package className="w-4 h-4" /> Top 20 produtos do período
            </h2>
            {data.topProducts.length === 0 ? (
              <div className="text-sm text-slate-400 py-4">Sem itens nesse período.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-500 border-b">
                    <tr>
                      <th className="text-left py-2 pr-2">#</th>
                      <th className="text-left py-2 pr-2">Produto</th>
                      <th className="text-left py-2 pr-2">SKU</th>
                      <th className="text-right py-2 px-1">Qtd vendida</th>
                      <th className="text-right py-2 pl-1">Receita estimada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topProducts.map((p, i) => (
                      <tr key={p.sku} className="border-b last:border-0">
                        <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                        <td className="py-2 pr-2">{p.productName}</td>
                        <td className="py-2 pr-2 font-mono text-slate-500">{p.sku}</td>
                        <td className="text-right py-2 px-1 font-mono font-semibold">{p.quantity}</td>
                        <td className="text-right py-2 pl-1 font-mono">{fmtMoney(p.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ==========================================================================
// Card de KPI reaproveitável
// ==========================================================================
function Kpi({
  icon, label, value, sub, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone: 'emerald' | 'blue' | 'amber' | 'violet' | 'slate';
}) {
  const tones: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    blue:    'bg-blue-50 text-blue-800 border-blue-200',
    amber:   'bg-amber-50 text-amber-800 border-amber-200',
    violet:  'bg-violet-50 text-violet-800 border-violet-200',
    slate:   'bg-white text-slate-800 border-slate-200',
  };
  return (
    <div className={`rounded-lg border p-4 ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-xs opacity-75 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-bold leading-tight">{value}</div>
      {sub && <div className="text-xs opacity-70 mt-1">{sub}</div>}
    </div>
  );
}
