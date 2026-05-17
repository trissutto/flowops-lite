'use client';

/**
 * /retaguarda/live — Painel Master da Live (operador/apresentadora)
 *
 * Layout 3 colunas:
 *  Coluna 1 — Lista de produtos da live (com botão AO VIVO)
 *  Coluna 2 — Stream de comentários em tempo real
 *  Coluna 3 — Métricas + Reservas + Controles
 *
 * Demonstra a permissão `instagram_business_manage_comments` da Meta.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface SizeStock { size: string; stock: number }
interface Product {
  id: string;
  ref_code: string;
  display_name: string;
  price_cents: number;
  promo_price_cents: number | null;
  sizes: SizeStock[];
  is_current: boolean;
  comments_count: number;
  reservations_cnt: number;
}
interface Live {
  id: string;
  title: string;
  status: string;
  ai_enabled: boolean;
  started_at: string | null;
  ended_at: string | null;
  products: Product[];
}
interface Comment {
  id: string;
  ig_username: string;
  raw_text: string;
  detected_intent: string | null;
  detected_code: string | null;
  detected_size: string | null;
  ai_answer: string | null;
  created_at: string;
}
interface Stats {
  commentsTotal: number;
  commentsPerMin: number;
  activeReservations: number;
  sales: number;
  revenueCents: number;
}

export default function LivePainelPage() {
  const [live, setLive] = useState<Live | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);
  const lastCommentIdRef = useRef<string | null>(null);

  // ─── Carrega live ativa ────────────────────────────────────
  const loadLive = async () => {
    try {
      const lives = await api<any[]>('/lives?status=live');
      if (lives && lives.length > 0) {
        const detail = await api<Live>(`/lives/${lives[0].id}`);
        setLive(detail);
      } else {
        setLive(null);
      }
    } catch (err) {
      console.error('Erro carregando live:', err);
    }
  };

  const loadComments = async (liveId: string) => {
    try {
      const data = await api<Comment[]>(`/lives/${liveId}/comments?limit=100`);
      setComments(data);
      if (data.length > 0) lastCommentIdRef.current = data[0].id;
    } catch {}
  };

  const loadStats = async (liveId: string) => {
    try {
      const data = await api<Stats>(`/lives/${liveId}/stats`);
      setStats(data);
    } catch {}
  };

  useEffect(() => {
    loadLive();
  }, []);

  // Polling a cada 5s
  useEffect(() => {
    if (!live?.id) return;
    loadComments(live.id);
    loadStats(live.id);
    const interval = setInterval(() => {
      loadLive();
      loadComments(live.id);
      loadStats(live.id);
    }, 5000);
    return () => clearInterval(interval);
  }, [live?.id]);

  // ─── Ações ────────────────────────────────────────────────
  const seedLive = async () => {
    setBusy(true);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/inbox/dev/seed-live`);
      await loadLive();
    } finally {
      setBusy(false);
    }
  };

  const startLive = async () => {
    if (!live) return;
    setBusy(true);
    try {
      await api(`/lives/${live.id}/start`, { method: 'PATCH', body: JSON.stringify({}) });
      await loadLive();
    } finally {
      setBusy(false);
    }
  };

  const endLive = async () => {
    if (!live) return;
    if (!confirm('Encerrar a live? TTL das reservas vai ser estendido pra +24h/+48h (gold/diamond).')) return;
    setBusy(true);
    try {
      await api(`/lives/${live.id}/end`, { method: 'PATCH', body: JSON.stringify({}) });
      await loadLive();
    } finally {
      setBusy(false);
    }
  };

  const toggleAi = async () => {
    if (!live) return;
    await api(`/lives/${live.id}/ai`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !live.ai_enabled }),
    });
    await loadLive();
  };

  const setCurrentProduct = async (pid: string) => {
    if (!live) return;
    setBusy(true);
    try {
      await api(`/lives/${live.id}/products/${pid}/show`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      await loadLive();
    } finally {
      setBusy(false);
    }
  };

  const closeCarts = async () => {
    if (!live) return;
    if (!confirm('Gerar links de checkout pras clientes que reservaram?')) return;
    setBusy(true);
    try {
      const result = await api<any>(`/lives/${live.id}/close-carts`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      alert(`Carrinhos fechados: ${result.closed?.length || 0}`);
    } finally {
      setBusy(false);
    }
  };

  // ─── UI ───────────────────────────────────────────────────
  if (!live) {
    return (
      <main className="min-h-screen bg-stone-100 flex items-center justify-center p-8">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md text-center">
          <div className="text-5xl mb-4">🎙️</div>
          <h2 className="text-xl font-bold text-stone-800 mb-2">Nenhuma live no ar</h2>
          <p className="text-sm text-stone-600 mb-6">
            Crie uma live de teste pra começar a operar o sistema de live commerce.
          </p>
          <button
            onClick={seedLive}
            disabled={busy}
            className="bg-rose-600 hover:bg-rose-700 disabled:bg-stone-300 text-white px-6 py-3 rounded-xl font-bold"
          >
            {busy ? 'Criando…' : '✨ Criar Live de Teste'}
          </button>
          <div className="mt-4 text-xs text-stone-500">
            Cria 1 live + 5 produtos demo.
          </div>
        </div>
      </main>
    );
  }

  const currentProduct = live.products.find((p) => p.is_current);
  const filteredComments =
    filter === 'all' ? comments : comments.filter((c) => c.detected_intent === filter);

  const intentColor = (intent: string | null) => {
    switch (intent) {
      case 'buy': return 'bg-emerald-50 border-emerald-500 text-emerald-900';
      case 'size_query': return 'bg-sky-50 border-sky-500 text-sky-900';
      case 'price_query': return 'bg-amber-50 border-amber-500 text-amber-900';
      case 'fabric_query': return 'bg-violet-50 border-violet-500 text-violet-900';
      case 'location_query': return 'bg-orange-50 border-orange-500 text-orange-900';
      default: return 'bg-stone-50 border-stone-300 text-stone-800';
    }
  };

  return (
    <main className="min-h-screen bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-4 sm:px-6 py-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${live.status === 'live' ? 'bg-red-500 animate-pulse' : 'bg-stone-400'}`} />
          <div>
            <div className="text-xs text-stone-500">FlowOps · Live Commerce</div>
            <div className="font-bold text-stone-900 text-sm sm:text-base">🎙 {live.title}</div>
          </div>
          <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${live.status === 'live' ? 'bg-red-100 text-red-700' : 'bg-stone-200 text-stone-600'}`}>
            {live.status}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {live.status !== 'live' && (
            <button
              onClick={startLive}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs sm:text-sm font-bold bg-red-600 text-white hover:bg-red-700"
            >
              ▶ INICIAR
            </button>
          )}
          {live.status === 'live' && (
            <button
              onClick={endLive}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs sm:text-sm font-bold bg-stone-700 text-white hover:bg-stone-800"
            >
              🛑 Encerrar
            </button>
          )}
          <button
            onClick={toggleAi}
            className={`px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium ${
              live.ai_enabled
                ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                : 'bg-stone-200 text-stone-600 hover:bg-stone-300'
            }`}
          >
            🤖 IA {live.ai_enabled ? 'ATIVA' : 'PARADA'}
          </button>
          <button
            onClick={closeCarts}
            disabled={busy || live.status !== 'ended'}
            className="px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-40 disabled:cursor-not-allowed"
            title={live.status !== 'ended' ? 'Encerre a live primeiro' : ''}
          >
            🛒 Fechar carrinhos
          </button>
        </div>
      </header>

      {/* 3 colunas */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr_1fr] gap-4 p-4 max-w-screen-2xl mx-auto">
        {/* ─── COLUNA 1: PRODUTOS ─── */}
        <section className="bg-white rounded-2xl shadow p-4">
          <h2 className="font-bold text-xs text-stone-500 uppercase tracking-wider mb-3">
            Produtos da live
          </h2>
          <div className="space-y-2">
            {live.products.map((p) => (
              <button
                key={p.id}
                onClick={() => setCurrentProduct(p.id)}
                disabled={busy}
                className={`w-full text-left p-3 rounded-xl border-2 transition ${
                  p.is_current
                    ? 'border-rose-500 bg-rose-50 shadow'
                    : 'border-stone-200 hover:border-rose-200'
                }`}
              >
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <div className="text-xs font-bold text-rose-600">REF {p.ref_code}</div>
                    <div className="font-semibold text-sm text-stone-800 leading-tight">
                      {p.display_name}
                    </div>
                  </div>
                  {p.is_current && (
                    <span className="text-[10px] font-bold bg-rose-600 text-white px-2 py-0.5 rounded-full whitespace-nowrap">
                      AO VIVO
                    </span>
                  )}
                </div>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-rose-700 font-bold text-sm">
                    R$ {((p.promo_price_cents ?? p.price_cents) / 100).toFixed(2).replace('.', ',')}
                  </span>
                  {p.promo_price_cents && (
                    <span className="text-stone-400 line-through text-xs">
                      R$ {(p.price_cents / 100).toFixed(2).replace('.', ',')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 mb-1">
                  {(p.sizes || []).map((s) => (
                    <span
                      key={s.size}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        s.stock === 0
                          ? 'bg-stone-100 text-stone-400 line-through'
                          : s.stock <= 3
                          ? 'bg-amber-100 text-amber-700 font-bold'
                          : 'bg-stone-100 text-stone-600'
                      }`}
                    >
                      {s.size}: {s.stock}
                    </span>
                  ))}
                </div>
                <div className="flex gap-3 text-[10px] text-stone-500">
                  <span>💬 {p.comments_count}</span>
                  <span>🛒 {p.reservations_cnt}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* ─── COLUNA 2: COMENTÁRIOS ─── */}
        <section className="bg-white rounded-2xl shadow p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bold text-xs text-stone-500 uppercase tracking-wider">
              Comentários ao vivo · {comments.length}
            </h2>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="text-xs border border-stone-300 rounded px-2 py-1"
            >
              <option value="all">Todos</option>
              <option value="buy">Compra</option>
              <option value="size_query">Tamanho</option>
              <option value="price_query">Preço</option>
              <option value="fabric_query">Tecido</option>
              <option value="location_query">Loja física</option>
              <option value="greeting">Saudação</option>
            </select>
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 max-h-[70vh] pr-1">
            {filteredComments.length === 0 && (
              <div className="text-center text-stone-400 text-sm py-12">
                Aguardando comentários…
              </div>
            )}
            {filteredComments.map((c) => (
              <div
                key={c.id}
                className={`p-2.5 rounded-lg border-l-4 ${intentColor(c.detected_intent)}`}
              >
                <div className="flex items-start justify-between mb-0.5">
                  <div className="font-semibold text-xs">@{c.ig_username}</div>
                  {c.detected_intent && (
                    <span className="text-[10px] uppercase font-bold opacity-70">
                      {c.detected_intent}
                      {c.detected_code && ` · ${c.detected_code}`}
                      {c.detected_size && `/${c.detected_size}`}
                    </span>
                  )}
                </div>
                <div className="text-sm">{c.raw_text}</div>
                {c.ai_answer && (
                  <div className="mt-1.5 text-xs bg-stone-900 text-stone-100 rounded p-2 border-l-2 border-rose-500">
                    🤖 <strong>Lú:</strong> {c.ai_answer}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ─── COLUNA 3: MÉTRICAS ─── */}
        <section className="space-y-4">
          {currentProduct && (
            <div className="bg-rose-600 text-white rounded-2xl shadow p-4">
              <div className="text-[10px] uppercase tracking-wider opacity-80">Ao vivo agora</div>
              <div className="font-bold text-lg leading-tight mt-1">
                REF {currentProduct.ref_code}
              </div>
              <div className="text-sm opacity-90">{currentProduct.display_name}</div>
              <div className="text-2xl font-bold mt-2">
                R$ {((currentProduct.promo_price_cents ?? currentProduct.price_cents) / 100).toFixed(2).replace('.', ',')}
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-bold text-xs text-stone-500 uppercase tracking-wider mb-3">
              Tempo real
            </h2>
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Comentários" value={stats?.commentsTotal ?? '—'} accent="text-stone-800" />
              <Metric label="Por minuto" value={stats?.commentsPerMin ?? '—'} accent="text-sky-600" />
              <Metric label="Reservas" value={stats?.activeReservations ?? '—'} accent="text-emerald-600" />
              <Metric label="Vendas" value={stats?.sales ?? '—'} accent="text-rose-600" />
            </div>
            <div className="mt-3 p-3 bg-stone-900 text-white rounded-xl text-center">
              <div className="text-[10px] uppercase tracking-wider opacity-70">
                Receita reservada
              </div>
              <div className="text-2xl font-bold">
                R$ {stats ? (stats.revenueCents / 100).toFixed(2).replace('.', ',') : '—'}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow p-4 text-xs text-stone-600">
            <div className="font-bold text-stone-700 mb-2">💡 Como funciona</div>
            <ul className="space-y-1 list-disc list-inside">
              <li>Cliente comenta "<strong>205 54</strong>" no Instagram</li>
              <li>Sistema captura via API Meta</li>
              <li>Parser detecta intenção, reserva é criada automaticamente</li>
              <li>IA "Lú" responde dúvidas no comentário público</li>
              <li>Ao encerrar, gera link de checkout pra cada cliente</li>
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, accent }: { label: string; value: any; accent: string }) {
  return (
    <div className="bg-stone-50 rounded-xl p-3">
      <div className="text-[10px] uppercase tracking-wider text-stone-500">{label}</div>
      <div className={`text-2xl font-bold ${accent}`}>{value}</div>
    </div>
  );
}
