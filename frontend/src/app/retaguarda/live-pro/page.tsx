'use client';

/**
 * /retaguarda/live-pro — Painel Mestre de Live Commerce (versão Pro)
 *
 * Painel completo pra operação da live:
 *  • Produtos (lista + drawer detalhe com reservas em tempo real)
 *  • Comentários ao vivo (filtro intent: compra / pergunta / outro)
 *  • Métricas: comentários/min, reservas/min, conversão, GMV potencial
 *  • Toggle Lú IA durante a live
 *  • Iniciar/Encerrar live com resumo final
 *  • Lista de reservas com status: PENDING / CONFIRMED / EXPIRED
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  Radio,
  Play,
  Pause,
  Sparkles,
  ShoppingBag,
  MessageCircle,
  TrendingUp,
  X,
  Plus,
  CheckCircle2,
  XCircle,
  Clock,
  Users,
} from 'lucide-react';
import { api } from '@/lib/api';

interface Product {
  id: string;
  ref: string;
  name: string;
  price: number;
  stock: number;
  reservedCount: number;
  image?: string;
}

interface Reservation {
  id: string;
  productRef: string;
  productName: string;
  customerName: string;
  customerIg: string;
  size?: string;
  quantity: number;
  status: 'PENDING' | 'CONFIRMED' | 'EXPIRED';
  createdAt: string;
  ttlMinutes: number;
}

interface LiveComment {
  id: string;
  customerName: string;
  customerIg: string;
  text: string;
  intent: 'purchase' | 'question' | 'other';
  productRef?: string;
  luReplied: boolean;
  createdAt: string;
}

interface LiveMetrics {
  startedAt: string;
  durationMin: number;
  viewers: number;
  commentsCount: number;
  commentsPerMin: number;
  reservationsCount: number;
  gmvPotential: number;
  conversionRate: number;
}

/* ─── Mock data (até endpoints estarem prontos) ─── */
const MOCK_PRODUCTS: Product[] = [
  { id: '1', ref: '205', name: 'Vestido Azul Floral', price: 189.9, stock: 12, reservedCount: 5 },
  { id: '2', ref: '198', name: 'Blusa Verde Manga Longa', price: 119.9, stock: 8, reservedCount: 3 },
  { id: '3', ref: '312', name: 'Calça Jeans Plus', price: 159.9, stock: 18, reservedCount: 9 },
  { id: '4', ref: '401', name: 'Conjunto Listrado P&B', price: 249.9, stock: 6, reservedCount: 2 },
  { id: '5', ref: '528', name: 'Macacão Rosa Verão', price: 199.9, stock: 14, reservedCount: 7 },
];

const MOCK_RESERVATIONS: Reservation[] = [
  { id: '1', productRef: '205', productName: 'Vestido Azul Floral', customerName: 'Patrícia Souza', customerIg: '@paty_souza', size: 'P', quantity: 1, status: 'CONFIRMED', createdAt: '15 min', ttlMinutes: 60 },
  { id: '2', productRef: '205', productName: 'Vestido Azul Floral', customerName: 'Renata Lima', customerIg: '@re.lima', size: 'M', quantity: 1, status: 'PENDING', createdAt: '12 min', ttlMinutes: 60 },
  { id: '3', productRef: '312', productName: 'Calça Jeans Plus', customerName: 'Ana Costa', customerIg: '@anacosta_oficial', size: '46', quantity: 1, status: 'CONFIRMED', createdAt: '10 min', ttlMinutes: 60 },
  { id: '4', productRef: '198', productName: 'Blusa Verde Manga Longa', customerName: 'Carolina Ramos', customerIg: '@caroramos', size: 'G', quantity: 1, status: 'PENDING', createdAt: '8 min', ttlMinutes: 60 },
  { id: '5', productRef: '528', productName: 'Macacão Rosa Verão', customerName: 'Juliana Pires', customerIg: '@ju.pires', size: 'M', quantity: 1, status: 'EXPIRED', createdAt: '52 min', ttlMinutes: 60 },
];

