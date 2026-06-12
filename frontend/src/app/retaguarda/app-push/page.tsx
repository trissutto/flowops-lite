'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Send, Users, Bell, Smartphone, TrendingUp,
  Sparkles, Gift, Heart, Tv, Loader2, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import ProgressiveDiscountAdmin from '@/components/ProgressiveDiscountAdmin';

/**
 * /retaguarda/app-push — Painel admin do App Lurd's PWA.
 *
 * Funcionalidades:
 *   1. Stats do funil (cadastros → PWA → push ativo)
 *   2. Disparar push (broadcast / segmento / cliente específico)
 *   3. Templates rápidos (promo / live / cashback)
 *   4. Top clientes por cashback
 *   5. Últimos cadastros
 */

type Stats = {
  summary: {
    totalAccounts: number;
    pwaInstalled: number;
    pushOptIn: number;
    activeSubscriptions: number;
    welcomeBonusGiven: number;
    todayLogins: number;
    cashbackBalanceTotalBrl: number;
    cashbackEarnedTotalBrl: number;
    pwaInstallRate: number;
    pushOptInRate: number;
  };
  topCashback: Array<{ id: string; name: string | null; cpf: string; balance: number }>;
  recentAccounts: Array<{
    id: string; name: string | null; cpf: string; createdAt: string;
    pwaInstalled: boolean; pushOptIn: boolean;
  }>;
};

type SendResult = { sent: number; failed: number; deactivated?: number };

const TEMPLATES = [
  {
    id: 'promo-inverno',
    icon: '🔥',
    label: 'Promo Inverno',
    title: '🔥 INVERNO PLUS — até 40% off',
    body: 'Coleção nova chegou. Aproveita antes de acabar 💛',
    url: '/catalogo?promo=1',
  },
  {
    id: 'live-iniciou',
    icon: '📺',
    label: 'Live começou',
    title: '🔴 ESTAMOS NO AR!',
    body: 'Live com peças exclusivas. Corre pra não perder.',
    url: '/live',
  },
  {
    id: 'cashback-aviso',
    icon: '💸',
    label: 'Aviso cashback',
    title: '💸 Seu cashback está sobrando!',
    body: 'Aproveita seu saldo na próxima compra. Tá esquecido aí 😉',
    url: '/cashback',
  },
  {
    id: 'novidade',
    icon: '✨',
    label: 'Novidade',
    title: '✨ Chegaram coisas novas!',
    body: 'Confere o que rolou no Catálogo essa semana.',
    url: '/catalogo',
  },
  {
    id: 'aniversario',
    icon: '🎂',
    label: 'Aniversário',
    title: '🎂 Feliz aniversário!',
    body: 'A Lurds te dá R$ 30 de cashback hoje. Use até o final do mês!',
    url: '/cashback',
  },
];

