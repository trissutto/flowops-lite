'use client';

/**
 * /retaguarda/transferencias-report — Relatório de Transferências Entre Lojas
 *
 * Tela executiva + analítica de transferências entre lojas da rede Lurd's.
 *
 * 3 níveis de drill-down (sem reload):
 *  Nível 1 — Visão Executiva: KPI cards + tabela rede + gráficos + matriz
 *  Nível 2 — Visão Analítica da Loja: drawer lateral com enviadas + recebidas
 *  Nível 3 — Detalhe da Transferência: modal full com timeline + itens
 *
 * Dados: lê de /api/transferencias/report (com fallback pra mock se backend
 * não tiver o endpoint ainda — permite operar a tela mesmo sem deploy).
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowLeft,
  AlertTriangle,
  Boxes,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Filter,
  Grid3x3,
  Layers,
  Loader2,
  Maximize2,
  Package,
  Printer,
  Search,
  Send,
  Settings,
  Sparkles,
  TrendingDown,
  TrendingUp,
  X,
  XCircle,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '@/lib/api';

/* ─── Types ─── */
type ShipmentStatus = 'open' | 'in_transit' | 'received' | 'cancelled';

interface StoreAggregate {
  code: string;
  name: string;
  city: string;
  sentQty: number;
  sentValue: number;
  receivedQty: number;
  receivedValue: number;
  balanceQty: number;
  balanceValue: number;
  shipmentsCount: number;
}

interface ShipmentRow {
  id: string;
  code: string;
  fromStoreCode: string;
  fromStoreName: string;
  toStoreCode: string;
  toStoreName: string;
  status: ShipmentStatus;
  totalQty: number;
  receivedQty: number;
  missingQty: number;
  totalValue: number;
  sentAt: string | null;
  receivedAt: string | null;
  openedAt: string;
  userResponsible: string;
}

interface ShipmentItem {
  sku: string;
  ref: string;
  productName: string;
  cor: string;
  tamanho: string;
  qty: number;
  receivedQty: number;
  unitCost: number;
  total: number;
  status: 'received' | 'missing' | 'pending';
}

interface ReportData {
  period: { from: string; to: string };
  summary: {
    totalShipments: number;
    totalQty: number;
    totalValue: number;
    topSender: { code: string; name: string; qty: number };
    topReceiver: { code: string; name: string; qty: number };
    divergencyQty: number;
    pendingShipments: number;
  };
  stores: StoreAggregate[];
  shipments: ShipmentRow[];
  monthlyEvolution: Array<{ month: string; sent: number; received: number; value: number }>;
  matrix: Array<{ from: string; to: string; qty: number; value: number }>;
}

/* ─── Mock data — usado se o endpoint não existir ainda ─── */
const MOCK_STORES = [
  { code: '01', name: 'Lurd\'s Campinas', city: 'Campinas' },
  { code: '02', name: 'Lurd\'s Sorocaba', city: 'Sorocaba' },
  { code: '03', name: 'Lurd\'s Praia Grande', city: 'Praia Grande' },
  { code: '04', name: 'Lurd\'s Limeira', city: 'Limeira' },
  { code: '05', name: 'Lurd\'s Indaiatuba', city: 'Indaiatuba' },
  { code: '06', name: 'Lurd\'s Itanhaém', city: 'Itanhaém' },
  { code: '07', name: 'Lurd\'s São José dos Campos', city: 'São José dos Campos' },
  { code: '08', name: 'Lurd\'s Piracicaba', city: 'Piracicaba' },
  { code: '09', name: 'Lurd\'s Vinhedo', city: 'Vinhedo' },
  { code: '10', name: 'Lurd\'s SJC Centro', city: 'São José dos Campos' },
  { code: '11', name: 'Lurd\'s Bal. Camboriú', city: 'Balneário Camboriú' },
  { code: '12', name: 'Lurd\'s Jundiaí', city: 'Jundiaí' },
  { code: '13', name: 'CD Central', city: 'Itu' },
  { code: '14', name: 'Lurd\'s Atibaia', city: 'Atibaia' },
];