const MOCK_COMMENTS: LiveComment[] = [
  { id: '1', customerName: 'Patrícia Souza', customerIg: '@paty_souza', text: '205 P', intent: 'purchase', productRef: '205', luReplied: true, createdAt: '15 min' },
  { id: '2', customerName: 'Renata Lima', customerIg: '@re.lima', text: 'quero o 205 tamanho M', intent: 'purchase', productRef: '205', luReplied: true, createdAt: '12 min' },
  { id: '3', customerName: 'Mariana Vieira', customerIg: '@mari.vieira', text: 'qual o preço da blusa verde?', intent: 'question', productRef: '198', luReplied: true, createdAt: '11 min' },
  { id: '4', customerName: 'Ana Costa', customerIg: '@anacosta_oficial', text: '312 jeans 46 por favor', intent: 'purchase', productRef: '312', luReplied: true, createdAt: '10 min' },
  { id: '5', customerName: 'Bia Mendes', customerIg: '@bia.m', text: 'adorei!! 😍', intent: 'other', luReplied: false, createdAt: '9 min' },
  { id: '6', customerName: 'Carolina Ramos', customerIg: '@caroramos', text: '198 verde G', intent: 'purchase', productRef: '198', luReplied: true, createdAt: '8 min' },
  { id: '7', customerName: 'Fernanda Reis', customerIg: '@fe.reis', text: 'tem em P o vestido azul?', intent: 'question', productRef: '205', luReplied: true, createdAt: '7 min' },
];