export default function AppPushPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<'all' | 'segment' | 'account'>('all');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('/');
  const [tag, setTag] = useState('promo');
  const [segment, setSegment] = useState({ hasCashback: false, minLtvBrl: 0 });
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Busca de cliente (modo 'account')
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{
    id: string; name: string | null; cpf: string; phone: string | null; pushActive: boolean;
  }>>([]);
  const [selectedAccount, setSelectedAccount] = useState<{
    id: string; name: string | null; cpf: string; pushActive: boolean;
  } | null>(null);

  // Busca com debounce
  useEffect(() => {
    if (mode !== 'account') return;
    const t = setTimeout(async () => {
      try {
        const r = await api<{ accounts: typeof searchResults }>(
          `/customers/app/admin/search?q=${encodeURIComponent(search)}`,
        );
        setSearchResults(r.accounts);
      } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [search, mode]);

  const loadStats = async () => {
    try {
      const r = await api<Stats>('/customers/app/admin/stats');
      setStats(r);
    } catch (e: any) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStats(); }, []);

  const applyTemplate = (tpl: typeof TEMPLATES[number]) => {
    setTitle(tpl.title);
    setBody(tpl.body);
    setUrl(tpl.url);
    setTag(tpl.id);
  };

  const handleSend = async () => {
    if (!title.trim()) {
      setErr('Título obrigatório');
      return;
    }
    if (mode === 'account' && !selectedAccount) {
      setErr('Selecione um cliente.');
      return;
    }
    if (!confirm(`Enviar push pra ${expectedAudience()} clientes?`)) return;

    setErr(null);
    setResult(null);
    setSending(true);
    try {
      const r = await api<SendResult>('/customers/app/admin/push-send', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          payload: { title, body, url, tag },
          segment: mode === 'segment' ? {
            hasCashback: segment.hasCashback,
            minLtvCents: segment.minLtvBrl * 100,
          } : undefined,
          accountId: mode === 'account' ? selectedAccount?.id : undefined,
        }),
      });
      setResult(r);
    } catch (e: any) {
      setErr(e?.message || 'Falha no envio');
    } finally {
      setSending(false);
    }
  };

  const expectedAudience = () => {
    if (!stats) return '?';
    if (mode === 'all') return stats.summary.activeSubscriptions;
    if (mode === 'account') return selectedAccount ? '1' : '0';
    return `~${Math.round(stats.summary.activeSubscriptions * 0.5)}`; // estimativa
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <Smartphone className="w-6 h-6 text-emerald-600" />
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">App Lurd's — Painel</h1>
            <p className="text-xs text-slate-500">Disparar push + métricas + retaguarda</p>
          </div>
          <Link href="/retaguarda/app-invite-stats" className="text-xs text-emerald-700 font-bold uppercase">
            Stats QR
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 space-y-4">

        {/* ──────── STATS ──────── */}
        {loading ? (
          <div className="text-center py-12 text-slate-400">
            <Loader2 className="w-8 h-8 animate-spin mx-auto" />
          </div>
        ) : stats && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard
                icon={<Users className="w-5 h-5" />}
                label="Cadastros totais"
                value={stats.summary.totalAccounts}
                color="emerald"
              />
              <StatCard
                icon={<Smartphone className="w-5 h-5" />}
                label="PWA instalado"
                value={stats.summary.pwaInstalled}
                pct={stats.summary.pwaInstallRate}
                color="indigo"
              />
              <StatCard
                icon={<Bell className="w-5 h-5" />}
                label="Push ativo"
                value={stats.summary.pushOptIn}
                pct={stats.summary.pushOptInRate}
                color="amber"
              />
              <StatCard
                icon={<Heart className="w-5 h-5" />}
                label="Logins 24h"
                value={stats.summary.todayLogins}
                color="rose"
              />
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <MoneyCard
                label="Cashback ativo"
                value={stats.summary.cashbackBalanceTotalBrl}
              />
              <MoneyCard
                label="Total já creditado"
                value={stats.summary.cashbackEarnedTotalBrl}
              />
              <StatCard
                icon={<Gift className="w-5 h-5" />}
                label="Bônus R$ 20 dados"
                value={stats.summary.welcomeBonusGiven}
                color="violet"
              />
              <StatCard
                icon={<Sparkles className="w-5 h-5" />}
                label="Devices ativos"
                value={stats.summary.activeSubscriptions}
                color="cyan"
              />
            </div>
          </>
        )}

        {/* ──────── DESCONTO PROGRESSIVO (campanha do app) ──────── */}
        <ProgressiveDiscountAdmin />

        {/* ──────── DISPARAR PUSH ──────── */}
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Send className="w-5 h-5 text-emerald-600" />
            <h2 className="font-black text-lg">Disparar Push</h2>
          </div>

          {/* Templates rápidos */}
          <div className="mb-4">
            <label className="text-[11px] font-bold uppercase text-slate-500 tracking-wider block mb-2">
              Templates rápidos
            </label>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => applyTemplate(tpl)}
                  className="shrink-0 px-3 py-2 bg-slate-100 hover:bg-emerald-100 hover:border-emerald-300 border border-slate-200 rounded-lg text-xs font-bold flex items-center gap-1.5 transition"
                >
                  <span>{tpl.icon}</span>
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>

          {/* Modo */}
          <div className="mb-4">
            <label className="text-[11px] font-bold uppercase text-slate-500 tracking-wider block mb-2">
              Pra quem enviar
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setMode('all')}
                className={`px-3 py-2 rounded-lg text-sm font-bold border transition ${
                  mode === 'all'
                    ? 'bg-emerald-600 text-white border-emerald-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-emerald-400'
                }`}
              >
                Todas ({stats?.summary.activeSubscriptions || 0})
              </button>
              <button
                onClick={() => setMode('segment')}
                className={`px-3 py-2 rounded-lg text-sm font-bold border transition ${
                  mode === 'segment'
                    ? 'bg-emerald-600 text-white border-emerald-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-emerald-400'
                }`}
              >
                Segmentado
              </button>
              <button
                onClick={() => setMode('account')}
                className={`px-3 py-2 rounded-lg text-sm font-bold border transition ${
                  mode === 'account'
                    ? 'bg-emerald-600 text-white border-emerald-700'
                    : 'bg-white text-slate-700 border-slate-300 hover:border-emerald-400'
                }`}
              >
                Por cliente
              </button>
            </div>

            {/* Modo cliente — busca + lista */}
            {mode === 'account' && (
              <div className="mt-3 p-3 bg-slate-50 rounded-lg">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por nome, CPF ou telefone..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm mb-2"
                  autoFocus
                />
                {selectedAccount ? (
                  <div className="bg-emerald-50 border-2 border-emerald-500 rounded-lg p-3 flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                    <div className="flex-1">
                      <div className="font-bold text-sm">{selectedAccount.name || '(sem nome)'}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{selectedAccount.cpf}</div>
                    </div>
                    {selectedAccount.pushActive ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded">
                        🔔 Push ativo
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded">
                        ⚠️ Sem push
                      </span>
                    )}
                    <button
                      onClick={() => setSelectedAccount(null)}
                      className="text-slate-500 hover:text-slate-800 text-xs ml-1"
                    >
                      Trocar
                    </button>
                  </div>
                ) : (
                  <div className="max-h-64 overflow-y-auto space-y-1">
                    {searchResults.length === 0 ? (
                      <div className="text-xs text-slate-400 text-center py-4">
                        Digite ao menos 2 letras pra buscar
                      </div>
                    ) : (
                      searchResults.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => setSelectedAccount({
                            id: a.id, name: a.name, cpf: a.cpf, pushActive: a.pushActive,
                          })}
                          className="w-full text-left bg-white hover:bg-emerald-50 border border-slate-200 hover:border-emerald-400 rounded-lg p-2 transition flex items-center gap-2"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold text-sm truncate">
                              {a.name || '(sem nome)'}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono">
                              {a.cpf}{a.phone && ` · ${a.phone}`}
                            </div>
                          </div>
                          {a.pushActive ? (
                            <span title="Push ativo" className="text-emerald-600">🔔</span>
                          ) : (
                            <span title="Sem push" className="text-amber-500 opacity-60">⚠️</span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
            {mode === 'segment' && (
              <div className="mt-3 p-3 bg-slate-50 rounded-lg space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={segment.hasCashback}
                    onChange={(e) => setSegment({ ...segment, hasCashback: e.target.checked })}
                  />
                  Só clientes com cashback &gt; 0
                </label>
                <div className="flex items-center gap-2 text-sm">
                  <span>LTV mínimo R$</span>
                  <input
                    type="number"
                    value={segment.minLtvBrl}
                    onChange={(e) => setSegment({ ...segment, minLtvBrl: Number(e.target.value) || 0 })}
                    className="w-24 px-2 py-1 border border-slate-300 rounded"
                    min={0}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Conteúdo */}
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-bold uppercase text-slate-500 tracking-wider block mb-1">
                Título *
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="🔥 Inverno Plus — 40% off"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
                maxLength={50}
              />
              <div className="text-[10px] text-slate-400 text-right mt-0.5">{title.length}/50</div>
            </div>

            <div>
              <label className="text-[11px] font-bold uppercase text-slate-500 tracking-wider block mb-1">
                Mensagem
              </label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Coleção nova chegou. Aproveita antes de acabar 💛"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm h-20 resize-none"
                maxLength={120}
              />
              <div className="text-[10px] text-slate-400 text-right mt-0.5">{body.length}/120</div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-bold uppercase text-slate-500 tracking-wider block mb-1">
                  Link de destino
                </label>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="/catalogo"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold uppercase text-slate-500 tracking-wider block mb-1">
                  Tag (agrupa)
                </label>
                <input
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  placeholder="promo"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono"
                />
              </div>
            </div>
          </div>

          {/* Preview */}
          {title && (
            <div className="mt-4">
              <label className="text-[11px] font-bold uppercase text-slate-500 tracking-wider block mb-2">
                Preview no celular
              </label>
              <div className="bg-slate-900 rounded-2xl p-4 shadow-lg">
                <div className="bg-slate-800 rounded-xl p-3 flex items-start gap-3">
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-yellow-400 to-yellow-600 flex items-center justify-center text-stone-900 font-black">
                    L
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                      Lurd's
                    </div>
                    <div className="text-sm font-bold text-white mt-0.5 truncate">{title}</div>
                    {body && (
                      <div className="text-xs text-slate-300 mt-0.5 line-clamp-2">{body}</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {err && (
            <div className="mt-3 p-3 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              {err}
            </div>
          )}

          {result && (
            <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-900 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <strong>✅ Enviado!</strong> {result.sent} recebido(s),{' '}
                {result.failed} falha(s)
                {result.deactivated ? `, ${result.deactivated} desativada(s)` : ''}.
              </div>
            </div>
          )}

          <button
            onClick={handleSend}
            disabled={sending || !title.trim()}
            className="mt-4 w-full px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded-lg font-bold flex items-center justify-center gap-2"
          >
            {sending ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Enviando...
              </>
            ) : (
              <>
                <Send className="w-5 h-5" />
                Enviar pra {expectedAudience()} clientes
              </>
            )}
          </button>
        </div>

        {/* ──────── Top cashback + Últimos cadastros ──────── */}
        {stats && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <h3 className="font-black text-sm uppercase tracking-wider text-slate-700 mb-3">
                💰 Top 10 Cashback
              </h3>
              <div className="space-y-1.5">
                {stats.topCashback.map((c, i) => (
                  <div key={c.id} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-xs text-slate-400 w-5">#{i + 1}</span>
                    <span className="flex-1 truncate font-semibold">{c.name || c.cpf}</span>
                    <span className="font-mono text-emerald-700 font-bold">
                      R$ {c.balance.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <h3 className="font-black text-sm uppercase tracking-wider text-slate-700 mb-3">
                🆕 Últimos cadastros
              </h3>
              <div className="space-y-1.5">
                {stats.recentAccounts.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate font-semibold">{c.name || c.cpf}</span>
                    {c.pwaInstalled && <span title="PWA instalado">📱</span>}
                    {c.pushOptIn && <span title="Push ativo">🔔</span>}
                    <span className="text-xs text-slate-400 font-mono">
                      {new Date(c.createdAt).toLocaleDateString('pt-BR')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({
  icon, label, value, pct, color,
}: {
  icon: React.ReactNode; label: string; value: number | string;
  pct?: number; color: string;
}) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-700 bg-emerald-50',
    indigo: 'text-indigo-700 bg-indigo-50',
    amber: 'text-amber-700 bg-amber-50',
    rose: 'text-rose-700 bg-rose-50',
    violet: 'text-violet-700 bg-violet-50',
    cyan: 'text-cyan-700 bg-cyan-50',
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className={`inline-flex p-2 rounded-lg ${colors[color]}`}>{icon}</div>
      <div className="mt-2 text-2xl font-black tabular-nums">{value}</div>
      <div className="text-xs text-slate-500 font-semibold uppercase tracking-wider mt-0.5">
        {label}
      </div>
      {pct !== undefined && (
        <div className="text-[10px] text-slate-400 mt-0.5">{pct.toFixed(1)}% do total</div>
      )}
    </div>
  );
}

function MoneyCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gradient-to-br from-emerald-600 to-emerald-700 text-white rounded-xl p-4">
      <div className="text-[10px] uppercase tracking-widest opacity-80 font-bold">{label}</div>
      <div className="mt-1 text-2xl font-black tabular-nums">
        R$ {value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
    </div>
  );
}