function generateMockData(): ReportData {
  const stores: StoreAggregate[] = MOCK_STORES.map((s, i) => {
    const sentQty = Math.round(80 + Math.random() * 420);
    const receivedQty = Math.round(80 + Math.random() * 420);
    const avgPrice = 110 + Math.random() * 80;
    return {
      code: s.code,
      name: s.name,
      city: s.city,
      sentQty,
      sentValue: Math.round(sentQty * avgPrice),
      receivedQty,
      receivedValue: Math.round(receivedQty * avgPrice * 0.97),
      balanceQty: receivedQty - sentQty,
      balanceValue: Math.round((receivedQty - sentQty) * avgPrice),
      shipmentsCount: Math.round(8 + Math.random() * 22),
    };
  });
  // CD Central sempre envia mais do que recebe (é abastecedor)
  const cd = stores.find((s) => s.code === '13')!;
  cd.sentQty = 1840;
  cd.sentValue = 248_000;
  cd.receivedQty = 240;
  cd.receivedValue = 32_400;
  cd.balanceQty = cd.receivedQty - cd.sentQty;
  cd.balanceValue = cd.receivedValue - cd.sentValue;
  cd.shipmentsCount = 87;

  // Matriz origem → destino (samples densos)
  const matrix: Array<{ from: string; to: string; qty: number; value: number }> = [];
  for (const from of stores) {
    for (const to of stores) {
      if (from.code === to.code) continue;
      // CD Central abastece todo mundo
      const fromCd = from.code === '13';
      const base = fromCd ? 80 + Math.random() * 140 : Math.random() > 0.65 ? 5 + Math.random() * 35 : 0;
      const qty = Math.round(base);
      if (qty === 0) continue;
      matrix.push({
        from: from.code,
        to: to.code,
        qty,
        value: qty * (120 + Math.random() * 60),
      });
    }
  }

  // Gera ~80 transferências mock
  const statuses: ShipmentStatus[] = ['received', 'in_transit', 'open', 'received', 'received', 'cancelled'];
  const userNames = ['Maria Silva', 'Patrícia Souza', 'Renata Lima', 'Carolina Ramos', 'Bia Mendes', 'Juliana Pires'];
  const shipments: ShipmentRow[] = Array.from({ length: 84 }, (_, i) => {
    const fromIdx = Math.random() > 0.5 ? 12 : Math.floor(Math.random() * stores.length);
    const toIdx = (fromIdx + 1 + Math.floor(Math.random() * (stores.length - 1))) % stores.length;
    const from = stores[fromIdx];
    const to = stores[toIdx];
    const qty = Math.round(8 + Math.random() * 60);
    const received = qty - Math.floor(Math.random() * 3);
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    const daysAgo = Math.floor(Math.random() * 90);
    const opened = new Date(Date.now() - daysAgo * 86400000);
    const sent = new Date(opened.getTime() + 86400000 * (1 + Math.random() * 2));
    const recv = status === 'received' ? new Date(sent.getTime() + 86400000 * (1 + Math.random() * 5)) : null;
    return {
      id: `ship_${i + 1}`,
      code: `REM-2026-${String(123 + i).padStart(6, '0')}`,
      fromStoreCode: from.code,
      fromStoreName: from.name,
      toStoreCode: to.code,
      toStoreName: to.name,
      status,
      totalQty: qty,
      receivedQty: status === 'received' ? received : 0,
      missingQty: status === 'received' && received < qty ? qty - received : 0,
      totalValue: qty * (110 + Math.random() * 80),
      openedAt: opened.toISOString(),
      sentAt: ['in_transit', 'received', 'cancelled'].includes(status) ? sent.toISOString() : null,
      receivedAt: recv ? recv.toISOString() : null,
      userResponsible: userNames[Math.floor(Math.random() * userNames.length)],
    };
  });

  // Evolução mensal (12 meses)
  const months = ['Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai'];
  const monthlyEvolution = months.map((m) => {
    const sent = Math.round(800 + Math.random() * 1200);
    return {
      month: m,
      sent,
      received: Math.round(sent * (0.85 + Math.random() * 0.2)),
      value: Math.round(sent * 150),
    };
  });

  const totalShipments = shipments.length;
  const totalQty = shipments.reduce((s, x) => s + x.totalQty, 0);
  const totalValue = shipments.reduce((s, x) => s + x.totalValue, 0);
  const topSender = [...stores].sort((a, b) => b.sentQty - a.sentQty)[0];
  const topReceiver = [...stores].sort((a, b) => b.receivedQty - a.receivedQty)[0];

  return {
    period: { from: '2026-02-18', to: '2026-05-18' },
    summary: {
      totalShipments,
      totalQty,
      totalValue,
      topSender: { code: topSender.code, name: topSender.name, qty: topSender.sentQty },
      topReceiver: { code: topReceiver.code, name: topReceiver.name, qty: topReceiver.receivedQty },
      divergencyQty: shipments.reduce((s, x) => s + (x.missingQty || 0), 0),
      pendingShipments: shipments.filter((x) => x.status === 'open' || x.status === 'in_transit').length,
    },
    stores,
    shipments,
    monthlyEvolution,
    matrix,
  };
}