export default function LiveProPage() {
  const [products, setProducts] = useState<Product[]>(MOCK_PRODUCTS);
  const [reservations, setReservations] = useState<Reservation[]>(MOCK_RESERVATIONS);
  const [comments, setComments] = useState<LiveComment[]>(MOCK_COMMENTS);
  const [liveActive, setLiveActive] = useState(true);
  const [luEnabled, setLuEnabled] = useState(true);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [commentFilter, setCommentFilter] = useState<'all' | 'purchase' | 'question'>('all');
  const [endLiveSummary, setEndLiveSummary] = useState<LiveMetrics | null>(null);

  const metrics: LiveMetrics = {
    startedAt: 'hoje 21:30',
    durationMin: 47,
    viewers: 312,
    commentsCount: comments.length * 18,
    commentsPerMin: 6.4,
    reservationsCount: reservations.length,
    gmvPotential: reservations
      .filter((r) => r.status !== 'EXPIRED')
      .reduce((sum, r) => {
        const p = products.find((p) => p.ref === r.productRef);
        return sum + (p?.price || 0) * r.quantity;
      }, 0),
    conversionRate: comments.length
      ? (reservations.length / comments.filter((c) => c.intent === 'purchase').length) * 100
      : 0,
  };

  const fmtCurrency = (v: number) =>
    v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const handleEndLive = () => {
    setEndLiveSummary(metrics);
    setLiveActive(false);
  };

  const filteredComments =
    commentFilter === 'all'
      ? comments
      : comments.filter((c) => c.intent === commentFilter);

  return (
    <main className="min-h-screen bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <Link
            href="/retaguarda/instagram-hub"
            className="p-2 rounded-lg hover:bg-stone-100 text-stone-600"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-xs text-stone-500">FlowOps · Live Commerce Pro</div>
            <h1 className="text-lg font-bold text-stone-900 flex items-center gap-2">
              <Radio className={`w-5 h-5 ${liveActive ? 'text-red-500 animate-pulse' : 'text-stone-400'}`} />
              {liveActive ? 'AO VIVO · @lurdsplussize' : 'Sem live ativa'}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Toggle Lú IA */}
          <button
            onClick={() => setLuEnabled(!luEnabled)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium ${
              luEnabled
                ? 'bg-rose-100 text-rose-700'
                : 'bg-stone-100 text-stone-500'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            Lú IA: {luEnabled ? 'Ativa' : 'Pausada'}
          </button>

          {/* Start/End */}
          {liveActive ? (
            <button
              onClick={handleEndLive}
              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-bold"
            >
              ⏹ Encerrar live
            </button>
          ) : (
            <button
              onClick={() => setLiveActive(true)}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold flex items-center gap-2"
            >
              <Play className="w-4 h-4" /> Iniciar live
            </button>
          )}
        </div>
      </header>

      <div className="max-w-screen-2xl mx-auto p-4 grid grid-cols-12 gap-4">
        {/* ─── COLUNA ESQUERDA: Métricas + Produtos ─── */}
        <div className="col-span-5 space-y-4">
          {/* Métricas */}
          <div className="grid grid-cols-2 gap-3">
            <MetricCard icon={Users} label="Espectadores" value={metrics.viewers.toString()} tone="rose" />
            <MetricCard icon={Clock} label="Duração" value={`${metrics.durationMin} min`} tone="pink" />
            <MetricCard
              icon={MessageCircle}
              label="Coment/min"
              value={metrics.commentsPerMin.toFixed(1)}
              tone="fuchsia"
            />
            <MetricCard
              icon={ShoppingBag}
              label="Reservas"
              value={metrics.reservationsCount.toString()}
              tone="amber"
            />
          </div>

          {/* GMV potencial */}
          <div className="bg-gradient-to-r from-emerald-500 to-teal-600 text-white rounded-2xl p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase opacity-80 tracking-wider">GMV Potencial</div>
                <div className="text-3xl font-bold mt-1">{fmtCurrency(metrics.gmvPotential)}</div>
                <div className="text-xs opacity-80 mt-1">
                  Se todas reservas confirmarem · taxa: {metrics.conversionRate.toFixed(1)}%
                </div>
              </div>
              <TrendingUp className="w-12 h-12 opacity-30" />
            </div>
          </div>

          {/* Produtos */}
          <div className="bg-white rounded-2xl shadow p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold text-stone-900">Produtos da Live ({products.length})</h2>
              <button className="text-xs text-rose-600 hover:underline font-medium flex items-center gap-1">
                <Plus className="w-3 h-3" /> Adicionar
              </button>
            </div>
            <div className="space-y-2 max-h-[500px] overflow-y-auto">
              {products.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedProduct(p)}
                  className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-stone-50 border border-stone-100 text-left"
                >
                  <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-rose-100 to-pink-100 flex items-center justify-center text-rose-600 font-bold text-sm">
                    #{p.ref}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-stone-900 truncate">{p.name}</div>
                    <div className="text-xs text-stone-500">
                      {fmtCurrency(p.price)} · Estoque: {p.stock} · Reservados: {p.reservedCount}
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`text-xs font-bold px-2 py-1 rounded ${
                        p.stock - p.reservedCount <= 2
                          ? 'bg-red-100 text-red-700'
                          : p.stock - p.reservedCount <= 5
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-emerald-100 text-emerald-700'
                      }`}
                    >
                      {p.stock - p.reservedCount} livres
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ─── COLUNA MEIO: Comentários ─── */}
        <div className="col-span-4 bg-white rounded-2xl shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-stone-900">Comentários ao vivo</h2>
            <div className="flex items-center gap-1 bg-stone-100 rounded p-0.5 text-xs">
              {(['all', 'purchase', 'question'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setCommentFilter(f)}
                  className={`px-2 py-1 rounded ${
                    commentFilter === f ? 'bg-white shadow text-stone-900 font-medium' : 'text-stone-600'
                  }`}
                >
                  {f === 'all' ? 'Todos' : f === 'purchase' ? '🛒 Compra' : '❓ Dúvida'}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2 max-h-[700px] overflow-y-auto">
            {filteredComments.map((c) => (
              <div
                key={c.id}
                className={`p-3 rounded-lg border ${
                  c.intent === 'purchase'
                    ? 'border-emerald-200 bg-emerald-50'
                    : c.intent === 'question'
                    ? 'border-blue-200 bg-blue-50'
                    : 'border-stone-200 bg-stone-50'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold text-stone-900">{c.customerIg}</span>
                  <span className="text-[10px] text-stone-500">há {c.createdAt}</span>
                </div>
                <div className="text-sm text-stone-800">{c.text}</div>
                <div className="flex items-center gap-2 mt-2">
                  {c.intent === 'purchase' && c.productRef && (
                    <span className="text-[10px] uppercase font-bold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                      🛒 #{c.productRef}
                    </span>
                  )}
                  {c.luReplied && (
                    <span className="text-[10px] uppercase font-bold bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded flex items-center gap-1">
                      <Sparkles className="w-2.5 h-2.5" /> Lú respondeu
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ─── COLUNA DIREITA: Reservas ─── */}
        <div className="col-span-3 bg-white rounded-2xl shadow p-4">
          <h2 className="font-bold text-stone-900 mb-3">Reservas ({reservations.length})</h2>
          <div className="space-y-2 max-h-[750px] overflow-y-auto">
            {reservations.map((r) => (
              <div
                key={r.id}
                className="p-3 rounded-lg bg-stone-50 border border-stone-100"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-mono font-bold text-stone-500">
                    #{r.productRef}
                  </span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="text-sm font-medium text-stone-900 truncate">{r.productName}</div>
                <div className="text-xs text-stone-600 mt-1">
                  {r.customerIg} · {r.size && `Tam ${r.size} · `}{r.quantity}x
                </div>
                <div className="text-[10px] text-stone-500 mt-1">há {r.createdAt}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── DRAWER de produto selecionado ─── */}
      {selectedProduct && (
        <ProductDrawer
          product={selectedProduct}
          reservations={reservations.filter((r) => r.productRef === selectedProduct.ref)}
          onClose={() => setSelectedProduct(null)}
          fmtCurrency={fmtCurrency}
        />
      )}

      {/* ─── MODAL Resumo encerramento ─── */}
      {endLiveSummary && (
        <EndLiveModal
          metrics={endLiveSummary}
          reservations={reservations}
          products={products}
          onClose={() => setEndLiveSummary(null)}
          fmtCurrency={fmtCurrency}
        />
      )}
    </main>
  );
}

/* ─── Sub-components ─── */

function MetricCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: any;
  label: string;
  value: string;
  tone: 'rose' | 'pink' | 'fuchsia' | 'amber';
}) {
  const tones = {
    rose: 'bg-rose-50 text-rose-700',
    pink: 'bg-pink-50 text-pink-700',
    fuchsia: 'bg-fuchsia-50 text-fuchsia-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <div className="bg-white rounded-xl shadow p-3">
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${tones[tone]}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <div className="text-[10px] uppercase font-bold text-stone-500 tracking-wider">
          {label}
        </div>
      </div>
      <div className="text-2xl font-bold text-stone-900">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: Reservation['status'] }) {
  const styles = {
    PENDING: 'bg-amber-100 text-amber-800',
    CONFIRMED: 'bg-emerald-100 text-emerald-800',
    EXPIRED: 'bg-stone-200 text-stone-600',
  };
  const labels = {
    PENDING: '⏳ Pendente',
    CONFIRMED: '✓ Confirmada',
    EXPIRED: '✗ Expirada',
  };
  return (
    <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function ProductDrawer({
  product,
  reservations,
  onClose,
  fmtCurrency,
}: {
  product: Product;
  reservations: Reservation[];
  onClose: () => void;
  fmtCurrency: (v: number) => string;
}) {
  return (
    <>
      <div
        className="fixed inset-0 bg-black/50 z-30"
        onClick={onClose}
      />
      <aside className="fixed right-0 top-0 bottom-0 w-[420px] bg-white shadow-2xl z-40 overflow-y-auto">
        <div className="p-5 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white">
          <h3 className="font-bold text-stone-900">Produto #{product.ref}</h3>
          <button onClick={onClose} className="p-1 hover:bg-stone-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <div className="w-full aspect-square rounded-xl bg-gradient-to-br from-rose-100 to-pink-100 flex items-center justify-center text-rose-600 text-4xl font-bold mb-4">
              #{product.ref}
            </div>
            <h2 className="text-xl font-bold text-stone-900">{product.name}</h2>
            <div className="text-2xl font-bold text-rose-600 mt-1">{fmtCurrency(product.price)}</div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="bg-stone-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-stone-900">{product.stock}</div>
              <div className="text-[10px] uppercase font-bold text-stone-500">Estoque</div>
            </div>
            <div className="bg-amber-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-amber-700">{product.reservedCount}</div>
              <div className="text-[10px] uppercase font-bold text-amber-600">Reservados</div>
            </div>
            <div className="bg-emerald-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-emerald-700">
                {product.stock - product.reservedCount}
              </div>
              <div className="text-[10px] uppercase font-bold text-emerald-600">Livres</div>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-bold text-stone-900 mb-2">Reservas deste produto</h4>
            <div className="space-y-2">
              {reservations.length === 0 && (
                <div className="text-xs text-stone-500 text-center py-4">
                  Sem reservas ainda
                </div>
              )}
              {reservations.map((r) => (
                <div key={r.id} className="p-3 rounded-lg bg-stone-50 border border-stone-100">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-stone-900">{r.customerName}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="text-xs text-stone-500">
                    {r.customerIg} {r.size && `· Tam ${r.size}`} · há {r.createdAt}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function EndLiveModal({
  metrics,
  reservations,
  products,
  onClose,
  fmtCurrency,
}: {
  metrics: LiveMetrics;
  reservations: Reservation[];
  products: Product[];
  onClose: () => void;
  fmtCurrency: (v: number) => string;
}) {
  const confirmed = reservations.filter((r) => r.status === 'CONFIRMED').length;
  const pending = reservations.filter((r) => r.status === 'PENDING').length;
  const expired = reservations.filter((r) => r.status === 'EXPIRED').length;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 bg-gradient-to-r from-rose-500 to-pink-600 text-white rounded-t-2xl">
          <h2 className="text-xl font-bold">🎉 Live encerrada com sucesso</h2>
          <p className="text-sm opacity-90 mt-1">Resumo da transmissão</p>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <SummaryItem label="Duração" value={`${metrics.durationMin} min`} />
            <SummaryItem label="Espectadores" value={metrics.viewers.toString()} />
            <SummaryItem label="Comentários" value={metrics.commentsCount.toString()} />
            <SummaryItem label="Reservas geradas" value={metrics.reservationsCount.toString()} />
          </div>

          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
            <div className="text-xs uppercase font-bold text-emerald-700">GMV Total</div>
            <div className="text-3xl font-bold text-emerald-700 mt-1">
              {fmtCurrency(metrics.gmvPotential)}
            </div>
            <div className="text-xs text-emerald-600 mt-1">
              Considerando reservas confirmadas + pendentes
            </div>
          </div>

          <div>
            <h3 className="text-sm font-bold text-stone-900 mb-2">Reservas por status</h3>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> Confirmadas
                </span>
                <span className="font-bold">{confirmed}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-amber-700 flex items-center gap-1">
                  <Clock className="w-4 h-4" /> Pendentes
                </span>
                <span className="font-bold">{pending}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stone-500 flex items-center gap-1">
                  <XCircle className="w-4 h-4" /> Expiradas
                </span>
                <span className="font-bold">{expired}</span>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-full py-3 rounded-lg bg-stone-900 hover:bg-stone-800 text-white font-bold"
          >
            Fechar e exportar relatório
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-stone-50 rounded-lg p-3">
      <div className="text-[10px] uppercase font-bold text-stone-500 tracking-wider">{label}</div>
      <div className="text-xl font-bold text-stone-900 mt-1">{value}</div>
    </div>
  );
}
