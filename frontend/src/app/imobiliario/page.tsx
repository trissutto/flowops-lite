'use client';

/**
 * /imobiliario — Hub principal do módulo IMOBILIÁRIO.
 *
 * Tela dupla: KPIs no topo (dashboard) + lista de imóveis filtrável.
 * Acesso: roles admin, imobiliario_admin, imobiliario_user, imobiliario_viewer.
 *
 * Click numa linha abre /imobiliario/[id] (painel individual).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2, Plus, Search, Loader2, AlertCircle, MapPin,
  FileText, AlertTriangle, CheckCircle2, Calendar, Filter,
  Archive, ArrowLeft, Home, Construction, Tag, LogOut,
} from 'lucide-react';
import { api } from '@/lib/api';

type Property = {
  id: string;
  name: string;
  endereco: string | null;
  numero: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
  status: string;
  proprietario: string | null;
  observacoes: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  anexosCount: number;
  taxasCount: number;
  docsFaltandoCount: number;
  docsFaltando: string[];
  iptuVencendo: boolean;
};

type Dashboard = {
  total: number;
  ativos: number;
  em_construcao: number;
  pronta_locacao: number;
  vendidos: number;
  inativos: number;
  totalAnexos: number;
  docsFaltando: number;
  iptuPendente: number;
  iptuVencendo: number;
};

const STATUS_OPTIONS = [
  { value: 'ativo', label: 'Ativo', color: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  { value: 'em_construcao', label: 'Em Construção', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  { value: 'pronta_locacao', label: 'Pronta p/ Locação', color: 'bg-sky-100 text-sky-800 border-sky-300' },
  { value: 'vendido', label: 'Vendido', color: 'bg-violet-100 text-violet-800 border-violet-300' },
  { value: 'inativo', label: 'Inativo', color: 'bg-slate-100 text-slate-700 border-slate-300' },
];

const statusInfo = (s: string) =>
  STATUS_OPTIONS.find((o) => o.value === s) || { value: s, label: s, color: 'bg-slate-100 text-slate-700 border-slate-300' };

export default function ImobiliarioPage() {
  const router = useRouter();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [search, setSearch] = useState('');
  const [cidade, setCidade] = useState('');
  const [bairro, setBairro] = useState('');
  const [status, setStatus] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [searchDebounce, setSearchDebounce] = useState('');

  // Auth check
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) {
      router.push('/login?redirect=/imobiliario');
      return;
    }
    api<{ role: string; name: string }>('/auth/me')
      .then((me) => {
        const allowed = ['admin', 'imobiliario_admin', 'imobiliario_user', 'imobiliario_viewer'];
        if (!allowed.includes(me.role)) {
          alert('Você não tem acesso ao módulo Imobiliário.');
          router.push('/');
        }
      })
      .catch(() => router.push('/login?redirect=/imobiliario'));
  }, [router]);

  // Debounce do search
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounce(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (searchDebounce.trim()) params.set('search', searchDebounce.trim());
      if (cidade.trim()) params.set('cidade', cidade.trim());
      if (bairro.trim()) params.set('bairro', bairro.trim());
      if (status) params.set('status', status);
      if (showArchived) params.set('arquivados', 'true');

      const [d, list] = await Promise.all([
        api<Dashboard>('/properties/dashboard'),
        api<Property[]>(`/properties?${params}`),
      ]);
      setDashboard(d);
      setProperties(list);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar imóveis');
    } finally {
      setLoading(false);
    }
  }, [searchDebounce, cidade, bairro, status, showArchived]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const limparFiltros = () => {
    setSearch('');
    setCidade('');
    setBairro('');
    setStatus('');
    setShowArchived(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      {/* Header */}
      <header className="bg-slate-900/80 backdrop-blur-xl border-b border-white/10 sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center gap-4">
          <Link
            href="/"
            className="p-2 rounded-lg hover:bg-white/10 transition"
            title="Voltar pro hub principal"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-3 flex-1">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center shadow-lg">
              <Building2 className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight">Imobiliário</h1>
              <p className="text-xs text-slate-400">Gestão de imóveis · documentos · taxas</p>
            </div>
          </div>
          <Link
            href="/imobiliario/novo"
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-br from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-white font-bold text-sm rounded-lg shadow-lg transition-all hover:-translate-y-0.5"
          >
            <Plus className="w-4 h-4" />
            Novo imóvel
          </Link>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-6 space-y-6">
        {/* KPIs */}
        {dashboard && (
          <section>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              <KpiCard
                icon={Building2}
                label="Total"
                value={dashboard.total}
                tone="amber"
                desc="imóveis no portfólio"
              />
              <KpiCard
                icon={CheckCircle2}
                label="Ativos"
                value={dashboard.ativos}
                tone="emerald"
                desc="em operação"
              />
              <KpiCard
                icon={Construction}
                label="Em construção"
                value={dashboard.em_construcao}
                tone="amber-soft"
                desc="obra em andamento"
              />
              <KpiCard
                icon={Home}
                label="P/ Locação"
                value={dashboard.pronta_locacao}
                tone="sky"
                desc="disponível"
              />
              <KpiCard
                icon={Tag}
                label="Vendidos"
                value={dashboard.vendidos}
                tone="violet"
                desc="histórico"
              />
              <KpiCard
                icon={AlertTriangle}
                label="Docs pendentes"
                value={dashboard.docsFaltando}
                tone="rose"
                desc={`${dashboard.iptuVencendo} IPTU vencendo`}
                alert={dashboard.docsFaltando > 0}
              />
            </div>
          </section>
        )}

        {/* Filtros */}
        <section className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome, endereço, proprietário..."
                className="w-full pl-9 pr-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
              />
            </div>
            <input
              type="text"
              value={cidade}
              onChange={(e) => setCidade(e.target.value)}
              placeholder="Cidade"
              className="px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm w-40 placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
            />
            <input
              type="text"
              value={bairro}
              onChange={(e) => setBairro(e.target.value)}
              placeholder="Bairro"
              className="px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm w-40 placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="px-3 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white focus:outline-none focus:border-amber-400"
            >
              <option value="" className="bg-slate-800">Todos status</option>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} className="bg-slate-800">{o.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="accent-amber-500"
              />
              Mostrar arquivados
            </label>
            <button
              onClick={limparFiltros}
              className="text-xs text-slate-400 hover:text-white transition"
            >
              Limpar
            </button>
          </div>
        </section>

        {/* Lista */}
        <section className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl overflow-hidden">
          {loading ? (
            <div className="p-16 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-amber-400 mx-auto" />
              <div className="text-sm text-slate-400 mt-3">Carregando imóveis...</div>
            </div>
          ) : error ? (
            <div className="p-12 text-center">
              <AlertCircle className="w-10 h-10 text-rose-400 mx-auto" />
              <div className="text-base font-bold mt-3">{error}</div>
              <button
                onClick={fetchData}
                className="mt-4 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white font-bold text-sm rounded-lg"
              >
                Tentar novamente
              </button>
            </div>
          ) : properties.length === 0 ? (
            <div className="p-16 text-center">
              <Building2 className="w-12 h-12 text-slate-600 mx-auto" />
              <div className="text-base font-bold mt-3 text-slate-300">Nenhum imóvel encontrado</div>
              <div className="text-xs text-slate-500 mt-1">
                {search || cidade || bairro || status
                  ? 'Tente ajustar os filtros'
                  : 'Comece cadastrando seu primeiro imóvel'}
              </div>
              <Link
                href="/imobiliario/novo"
                className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white font-bold text-sm rounded-lg"
              >
                <Plus className="w-4 h-4" />
                Cadastrar primeiro imóvel
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {properties.map((p) => {
                const st = statusInfo(p.status);
                const isArchived = !!p.archivedAt;
                return (
                  <Link
                    key={p.id}
                    href={`/imobiliario/${p.id}`}
                    className={`flex items-center gap-4 px-5 py-4 hover:bg-white/5 transition group ${
                      isArchived ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-700/20 border border-amber-500/30 flex items-center justify-center shrink-0 group-hover:scale-110 transition">
                      <Building2 className="w-5 h-5 text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="font-bold text-white truncate">{p.name}</div>
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${st.color}`}>
                          {st.label}
                        </span>
                        {isArchived && (
                          <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border bg-slate-700 text-slate-300 border-slate-600 flex items-center gap-1">
                            <Archive className="w-3 h-3" />
                            Arquivado
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 flex items-center gap-2 truncate">
                        {(p.endereco || p.numero) && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3 h-3" />
                            {[p.endereco, p.numero].filter(Boolean).join(', ')}
                          </span>
                        )}
                        {(p.bairro || p.cidade) && (
                          <span>· {[p.bairro, p.cidade, p.estado].filter(Boolean).join(' · ')}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {p.anexosCount > 0 && (
                        <div className="flex items-center gap-1 text-[11px] text-slate-400" title="Anexos">
                          <FileText className="w-3.5 h-3.5" />
                          {p.anexosCount}
                        </div>
                      )}
                      {p.docsFaltandoCount > 0 && (
                        <div
                          className="flex items-center gap-1 px-2 py-0.5 bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[10px] font-bold rounded"
                          title={`Faltando: ${p.docsFaltando.join(', ')}`}
                        >
                          <AlertTriangle className="w-3 h-3" />
                          {p.docsFaltandoCount} pend.
                        </div>
                      )}
                      {p.iptuVencendo && (
                        <div className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[10px] font-bold rounded">
                          <Calendar className="w-3 h-3" />
                          IPTU
                        </div>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// KPI Card componente
// ─────────────────────────────────────────────────────────────────────────
function KpiCard({
  icon: Icon,
  label,
  value,
  desc,
  tone,
  alert,
}: {
  icon: any;
  label: string;
  value: number;
  desc?: string;
  tone: 'amber' | 'emerald' | 'sky' | 'violet' | 'rose' | 'amber-soft';
  alert?: boolean;
}) {
  const tones: Record<string, string> = {
    amber: 'from-amber-500/20 to-amber-700/10 border-amber-500/30 text-amber-300',
    emerald: 'from-emerald-500/20 to-emerald-700/10 border-emerald-500/30 text-emerald-300',
    sky: 'from-sky-500/20 to-sky-700/10 border-sky-500/30 text-sky-300',
    violet: 'from-violet-500/20 to-violet-700/10 border-violet-500/30 text-violet-300',
    rose: 'from-rose-500/20 to-rose-700/10 border-rose-500/30 text-rose-300',
    'amber-soft': 'from-orange-500/20 to-orange-700/10 border-orange-500/30 text-orange-300',
  };
  return (
    <div className={`relative overflow-hidden bg-gradient-to-br ${tones[tone]} border rounded-2xl p-4 hover:scale-[1.02] transition-transform ${alert ? 'animate-pulse-slow' : ''}`}>
      <div className="flex items-start justify-between mb-2">
        <Icon className="w-5 h-5 opacity-80" />
      </div>
      <div className="text-3xl font-black text-white tabular-nums">{value}</div>
      <div className="text-xs font-bold mt-1 uppercase tracking-wider opacity-90">{label}</div>
      {desc && <div className="text-[10px] mt-0.5 opacity-60">{desc}</div>}
    </div>
  );
}