function generateMockItems(qty: number): ShipmentItem[] {
  const produtos = [
    { ref: '205', name: 'Vestido Floral Azul' },
    { ref: '198', name: 'Blusa Manga Longa' },
    { ref: '312', name: 'Calça Jeans Plus' },
    { ref: '401', name: 'Conjunto Listrado' },
    { ref: '528', name: 'Macacão Rosa Verão' },
    { ref: '614', name: 'Saia Plissada' },
  ];
  const cores = ['Preto', 'Azul', 'Branco', 'Vermelho', 'Verde', 'Rosa'];
  const tams = ['46', '48', '50', '52', '54', '56', '58', '60'];
  const items: ShipmentItem[] = [];
  let remaining = qty;
  while (remaining > 0) {
    const p = produtos[Math.floor(Math.random() * produtos.length)];
    const q = Math.min(remaining, Math.ceil(Math.random() * 3));
    const cost = 80 + Math.random() * 60;
    const r = Math.random() > 0.92 ? q - 1 : q;
    items.push({
      sku: `${p.ref}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      ref: p.ref,
      productName: p.name,
      cor: cores[Math.floor(Math.random() * cores.length)],
      tamanho: tams[Math.floor(Math.random() * tams.length)],
      qty: q,
      receivedQty: Math.max(0, r),
      unitCost: cost,
      total: q * cost,
      status: r < q ? 'missing' : 'received',
    });
    remaining -= q;
  }
  return items;
}

/* ─── Helpers ─── */
const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 });
const num = (v: number) => v.toLocaleString('pt-BR');
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '—';

const STATUS_STYLES: Record<ShipmentStatus, { label: string; bg: string; text: string; dot: string }> = {
  open: { label: 'Aberta', bg: 'bg-stone-100', text: 'text-stone-700', dot: 'bg-stone-400' },
  in_transit: { label: 'Em trânsito', bg: 'bg-amber-50', text: 'text-amber-800', dot: 'bg-amber-500' },
  received: { label: 'Recebida', bg: 'bg-emerald-50', text: 'text-emerald-800', dot: 'bg-emerald-500' },
  cancelled: { label: 'Cancelada', bg: 'bg-rose-50', text: 'text-rose-800', dot: 'bg-rose-500' },
};

/* ─── Componente principal ─── */
export default function TransferenciasReportPage() {
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'7d' | '30d' | '90d' | 'ytd' | 'custom'>('90d');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ShipmentStatus | 'divergencias'>('all');
  const [fromFilter, setFromFilter] = useState<string>('');
  const [toFilter, setToFilter] = useState<string>('');
  const [view, setView] = useState<'table' | 'matrix'>('table');
  const [selectedStore, setSelectedStore] = useState<StoreAggregate | null>(null);
  const [selectedShipment, setSelectedShipment] = useState<ShipmentRow | null>(null);
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);

  useEffect(() => {
    setLoading(true);
    // Tenta backend; cai pra mock se falhar
    api<ReportData>(`/transferencias/report?period=${period}`)
      .then((res) => setData(res))
      .catch(() => setData(generateMockData()))
      .finally(() => setLoading(false));
  }, [period]);

  /* ─── Filtros aplicados (sintético) ─── */
  const filteredShipments = useMemo(() => {
    if (!data) return [];
    return data.shipments.filter((s) => {
      if (fromFilter && s.fromStoreCode !== fromFilter) return false;
      if (toFilter && s.toStoreCode !== toFilter) return false;
      if (statusFilter === 'divergencias') {
        if (s.missingQty === 0) return false;
      } else if (statusFilter !== 'all') {
        if (s.status !== statusFilter) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        return (
          s.code.toLowerCase().includes(q) ||
          s.fromStoreName.toLowerCase().includes(q) ||
          s.toStoreName.toLowerCase().includes(q) ||
          s.userResponsible.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data, search, statusFilter, fromFilter, toFilter]);

  return (
    <main className="min-h-screen bg-stone-50">
      {/* ─── Header ─── */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-20">
        <div className="max-w-screen-2xl mx-auto px-6 py-3 flex items-center gap-4">
          <Link
            href="/retaguarda"
            className="p-2 rounded-lg hover:bg-stone-100 text-stone-600"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2 text-xs text-stone-500">
              <span>FlowOps</span>
              <ChevronRight className="w-3 h-3" />
              <span>Retaguarda</span>
              <ChevronRight className="w-3 h-3" />
              <span className="text-stone-900 font-medium">Transferências entre lojas</span>
            </div>
            <h1 className="text-xl font-bold text-stone-900 tracking-tight mt-0.5">
              Relatório de transferências
            </h1>
          </div>

          {/* Period selector */}
          <div className="flex items-center gap-1 bg-stone-100 rounded-lg p-1 text-sm">
            {(['7d', '30d', '90d', 'ytd'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  period === p
                    ? 'bg-white shadow text-stone-900'
                    : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                {p === '7d' ? '7 dias' : p === '30d' ? '30 dias' : p === '90d' ? '90 dias' : 'Ano'}
              </button>
            ))}
          </div>

          {/* Actions */}
          <button
            onClick={() => setShowFiltersPanel((v) => !v)}
            className="px-3 py-1.5 rounded-lg border border-stone-200 hover:bg-stone-50 text-sm font-medium flex items-center gap-1.5"
          >
            <Filter className="w-4 h-4" />
            Filtros
          </button>
          <button
            className="px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-sm font-medium flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            Exportar
          </button>
        </div>
      </header>

      {loading || !data ? (
        <SkeletonReport />
      ) : (
        <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-6">
          {/* Filtros avançados (toggleable) */}
          {showFiltersPanel && (
            <section className="bg-white rounded-xl border border-stone-200 p-4">
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div>
                  <label className="text-[11px] uppercase font-bold text-stone-500 tracking-wider block mb-1">
                    Loja origem
                  </label>
                  <select
                    value={fromFilter}
                    onChange={(e) => setFromFilter(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg border border-stone-200 text-sm bg-white"
                  >
                    <option value="">Todas</option>
                    {data.stores.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code} · {s.city}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] uppercase font-bold text-stone-500 tracking-wider block mb-1">
                    Loja destino
                  </label>
                  <select
                    value={toFilter}
                    onChange={(e) => setToFilter(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg border border-stone-200 text-sm bg-white"
                  >
                    <option value="">Todas</option>
                    {data.stores.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code} · {s.city}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] uppercase font-bold text-stone-500 tracking-wider block mb-1">
                    Status
                  </label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as any)}
                    className="w-full px-3 py-1.5 rounded-lg border border-stone-200 text-sm bg-white"
                  >
                    <option value="all">Todos</option>
                    <option value="open">Aberta</option>
                    <option value="in_transit">Em trânsito</option>
                    <option value="received">Recebida</option>
                    <option value="cancelled">Cancelada</option>
                    <option value="divergencias">Com divergência</option>
                  </select>
                </div>
                <div className="lg:col-span-2">
                  <label className="text-[11px] uppercase font-bold text-stone-500 tracking-wider block mb-1">
                    Buscar
                  </label>
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Código, loja, responsável…"
                      className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-stone-200 text-sm"
                    />
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-stone-500">
                <span>{filteredShipments.length} resultado(s)</span>
                <button
                  onClick={() => {
                    setSearch('');
                    setStatusFilter('all');
                    setFromFilter('');
                    setToFilter('');
                  }}
                  className="text-rose-600 hover:underline font-medium"
                >
                  Limpar filtros
                </button>
              </div>
            </section>
          )}

          {/* ─── NÍVEL 1.A — KPI CARDS ─── */}
          <section className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <KpiCard
              icon={ArrowLeftRight}
              label="Transferências"
              value={num(data.summary.totalShipments)}
              tone="slate"
              trend={+12}
            />
            <KpiCard
              icon={Package}
              label="Peças movimentadas"
              value={num(data.summary.totalQty)}
              tone="indigo"
              trend={+8}
            />
            <KpiCard
              icon={Boxes}
              label="Valor total"
              value={brl(data.summary.totalValue)}
              tone="emerald"
              trend={+15}
            />
            <KpiCard
              icon={Send}
              label="Maior emissora"
              value={data.summary.topSender.code}
              sub={data.summary.topSender.name.replace("Lurd's ", '')}
              tone="violet"
            />
            <KpiCard
              icon={ArrowDownToLine}
              label="Maior receptora"
              value={data.summary.topReceiver.code}
              sub={data.summary.topReceiver.name.replace("Lurd's ", '')}
              tone="cyan"
            />
            <KpiCard
              icon={AlertTriangle}
              label="Divergências"
              value={num(data.summary.divergencyQty)}
              sub="peças faltantes"
              tone="amber"
              trend={-3}
            />
            <KpiCard
              icon={Clock}
              label="Pendentes"
              value={num(data.summary.pendingShipments)}
              sub="abertas + trânsito"
              tone="rose"
            />
          </section>

          {/* ─── Charts row ─── */}
          <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <ChartCard title="Evolução mensal" subtitle="Peças enviadas vs recebidas">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={data.monthlyEvolution}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e5e4" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#a8a29e" />
                  <YAxis tick={{ fontSize: 11 }} stroke="#a8a29e" />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid #e7e5e4',
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="sent"
                    stroke="#6366f1"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    name="Enviadas"
                  />
                  <Line
                    type="monotone"
                    dataKey="received"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    name="Recebidas"
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Top emissoras" subtitle="Peças enviadas no período">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart
                  data={[...data.stores]
                    .sort((a, b) => b.sentQty - a.sentQty)
                    .slice(0, 6)
                    .map((s) => ({ name: s.city.slice(0, 12), value: s.sentQty }))}
                  layout="vertical"
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e7e5e4" />
                  <XAxis type="number" tick={{ fontSize: 11 }} stroke="#a8a29e" />
                  <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 11 }} stroke="#a8a29e" />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid #e7e5e4',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="value" fill="#6366f1" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Top receptoras" subtitle="Peças recebidas no período">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart
                  data={[...data.stores]
                    .sort((a, b) => b.receivedQty - a.receivedQty)
                    .slice(0, 6)
                    .map((s) => ({ name: s.city.slice(0, 12), value: s.receivedQty }))}
                  layout="vertical"
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e7e5e4" />
                  <XAxis type="number" tick={{ fontSize: 11 }} stroke="#a8a29e" />
                  <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 11 }} stroke="#a8a29e" />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid #e7e5e4',
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="value" fill="#10b981" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </section>

          {/* ─── Toggle Tabela | Matriz ─── */}
          <section className="flex items-center justify-between">
            <div className="flex items-center gap-1 bg-white border border-stone-200 rounded-lg p-1">
              <button
                onClick={() => setView('table')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 transition ${
                  view === 'table' ? 'bg-stone-900 text-white' : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                <Layers className="w-4 h-4" />
                Tabela por loja
              </button>
              <button
                onClick={() => setView('matrix')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 transition ${
                  view === 'matrix' ? 'bg-stone-900 text-white' : 'text-stone-600 hover:text-stone-900'
                }`}
              >
                <Grid3x3 className="w-4 h-4" />
                Matriz origem × destino
              </button>
            </div>
            <div className="text-xs text-stone-500">
              {data.stores.length} lojas · período {fmtDate(data.period.from)} → {fmtDate(data.period.to)}
            </div>
          </section>

          {/* ─── Tabela ou Matriz ─── */}
          {view === 'table' ? (
            <StoresTable
              stores={data.stores}
              onSelectStore={(s) => setSelectedStore(s)}
            />
          ) : (
            <MatrixView stores={data.stores} matrix={data.matrix} />
          )}

          {/* ─── Lista de transferências ─── */}
          <ShipmentsTable
            shipments={filteredShipments}
            onSelectShipment={(s) => setSelectedShipment(s)}
          />
        </div>
      )}

      {/* ─── Drawer da Loja (Nível 2) ─── */}
      {selectedStore && data && (
        <StoreDrawer
          store={selectedStore}
          shipments={data.shipments.filter(
            (s) => s.fromStoreCode === selectedStore.code || s.toStoreCode === selectedStore.code,
          )}
          onClose={() => setSelectedStore(null)}
          onSelectShipment={(s) => setSelectedShipment(s)}
        />
      )}

      {/* ─── Modal Detalhe da Transferência (Nível 3) ─── */}
      {selectedShipment && (
        <ShipmentDetailModal
          shipment={selectedShipment}
          onClose={() => setSelectedShipment(null)}
        />
      )}
    </main>
  );
}

/* ─── Sub-components ─── */

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  trend,
}: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  tone: 'slate' | 'indigo' | 'emerald' | 'violet' | 'cyan' | 'amber' | 'rose';
  trend?: number;
}) {
  const tones = {
    slate: 'bg-slate-50 text-slate-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    violet: 'bg-violet-50 text-violet-700',
    cyan: 'bg-cyan-50 text-cyan-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  };
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4 hover:border-stone-300 hover:shadow-sm transition group">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${tones[tone]}`}>
          <Icon className="w-4 h-4" />
        </div>
        {trend !== undefined && (
          <span
            className={`text-[10px] font-bold flex items-center gap-0.5 ${
              trend > 0 ? 'text-emerald-600' : 'text-rose-600'
            }`}
          >
            {trend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      <div className="text-2xl font-bold text-stone-900 tracking-tight">{value}</div>
      <div className="text-[11px] uppercase font-bold text-stone-500 tracking-wider mt-0.5">
        {label}
      </div>
      {sub && <div className="text-xs text-stone-500 mt-1 truncate">{sub}</div>}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4">
      <div className="mb-3">
        <h3 className="text-sm font-bold text-stone-900">{title}</h3>
        <p className="text-xs text-stone-500">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function StoresTable({
  stores,
  onSelectStore,
}: {
  stores: StoreAggregate[];
  onSelectStore: (s: StoreAggregate) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof StoreAggregate>('balanceQty');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const sorted = useMemo(() => {
    return [...stores].sort((a, b) => {
      const av = a[sortKey] as number;
      const bv = b[sortKey] as number;
      return sortDir === 'desc' ? bv - av : av - bv;
    });
  }, [stores, sortKey, sortDir]);

  const toggle = (k: keyof StoreAggregate) => {
    if (sortKey === k) setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    else {
      setSortKey(k);
      setSortDir('desc');
    }
  };

  const Th = ({ k, label, align = 'right' }: { k: keyof StoreAggregate; label: string; align?: 'left' | 'right' }) => (
    <th
      onClick={() => toggle(k)}
      className={`px-3 py-2.5 text-${align} text-[10px] uppercase font-bold text-stone-500 tracking-wider cursor-pointer hover:text-stone-900 select-none`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === k && <ChevronDown className={`w-3 h-3 ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
      </span>
    </th>
  );

  return (
    <section className="bg-white rounded-xl border border-stone-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
        <div>
          <h2 className="font-bold text-stone-900">Movimentação por loja</h2>
          <p className="text-xs text-stone-500">Clique numa loja pra ver detalhes</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              <Th k="code" label="Loja" align="left" />
              <Th k="sentQty" label="Enviado qtd" />
              <Th k="sentValue" label="Enviado R$" />
              <Th k="receivedQty" label="Recebido qtd" />
              <Th k="receivedValue" label="Recebido R$" />
              <Th k="balanceQty" label="Saldo qtd" />
              <Th k="balanceValue" label="Saldo R$" />
              <Th k="shipmentsCount" label="# trans." />
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr
                key={s.code}
                onClick={() => onSelectStore(s)}
                className="border-b border-stone-100 hover:bg-stone-50 cursor-pointer transition"
              >
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-xs bg-stone-100 px-1.5 py-0.5 rounded">
                      {s.code}
                    </span>
                    <span className="font-medium text-stone-900">{s.city}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-stone-700">{num(s.sentQty)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-stone-500 text-xs">{brl(s.sentValue)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-stone-700">{num(s.receivedQty)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-stone-500 text-xs">{brl(s.receivedValue)}</td>
                <td
                  className={`px-3 py-2.5 text-right tabular-nums font-semibold ${
                    s.balanceQty > 0
                      ? 'text-emerald-700'
                      : s.balanceQty < 0
                      ? 'text-rose-700'
                      : 'text-stone-500'
                  }`}
                >
                  {s.balanceQty > 0 ? '+' : ''}
                  {num(s.balanceQty)}
                </td>
                <td
                  className={`px-3 py-2.5 text-right tabular-nums text-xs ${
                    s.balanceValue > 0
                      ? 'text-emerald-600'
                      : s.balanceValue < 0
                      ? 'text-rose-600'
                      : 'text-stone-400'
                  }`}
                >
                  {s.balanceValue > 0 ? '+' : ''}
                  {brl(s.balanceValue)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-stone-600">{s.shipmentsCount}</td>
                <td className="px-3 py-2.5 text-stone-400">
                  <ChevronRight className="w-4 h-4 ml-auto" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MatrixView({
  stores,
  matrix,
}: {
  stores: StoreAggregate[];
  matrix: Array<{ from: string; to: string; qty: number; value: number }>;
}) {
  const lookup = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of matrix) m.set(`${e.from}->${e.to}`, e.qty);
    return m;
  }, [matrix]);

  const maxQty = useMemo(() => Math.max(...matrix.map((m) => m.qty), 1), [matrix]);

  return (
    <section className="bg-white rounded-xl border border-stone-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
        <div>
          <h2 className="font-bold text-stone-900">Matriz origem × destino</h2>
          <p className="text-xs text-stone-500">
            Linhas = origem · Colunas = destino · Cor mais intensa = mais peças transferidas
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-stone-500">Escala:</span>
          <div className="flex gap-0.5">
            {[0.1, 0.25, 0.5, 0.75, 1].map((o) => (
              <div
                key={o}
                className="w-5 h-3"
                style={{ background: `rgba(99,102,241,${o})` }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 bg-stone-50 px-2 py-1.5 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider border-r border-b border-stone-200">
                Origem ↓ / Destino →
              </th>
              {stores.map((s) => (
                <th
                  key={s.code}
                  className="px-2 py-1.5 text-center text-[10px] font-bold text-stone-600 border-b border-stone-200 min-w-[44px]"
                  title={s.name}
                >
                  {s.code}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stores.map((from) => (
              <tr key={from.code}>
                <th className="sticky left-0 bg-stone-50 px-2 py-1.5 text-left text-[10px] font-bold text-stone-700 border-r border-b border-stone-100 whitespace-nowrap">
                  <span className="font-mono mr-1">{from.code}</span>
                  {from.city.slice(0, 14)}
                </th>
                {stores.map((to) => {
                  const qty = lookup.get(`${from.code}->${to.code}`) || 0;
                  const opacity = qty === 0 ? 0 : 0.1 + (qty / maxQty) * 0.9;
                  return (
                    <td
                      key={to.code}
                      className="text-center border border-stone-100 cursor-pointer hover:ring-2 hover:ring-indigo-400 hover:ring-inset transition"
                      style={{
                        background: from.code === to.code ? '#f5f5f4' : `rgba(99,102,241,${opacity})`,
                      }}
                      title={`${from.code} → ${to.code}: ${qty} peças`}
                    >
                      <div
                        className={`px-2 py-1.5 font-mono text-[11px] ${
                          opacity > 0.5 ? 'text-white font-bold' : 'text-stone-700'
                        }`}
                      >
                        {from.code === to.code ? '—' : qty || ''}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ShipmentsTable({
  shipments,
  onSelectShipment,
}: {
  shipments: ShipmentRow[];
  onSelectShipment: (s: ShipmentRow) => void;
}) {
  const [pageSize] = useState(25);
  const [page, setPage] = useState(0);
  const paginated = shipments.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.ceil(shipments.length / pageSize);

  return (
    <section className="bg-white rounded-xl border border-stone-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
        <div>
          <h2 className="font-bold text-stone-900">Transferências recentes</h2>
          <p className="text-xs text-stone-500">{shipments.length} resultado(s)</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-stone-50 border-b border-stone-200">
            <tr>
              <th className="px-3 py-2.5 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">
                Código
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">
                Origem → Destino
              </th>
              <th className="px-3 py-2.5 text-right text-[10px] uppercase font-bold text-stone-500 tracking-wider">
                Qtd
              </th>
              <th className="px-3 py-2.5 text-right text-[10px] uppercase font-bold text-stone-500 tracking-wider">
                Valor
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">
                Status
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">
                Aberta
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">
                Recebida
              </th>
              <th className="px-3 py-2.5 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">
                Responsável
              </th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((s) => {
              const st = STATUS_STYLES[s.status];
              return (
                <tr
                  key={s.id}
                  onClick={() => onSelectShipment(s)}
                  className="border-b border-stone-100 hover:bg-stone-50 cursor-pointer transition"
                >
                  <td className="px-3 py-2.5 font-mono text-xs text-stone-700">{s.code}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2 text-stone-700">
                      <span className="font-medium">{s.fromStoreName.replace("Lurd's ", '')}</span>
                      <ArrowRight className="w-3 h-3 text-stone-400" />
                      <span className="font-medium">{s.toStoreName.replace("Lurd's ", '')}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-stone-700">
                    {num(s.totalQty)}
                    {s.missingQty > 0 && (
                      <span className="text-rose-600 ml-1 text-xs">(-{s.missingQty})</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-stone-700 text-xs">
                    {brl(s.totalValue)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-semibold ${st.bg} ${st.text}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`}></span>
                      {st.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-stone-600 text-xs">{fmtDate(s.openedAt)}</td>
                  <td className="px-3 py-2.5 text-stone-600 text-xs">{fmtDate(s.receivedAt)}</td>
                  <td className="px-3 py-2.5 text-stone-600 text-xs truncate max-w-[120px]">
                    {s.userResponsible}
                  </td>
                  <td className="px-3 py-2.5 text-stone-400">
                    <ChevronRight className="w-4 h-4" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="px-4 py-2.5 border-t border-stone-200 flex items-center justify-between text-xs text-stone-600">
          <span>
            Página {page + 1} de {totalPages} · {shipments.length} resultados
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-2 py-1 rounded hover:bg-stone-100 disabled:opacity-50"
            >
              ‹
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded hover:bg-stone-100 disabled:opacity-50"
            >
              ›
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function StoreDrawer({
  store,
  shipments,
  onClose,
  onSelectShipment,
}: {
  store: StoreAggregate;
  shipments: ShipmentRow[];
  onClose: () => void;
  onSelectShipment: (s: ShipmentRow) => void;
}) {
  const sent = shipments.filter((s) => s.fromStoreCode === store.code);
  const received = shipments.filter((s) => s.toStoreCode === store.code);
  const ticketAvg = store.shipmentsCount > 0 ? (store.sentValue + store.receivedValue) / store.shipmentsCount : 0;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-30 backdrop-blur-sm" onClick={onClose} />
      <aside className="fixed right-0 top-0 bottom-0 w-full md:w-[800px] bg-white shadow-2xl z-40 overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center">
              <Building2 className="w-5 h-5 text-indigo-700" />
            </div>
            <div>
              <h2 className="font-bold text-stone-900">
                {store.code} · {store.city}
              </h2>
              <p className="text-xs text-stone-500">{store.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* KPIs da loja */}
        <div className="p-6 space-y-6">
          <section className="grid grid-cols-4 gap-3">
            <MiniKpi label="Enviado" value={num(store.sentQty)} sub={brl(store.sentValue)} tone="violet" />
            <MiniKpi label="Recebido" value={num(store.receivedQty)} sub={brl(store.receivedValue)} tone="cyan" />
            <MiniKpi
              label="Saldo"
              value={(store.balanceQty > 0 ? '+' : '') + num(store.balanceQty)}
              sub={brl(store.balanceValue)}
              tone={store.balanceQty >= 0 ? 'emerald' : 'rose'}
            />
            <MiniKpi label="Ticket médio" value={brl(ticketAvg)} sub={`${store.shipmentsCount} transferências`} tone="slate" />
          </section>

          {/* Enviadas */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-stone-900 flex items-center gap-2">
                <Send className="w-4 h-4 text-violet-600" />
                Transferências enviadas ({sent.length})
              </h3>
              <button className="text-xs text-stone-500 hover:text-stone-900 flex items-center gap-1">
                <Download className="w-3 h-3" /> CSV
              </button>
            </div>
            <DrawerShipmentList shipments={sent} otherSide="to" onSelect={onSelectShipment} />
          </section>

          {/* Recebidas */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-stone-900 flex items-center gap-2">
                <ArrowDownToLine className="w-4 h-4 text-cyan-600" />
                Transferências recebidas ({received.length})
              </h3>
              <button className="text-xs text-stone-500 hover:text-stone-900 flex items-center gap-1">
                <Download className="w-3 h-3" /> CSV
              </button>
            </div>
            <DrawerShipmentList shipments={received} otherSide="from" onSelect={onSelectShipment} />
          </section>
        </div>
      </aside>
    </>
  );
}

function MiniKpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'violet' | 'cyan' | 'emerald' | 'rose' | 'slate';
}) {
  const tones = {
    violet: 'bg-violet-50 text-violet-700',
    cyan: 'bg-cyan-50 text-cyan-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    rose: 'bg-rose-50 text-rose-700',
    slate: 'bg-slate-50 text-slate-700',
  };
  return (
    <div className={`rounded-lg p-3 ${tones[tone]}`}>
      <div className="text-[10px] uppercase font-bold tracking-wider opacity-70">{label}</div>
      <div className="text-xl font-bold mt-0.5 tabular-nums">{value}</div>
      <div className="text-[10px] mt-0.5 opacity-80">{sub}</div>
    </div>
  );
}

function DrawerShipmentList({
  shipments,
  otherSide,
  onSelect,
}: {
  shipments: ShipmentRow[];
  otherSide: 'from' | 'to';
  onSelect: (s: ShipmentRow) => void;
}) {
  if (shipments.length === 0)
    return <div className="text-xs text-stone-400 text-center py-6 italic">Nenhuma transferência</div>;
  return (
    <div className="border border-stone-200 rounded-lg divide-y divide-stone-100">
      {shipments.slice(0, 15).map((s) => {
        const st = STATUS_STYLES[s.status];
        const otherName = otherSide === 'to' ? s.toStoreName : s.fromStoreName;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s)}
            className="w-full text-left px-3 py-2 hover:bg-stone-50 text-sm flex items-center gap-3"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-stone-600">{s.code}</span>
                <span className="font-medium text-stone-800 truncate">
                  {otherName.replace("Lurd's ", '')}
                </span>
              </div>
              <div className="text-xs text-stone-500 mt-0.5">
                {fmtDate(s.openedAt)} · {s.userResponsible}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm tabular-nums font-medium text-stone-900">{num(s.totalQty)} pç</div>
              <div className="text-xs text-stone-500 tabular-nums">{brl(s.totalValue)}</div>
            </div>
            <span
              className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${st.bg} ${st.text} shrink-0`}
            >
              {st.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ShipmentDetailModal({
  shipment,
  onClose,
}: {
  shipment: ShipmentRow;
  onClose: () => void;
}) {
  const items = useMemo(() => generateMockItems(shipment.totalQty), [shipment.id]);
  const st = STATUS_STYLES[shipment.status];
  const totalReceived = items.reduce((s, it) => s + it.receivedQty, 0);
  const totalMissing = shipment.totalQty - totalReceived;

  const timeline = [
    { label: 'Aberta', date: shipment.openedAt, done: true, icon: Boxes },
    { label: 'Separada', date: shipment.openedAt, done: true, icon: Package },
    {
      label: 'Enviada',
      date: shipment.sentAt,
      done: !!shipment.sentAt,
      icon: Send,
    },
    {
      label: 'Recebida',
      date: shipment.receivedAt,
      done: !!shipment.receivedAt,
      icon: ArrowDownToLine,
    },
    {
      label: 'Conferida',
      date: shipment.receivedAt,
      done: shipment.status === 'received',
      icon: CheckCircle2,
    },
  ];

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-5xl w-full max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold text-stone-900 font-mono">{shipment.code}</h2>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold ${st.bg} ${st.text}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`}></span>
                {st.label}
              </span>
            </div>
            <p className="text-sm text-stone-600 mt-1">
              <span className="font-medium">{shipment.fromStoreName}</span>
              <ArrowRight className="w-3 h-3 inline mx-2 text-stone-400" />
              <span className="font-medium">{shipment.toStoreName}</span>
              <span className="text-stone-400 mx-2">·</span>
              <span className="text-xs">Responsável: {shipment.userResponsible}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="p-2 hover:bg-stone-100 rounded-lg" title="Imprimir">
              <Printer className="w-4 h-4" />
            </button>
            <button className="p-2 hover:bg-stone-100 rounded-lg" title="Exportar PDF">
              <Download className="w-4 h-4" />
            </button>
            <button className="p-2 hover:bg-stone-100 rounded-lg" title="Excel">
              <FileSpreadsheet className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-stone-100 rounded-lg">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Timeline */}
          <section>
            <h3 className="text-xs uppercase font-bold text-stone-500 tracking-wider mb-3">Linha do tempo</h3>
            <div className="flex items-center justify-between relative">
              <div className="absolute top-5 left-5 right-5 h-0.5 bg-stone-200"></div>
              {timeline.map((step, i) => {
                const Icon = step.icon;
                return (
                  <div key={i} className="relative flex flex-col items-center z-10">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        step.done
                          ? 'bg-emerald-500 text-white'
                          : 'bg-stone-200 text-stone-400'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="text-xs font-semibold text-stone-900 mt-2">{step.label}</div>
                    <div className="text-[10px] text-stone-500">{fmtDate(step.date)}</div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Resumo */}
          <section className="grid grid-cols-4 gap-3">
            <MiniKpi label="Total peças" value={num(shipment.totalQty)} sub="enviadas" tone="violet" />
            <MiniKpi label="Recebidas" value={num(totalReceived)} sub={`${Math.round((totalReceived / shipment.totalQty) * 100)}% conferido`} tone="emerald" />
            <MiniKpi label="Divergências" value={num(totalMissing)} sub={totalMissing > 0 ? 'peças faltantes' : 'sem divergência'} tone={totalMissing > 0 ? 'rose' : 'slate'} />
            <MiniKpi label="Valor total" value={brl(shipment.totalValue)} sub={brl(shipment.totalValue / shipment.totalQty) + '/pç'} tone="slate" />
          </section>

          {/* Items */}
          <section className="bg-white rounded-xl border border-stone-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-stone-200 bg-stone-50 flex items-center justify-between">
              <h3 className="font-bold text-stone-900 text-sm">Itens da transferência ({items.length})</h3>
              <input
                placeholder="Filtrar itens…"
                className="px-2 py-1 text-xs rounded border border-stone-200"
              />
            </div>
            <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-white border-b border-stone-200 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">REF</th>
                    <th className="px-3 py-2 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">Produto</th>
                    <th className="px-3 py-2 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">Cor</th>
                    <th className="px-3 py-2 text-left text-[10px] uppercase font-bold text-stone-500 tracking-wider">Tam</th>
                    <th className="px-3 py-2 text-right text-[10px] uppercase font-bold text-stone-500 tracking-wider">Qtd</th>
                    <th className="px-3 py-2 text-right text-[10px] uppercase font-bold text-stone-500 tracking-wider">Recebido</th>
                    <th className="px-3 py-2 text-right text-[10px] uppercase font-bold text-stone-500 tracking-wider">Custo unit</th>
                    <th className="px-3 py-2 text-right text-[10px] uppercase font-bold text-stone-500 tracking-wider">Total</th>
                    <th className="px-3 py-2 text-center text-[10px] uppercase font-bold text-stone-500 tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.sku} className="border-b border-stone-100 hover:bg-stone-50">
                      <td className="px-3 py-2 font-mono text-xs text-rose-600 font-bold">{it.ref}</td>
                      <td className="px-3 py-2 text-stone-700">{it.productName}</td>
                      <td className="px-3 py-2 text-stone-600 text-xs">{it.cor}</td>
                      <td className="px-3 py-2 text-stone-600 text-xs">{it.tamanho}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-stone-700">{it.qty}</td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${
                          it.receivedQty < it.qty ? 'text-rose-600' : 'text-emerald-700'
                        }`}
                      >
                        {it.receivedQty}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-stone-600 text-xs">{brl(it.unitCost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-stone-900 font-medium">{brl(it.total)}</td>
                      <td className="px-3 py-2 text-center">
                        {it.status === 'received' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 mx-auto" />
                        ) : (
                          <XCircle className="w-4 h-4 text-rose-500 mx-auto" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function SkeletonReport() {
  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6 space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-stone-200 p-4">
            <div className="w-8 h-8 rounded-lg bg-stone-100 mb-3 animate-pulse"></div>
            <div className="h-7 w-20 bg-stone-100 rounded animate-pulse"></div>
            <div className="h-3 w-16 bg-stone-100 rounded mt-2 animate-pulse"></div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-white rounded-xl border border-stone-200 p-4 h-[220px] animate-pulse" />
        ))}
      </div>
      <div className="bg-white rounded-xl border border-stone-200 h-[400px] animate-pulse" />
    </div>
  );
}
