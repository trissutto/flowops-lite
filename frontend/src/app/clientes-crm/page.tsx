'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  Search, Plus, Users, Filter, X, ChevronRight, Award, Wallet,
  Calendar, Phone, Mail, MapPin, Tag as TagIcon, ShieldCheck, ShieldOff,
  CheckCircle2, AlertCircle, Loader2, MessageCircle, Store as StoreIcon,
  RefreshCw, Download,
} from 'lucide-react';

/**
 * /clientes-crm — CRM real (model Customer no banco).
 *
 * Diferente de /clientes (que agrega clientes via Order do WooCommerce),
 * essa página mostra clientes cadastrados na tabela `customers` com:
 *  - Tier, saldo de cashback, perfil Plus Size
 *  - Endereços (residencial, mala direta, entrega)
 *  - Consentimentos LGPD por canal
 *  - Tags
 *  - Extrato de cashback
 *
 * Coexiste com /clientes até o ETL completo popular essa tabela.
 */

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────
interface CustomerListItem {
  id: string;
  name: string | null;
  nameSocial: string | null;
  cpf: string | null;
  whatsapp: string | null;
  email: string | null;
  birthDate: string | null;
  sizeDefault: string | null;
  vipTier: string;
  rfvSegment: string | null;
  cashbackBalanceCents: number;
  cashbackNextExpiration: string | null;
  orderCount: number;
  ltvCents: string;            // BigInt vem como string
  ticketMedioCents: number;
  lastOrderAt: string | null;
  originStore: { id: string; code: string; name: string } | null;
  originSource: string | null;
  targetStore: { id: string; code: string; name: string } | null;
  isMixed: boolean;
  tagsCount: number;
  addressesCount: number;
  active: boolean;
}

interface ListResponse {
  data: CustomerListItem[];
  total: number;
  page: number;
  limit: number;
}

interface CustomerDetail extends CustomerListItem {
  rg: string | null;
  registroGiga: number | null;
  gender: string | null;
  maritalStatus: string | null;
  sizeSecondary: string | null;
  bodyType: string | null;
  preferredStyle: string | null;
  favoriteColors: string | null;
  avoidedPieces: string | null;
  notes: string | null;
  phone: string | null;
  tierEnteredAt: string | null;
  originSeller: string | null;
  referredBy: { id: string; name: string | null; cpf: string | null } | null;
  cashbackBalance: {
    balanceCents: number;
    accumulatedTotalCents: string;
    redeemedTotalCents: string;
    expiredTotalCents: string;
    nextExpirationAt: string | null;
    nextExpirationCents: number;
  } | null;
  cashbackTransactions: Array<{
    id: string;
    type: string;
    valueCents: number;
    purchaseValueCents: number | null;
    description: string | null;
    createdAt: string;
    store: { code: string; name: string } | null;
  }>;
  currentConsents: Record<string, boolean>;
  addresses: Array<{
    id: string;
    type: string;
    isPrimary: boolean;
    cep: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
  }>;
  tags: Array<{ id: string; name: string; color: string }>;
}

interface Tag {
  id: string;
  name: string;
  description: string | null;
  color: string;
}

interface Me {
  role: string;             // admin | operator | store
  storeId?: string | null;
  storeCode?: string | null;
  storeName?: string | null;
  name?: string;
}

interface StoreOption {
  id: string;
  code: string;
  name: string;
}

interface EtlState {
  running: boolean;
  source: 'woo' | 'giga' | null;
  totalEmails: number;
  processed: number;
  inserted: number;
  updated: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

interface GigaEtlState {
  running: boolean;
  fase: 'idle' | 'clientes' | 'historico' | 'tier' | 'done';
  faseProgresso: { current: number; total: number };
  totalGiga: number;
  processados: number;
  criados: number;
  atualizados: number;
  pulados: number;
  erros: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
const TIER_LABEL: Record<string, string> = {
  // PT-BR (oficial)
  bronze: 'Bronze', prata: 'Prata', ouro: 'Ouro', diamante: 'Diamante',
  // Aliases EN — clientes legados de seed antigo, traduz pra UI ficar consistente
  silver: 'Prata', gold: 'Ouro', diamond: 'Diamante',
  Bronze: 'Bronze', Silver: 'Prata', Gold: 'Ouro', Diamond: 'Diamante',
};
const TIER_BG: Record<string, string> = {
  bronze:   'bg-orange-100 text-orange-800 border-orange-300',
  prata:    'bg-gray-100 text-gray-800 border-gray-300',
  ouro:     'bg-yellow-100 text-yellow-800 border-yellow-300',
  diamante: 'bg-cyan-100 text-cyan-800 border-cyan-300',
  // Aliases EN
  silver:   'bg-gray-100 text-gray-800 border-gray-300',
  gold:     'bg-yellow-100 text-yellow-800 border-yellow-300',
  diamond:  'bg-cyan-100 text-cyan-800 border-cyan-300',
  Bronze:   'bg-orange-100 text-orange-800 border-orange-300',
  Silver:   'bg-gray-100 text-gray-800 border-gray-300',
  Gold:     'bg-yellow-100 text-yellow-800 border-yellow-300',
  Diamond:  'bg-cyan-100 text-cyan-800 border-cyan-300',
};

const GIGA_FASE_LABEL: Record<string, string> = {
  idle: 'aguardando',
  clientes: 'importando clientes',
  historico: 'calculando histórico (LTV)',
  tier: 'recalculando tier',
  done: 'concluído',
};

function fmtMoney(cents: number | string): string {
  const v = typeof cents === 'string' ? Number(cents) : cents;
  return (v / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const dias = Math.floor(diff / 86400000);
  if (dias < 0) return d.toLocaleDateString('pt-BR');
  if (dias === 0) return 'hoje';
  if (dias === 1) return 'ontem';
  if (dias < 30) return `${dias}d`;
  if (dias < 365) return `${Math.floor(dias / 30)}m`;
  return d.toLocaleDateString('pt-BR');
}

function fmtPhone(p: string | null): string {
  if (!p) return '—';
  // +5511999999999 → (11) 99999-9999
  const d = p.replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return p;
}

// ──────────────────────────────────────────────────────────────────────────
// Página
// ──────────────────────────────────────────────────────────────────────────
export default function ClientesCrmPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeFilter, setStoreFilter] = useState<string>('');   // só usado por matrix

  const [data, setData] = useState<CustomerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [tier, setTier] = useState<string>('');
  const [hasWhatsapp, setHasWhatsapp] = useState(false);
  const [hasCashbackBalance, setHasCashbackBalance] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showFilters, setShowFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // ── Suporte a URL ?openId=X — abre drawer direto desse cliente.
  // Usado pelo PDV (modal Identificar Cliente → botão "Ver ficha completa")
  // e pelo painel VIP. Lê uma vez ao carregar.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const openId = params.get('openId');
    if (openId) {
      setSelectedId(openId);
      // Limpa query string sem recarregar pra não voltar a abrir se F5
      const url = new URL(window.location.href);
      url.searchParams.delete('openId');
      window.history.replaceState({}, '', url.toString());
    }
  }, []);

  // ETL state — só lemos pra mostrar badge "rodando" no botão Sincronizações.
  // As funções de disparar sync ficam em /clientes-crm/sincronizacao
  const [etlState, setEtlState] = useState<EtlState | null>(null);
  const [gigaEtl, setGigaEtl] = useState<GigaEtlState | null>(null);

  const isMatrix = me?.role === 'admin' || me?.role === 'operator';

  // Carrega user atual + lojas (1x)
  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (!isMatrix) return;
    api<StoreOption[]>('/stores')
      .then(s => setStores(Array.isArray(s) ? s : []))
      .catch(() => {});
  }, [isMatrix]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams();
      q.set('page', String(page));
      q.set('limit', String(limit));
      if (search) q.set('search', search);
      if (tier) q.set('tier', tier);
      if (hasWhatsapp) q.set('hasWhatsapp', 'true');
      if (hasCashbackBalance) q.set('hasCashbackBalance', 'true');
      // Filtro de loja só faz sentido pra matrix; vendedora o backend força
      if (isMatrix && storeFilter) q.set('storeId', storeFilter);
      const res = await api<ListResponse>(`/customers-crm?${q}`);
      setData(res.data);
      setTotal(res.total);
    } catch (e: any) {
      setError(`Falha ao carregar: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, tier, hasWhatsapp, hasCashbackBalance, storeFilter, isMatrix]);

  useEffect(() => { load(); }, [load]);

  // ETL polling
  useEffect(() => {
    if (!isMatrix) return;
    api<EtlState>('/customers-crm/etl/status').then(setEtlState).catch(() => {});
  }, [isMatrix]);

  useEffect(() => {
    if (!etlState?.running) return;
    const t = setInterval(async () => {
      try {
        const s = await api<EtlState>('/customers-crm/etl/status');
        const wasRunning = etlState?.running;
        setEtlState(s);
        if (wasRunning && !s.running) load(); // terminou → recarrega lista
      } catch {}
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etlState?.running]);

  // NOTA: as funções de sync (startWooSync, startGigaSync, atualizarLojaPrincipal)
  // foram movidas pra /clientes-crm/sincronizacao. Aqui só mantemos o polling
  // dos states pra mostrar o badge "rodando" no botão de Sincronizações.

  // Polling Giga
  useEffect(() => {
    if (!isMatrix) return;
    api<GigaEtlState>('/customers-crm/etl/giga/status').then(setGigaEtl).catch(() => {});
  }, [isMatrix]);
  useEffect(() => {
    if (!gigaEtl?.running) return;
    const t = setInterval(async () => {
      try {
        const s = await api<GigaEtlState>('/customers-crm/etl/giga/status');
        const wasRunning = gigaEtl?.running;
        setGigaEtl(s);
        if (wasRunning && !s.running) load();
      } catch {}
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gigaEtl?.running]);

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function clearFilters() {
    setTier('');
    setHasWhatsapp(false);
    setHasCashbackBalance(false);
    setSearch('');
    setSearchInput('');
    setPage(1);
  }

  const hasActiveFilters = !!tier || hasWhatsapp || hasCashbackBalance || !!search;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-7 h-7 text-purple-700" />
            Clientes CRM
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Base mestra de clientes (Giga + WooCommerce + Instagram + cadastros PDV)
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Sincronizações agrupadas em página dedicada — tira poluição do header
              da listagem. Botão indica se algum sync está rodando (badge animado). */}
          {isMatrix && (
            <a
              href="/clientes-crm/sincronizacao"
              className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 border border-slate-300"
              title="Importar clientes do site e Giga; atualizar lojas"
            >
              <RefreshCw className={`w-4 h-4 ${(etlState?.running || gigaEtl?.running) ? 'animate-spin text-blue-600' : ''}`} />
              Sincronizações
              {(etlState?.running || gigaEtl?.running) && (
                <span className="ml-1 inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              )}
            </a>
          )}
          <button
            onClick={() => setShowCreate(true)}
            className="bg-purple-700 hover:bg-purple-800 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2 shadow-sm"
          >
            <Plus className="w-4 h-4" /> Cadastrar cliente
          </button>
        </div>
      </div>

      {/* Sync em andamento? Mostra banner discreto com link pra página de progresso */}
      {(gigaEtl?.running || etlState?.running) && (
        <a
          href="/clientes-crm/sincronizacao"
          className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 bg-blue-50 border border-blue-200 text-sm text-blue-900 hover:bg-blue-100"
        >
          <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
          <span>
            Sincronização em andamento — clique pra ver o progresso ao vivo
          </span>
        </a>
      )}

      {/* ── Banner informativo (só vendedora e sem-loja; admin filtra inline na busca) ── */}
      {me && !isMatrix && (
        me.storeId ? (
          <div className="mb-3 flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5">
            <StoreIcon className="w-5 h-5 text-blue-700" />
            <span className="text-sm text-blue-900">
              Você está vendo clientes da loja <strong>{me.storeName ?? me.storeCode ?? 'sua loja'}</strong>.
              Outras lojas não aparecem aqui.
            </span>
          </div>
        ) : (
          <div className="mb-3 flex items-center gap-3 bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-2.5">
            <AlertCircle className="w-5 h-5 text-yellow-700" />
            <span className="text-sm text-yellow-900">
              Seu usuário não tem loja vinculada. Fale com a retaguarda para liberar acesso.
            </span>
          </div>
        )
      )}

      {/* ── ETL info bar (quando rodando ou recém-terminado) ───────── */}
      {isMatrix && etlState && (etlState.running || etlState.finishedAt) && (
        <div className={`mb-4 px-4 py-3 rounded-lg border text-sm flex items-center gap-3 ${
          etlState.running
            ? 'bg-blue-50 border-blue-200 text-blue-900'
            : etlState.errors > 0
              ? 'bg-yellow-50 border-yellow-200 text-yellow-900'
              : 'bg-green-50 border-green-200 text-green-900'
        }`}>
          {etlState.running
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : <CheckCircle2 className="w-4 h-4" />}
          <span>
            <strong>ETL {etlState.source}:</strong>{' '}
            {etlState.running
              ? `processando ${etlState.processed}/${etlState.totalEmails}...`
              : `concluído — ${etlState.inserted} inseridos, ${etlState.updated} atualizados, ${etlState.errors} erros.`}
          </span>
          {!etlState.running && (
            <button onClick={() => setEtlState({ ...etlState, finishedAt: null })} className="ml-auto">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* ── Barra de busca + filtros ──────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
        <form onSubmit={onSearchSubmit} className="flex gap-2 items-center">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Buscar por nome, CPF, WhatsApp..."
              className="w-full pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>

          {/* Filtro de loja inline (só admin/operator) */}
          {isMatrix && (
            <div className="flex items-center gap-1.5 pl-3 border-l border-gray-200">
              <StoreIcon className="w-4 h-4 text-purple-700" />
              <select
                value={storeFilter}
                onChange={e => { setStoreFilter(e.target.value); setPage(1); }}
                className="border rounded px-2 py-1.5 text-sm bg-purple-50 border-purple-300 text-purple-900 font-medium min-w-[180px]"
                title="Filtrar por loja de origem do cliente"
              >
                <option value="">Todas as lojas</option>
                {stores.map(s => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
          )}

          <button type="submit" className="bg-gray-800 hover:bg-gray-900 text-white px-4 py-2 rounded-lg">
            Buscar
          </button>
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={`px-3 py-2 rounded-lg border flex items-center gap-1 ${
              hasActiveFilters ? 'bg-purple-50 border-purple-300 text-purple-700' : 'border-gray-300'
            }`}
          >
            <Filter className="w-4 h-4" />
            Filtros {hasActiveFilters && `(${[tier, hasWhatsapp, hasCashbackBalance, search].filter(Boolean).length})`}
          </button>
          {hasActiveFilters && (
            <button type="button" onClick={clearFilters} className="text-sm text-gray-500 hover:text-red-600">
              <X className="w-4 h-4" />
            </button>
          )}
        </form>

        {showFilters && (
          <div className="mt-4 pt-4 border-t grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-gray-500 uppercase font-medium block mb-1">Tier</label>
              <select
                value={tier}
                onChange={e => { setTier(e.target.value); setPage(1); }}
                className="w-full border rounded px-3 py-2"
              >
                <option value="">Todos</option>
                <option value="bronze">Bronze</option>
                <option value="prata">Prata</option>
                <option value="ouro">Ouro</option>
                <option value="diamante">Diamante</option>
              </select>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={hasWhatsapp}
                onChange={e => { setHasWhatsapp(e.target.checked); setPage(1); }}
                className="w-4 h-4"
              />
              <span className="text-sm">Só com WhatsApp</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={hasCashbackBalance}
                onChange={e => { setHasCashbackBalance(e.target.checked); setPage(1); }}
                className="w-4 h-4"
              />
              <span className="text-sm">Só com saldo cashback</span>
            </label>
          </div>
        )}
      </div>

      {/* ── Tabela ────────────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 border-b">
              <tr>
                <th className="text-left px-3 py-2.5 font-medium text-gray-700 whitespace-nowrap">Cliente</th>
                <th className="text-left px-3 py-2.5 font-medium text-gray-700 whitespace-nowrap">CPF</th>
                <th className="text-left px-3 py-2.5 font-medium text-gray-700 whitespace-nowrap">WhatsApp</th>
                <th className="text-center px-3 py-2.5 font-medium text-gray-700 whitespace-nowrap">Tier</th>
                <th className="text-right px-3 py-2.5 font-medium text-gray-700 whitespace-nowrap">Cashback</th>
                <th className="text-center px-3 py-2.5 font-medium text-gray-700 whitespace-nowrap">Compras</th>
                <th className="text-center px-3 py-2.5 font-medium text-gray-700 whitespace-nowrap">Última</th>
                <th className="text-center px-3 py-2.5 font-medium text-gray-700 whitespace-nowrap">Loja</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="py-12 text-center text-gray-500">
                  <Loader2 className="w-6 h-6 animate-spin inline mr-2" /> Carregando...
                </td></tr>
              )}
              {!loading && data.length === 0 && (
                <tr><td colSpan={9} className="py-12 text-center text-gray-500">
                  Nenhum cliente encontrado. Ajuste filtros ou cadastre o primeiro.
                </td></tr>
              )}
              {!loading && data.map(c => {
                const dias = c.lastOrderAt ? Math.floor((Date.now() - new Date(c.lastOrderAt).getTime()) / 86400000) : null;
                const inativaAlerta = dias !== null && dias > 90;
                const tierPremium = c.vipTier === 'diamante';
                return (
                <tr
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`border-b hover:bg-purple-50 cursor-pointer transition-colors ${
                    c.isMixed ? 'bg-sky-50/60' : tierPremium ? 'bg-amber-50/30' : ''
                  }`}
                >
                  <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span>{c.nameSocial || c.name || <span className="italic text-gray-400">sem nome</span>}</span>
                      {c.isMixed && (
                        <span
                          title={`Cliente do site mora perto desta loja${c.targetStore ? ` (${c.targetStore.name})` : ''}`}
                          className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 border border-sky-300"
                        >
                          🌐 SITE
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-600 whitespace-nowrap">
                    {c.cpf ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {c.whatsapp
                      ? <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3 text-green-600" /> {fmtPhone(c.whatsapp)}</span>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    <span className={`inline-block px-2.5 py-0.5 text-xs rounded-full border font-medium ${TIER_BG[c.vipTier] ?? 'bg-gray-100'}`}>
                      {TIER_LABEL[c.vipTier] ?? c.vipTier}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {c.cashbackBalanceCents > 0
                      ? <span className="font-semibold text-green-700">{fmtMoney(c.cashbackBalanceCents)}</span>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center font-mono text-xs">
                    {c.orderCount > 0 ? c.orderCount : <span className="text-gray-400">—</span>}
                  </td>
                  <td className={`px-3 py-2 text-center text-xs whitespace-nowrap ${inativaAlerta ? 'text-red-700 font-medium' : 'text-gray-600'}`}>
                    {fmtDate(c.lastOrderAt)}
                  </td>
                  <td className="px-3 py-2 text-center whitespace-nowrap">
                    {c.originStore?.code
                      ? <span className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">{c.originStore.code}</span>
                      : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="text-gray-400"><ChevronRight className="w-4 h-4" /></td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>

        {/* Paginação */}
        {total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-slate-100 text-sm">
            <div className="text-gray-600">
              Mostrando {((page - 1) * limit) + 1}–{Math.min(page * limit, total)} de {total.toLocaleString('pt-BR')}
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="px-3 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Anterior
              </button>
              <span>Página {page} de {totalPages}</span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="px-3 py-1 border rounded disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Próxima
              </button>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 bg-red-50 border border-red-200 text-red-800 p-3 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {/* ── Drawer detalhe ────────────────────────────────────────────── */}
      {selectedId && (
        <CustomerDetailDrawer
          customerId={selectedId}
          onClose={() => setSelectedId(null)}
          onMutated={() => { load(); }}
        />
      )}

      {/* ── Modal criar ───────────────────────────────────────────────── */}
      {showCreate && (
        <CreateCustomerModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); load(); setSelectedId(id); }}
        />
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// StatCard
// ══════════════════════════════════════════════════════════════════════════
function StatCard({ label, value, icon, hint }: { label: string; value: string; icon: React.ReactNode; hint?: string }) {
  return (
    <div className="bg-white border rounded-lg p-4 shadow-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 uppercase font-medium">{label}</span>
        <span className="text-gray-400">{icon}</span>
      </div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Drawer de detalhe — abas Perfil / Cashback / Endereços / LGPD / Tags
// ══════════════════════════════════════════════════════════════════════════
function CustomerDetailDrawer({
  customerId,
  onClose,
  onMutated,
}: {
  customerId: string;
  onClose: () => void;
  onMutated: () => void;
}) {
  const [tab, setTab] = useState<'perfil' | 'historico' | 'cashback' | 'enderecos' | 'lgpd' | 'tags'>('perfil');
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<CustomerDetail>(`/customers-crm/${customerId}`);
      setDetail(res);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => { load(); }, [load]);

  function refresh() {
    load();
    onMutated();
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white shadow-2xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b px-6 py-4 z-10 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">
              {detail?.nameSocial || detail?.name || 'Carregando...'}
            </h2>
            {detail && (
              <div className="text-xs text-gray-500 flex items-center gap-3 mt-0.5">
                <span>{detail.cpf ?? 'sem CPF'}</span>
                <span className={`px-2 py-0.5 rounded-full border ${TIER_BG[detail.vipTier] ?? ''}`}>
                  {TIER_LABEL[detail.vipTier] ?? detail.vipTier}
                </span>
                {detail.rfvSegment && <span className="text-purple-600">{detail.rfvSegment}</span>}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b sticky top-[73px] bg-white z-10">
          <nav className="flex gap-1 px-4">
            {(['perfil','historico','cashback','enderecos','lgpd','tags'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
                  tab === t
                    ? 'border-purple-700 text-purple-700'
                    : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
              >
                {t === 'lgpd' ? 'LGPD' : t}
              </button>
            ))}
          </nav>
        </div>

        {/* Body */}
        {loading || !detail ? (
          <div className="p-12 text-center text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin mx-auto" />
          </div>
        ) : (
          <div className="p-6">
            {tab === 'perfil'    && <PerfilTab d={detail} onUpdate={refresh} />}
            {tab === 'historico' && <HistoricoTab customerId={detail.id} />}
            {tab === 'cashback'  && <CashbackTab d={detail} onUpdate={refresh} />}
            {tab === 'enderecos' && <EnderecosTab d={detail} onUpdate={refresh} />}
            {tab === 'lgpd'      && <LgpdTab d={detail} onUpdate={refresh} />}
            {tab === 'tags'      && <TagsTab d={detail} onUpdate={refresh} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA Perfil
// ══════════════════════════════════════════════════════════════════════════
function PerfilTab({ d, onUpdate }: { d: CustomerDetail; onUpdate: () => void }) {
  return (
    <div className="space-y-6 text-sm">
      <Section title="Identificação">
        <Field label="Nome completo" value={d.name} />
        <Field label="Como prefere ser chamada" value={d.nameSocial} />
        <Field label="CPF" value={d.cpf} />
        <Field label="RG" value={d.rg} />
        <Field label="Registro Giga" value={d.registroGiga?.toString() ?? null} />
        <Field label="Data nascimento" value={d.birthDate ? new Date(d.birthDate).toLocaleDateString('pt-BR') : null} />
        <Field label="Gênero" value={d.gender} />
        <Field label="Estado civil" value={d.maritalStatus} />
      </Section>

      <Section title="Contato">
        <Field label="WhatsApp" value={fmtPhone(d.whatsapp)} />
        <Field label="Telefone fixo" value={fmtPhone(d.phone)} />
        <Field label="E-mail" value={d.email} />
      </Section>

      <Section title="Perfil Plus Size">
        <Field label="Manequim principal" value={d.sizeDefault} />
        <Field label="Manequim secundário" value={d.sizeSecondary} />
        <Field label="Tipo de corpo" value={d.bodyType} />
        <Field label="Estilo preferido" value={d.preferredStyle} />
        <Field label="Cores favoritas" value={d.favoriteColors} />
        <Field label="Peças que evita" value={d.avoidedPieces} />
      </Section>

      <Section title="Atribuição">
        <Field label="Loja de origem" value={d.originStore?.name} />
        <Field label="Fonte" value={d.originSource} />
        <Field label="Vendedora que captou" value={d.originSeller} />
        <Field label="Indicada por" value={d.referredBy?.name} />
      </Section>

      <Section title="Métricas">
        <Field label="Total de compras" value={d.orderCount.toString()} />
        <Field label="LTV" value={Number(d.ltvCents) > 0 ? fmtMoney(d.ltvCents) : null} />
        <Field label="Ticket médio" value={d.ticketMedioCents > 0 ? fmtMoney(d.ticketMedioCents) : null} />
        <Field label="Primeira compra" value={d.lastOrderAt ? fmtDate(d.lastOrderAt) : null} />
        <Field label="Última compra" value={fmtDate(d.lastOrderAt)} />
      </Section>

      {d.notes && (
        <Section title="Observações">
          <div className="col-span-2 text-gray-700 whitespace-pre-line">{d.notes}</div>
        </Section>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA Histórico — compras + devoluções + vales + marcados Giga
// ══════════════════════════════════════════════════════════════════════════
interface HistoricoData {
  customer: { id: string; name: string | null; cpf: string | null };
  compras: Array<{
    id: string; saleNumber: string; nfceNumber: string | null;
    storeCode: string; storeName: string;
    total: number; subtotal: number; desconto: number;
    paymentMethod: string; sellerName: string | null;
    qtdItens: number; qtdPayments: number;
    payments: Array<{ method: string; valor: number }>;
    data: string;
  }>;
  devolucoes: Array<{
    id: string; returnNumber: string;
    storeCode: string; storeName: string;
    modo: string; valor: number; status: string;
    creditoCode: string | null;
    creditoValidade: string | null;
    creditoUsado: boolean;
    creditoUsadoAt: string | null;
    originalSaleNumber: string | null;
    userName: string | null;
    qtdItens: number;
    data: string;
  }>;
  vales: {
    ativos: Array<{ code: string; valor: number; validade: string | null; emitidoEm: string; loja: string; vencido: boolean }>;
    usados: Array<{ code: string; valor: number; usadoEm: string | null; usadoSaleId: string | null; emitidoEm: string; loja: string }>;
    saldoAtivo: number;
  };
  marcadosGiga: {
    items: Array<{ registro: number; sku: string; descricao: string; qtd: number; valor: number; total: number; data: string; loja: string }>;
    total: number;
    qtd: number;
  };
  warning?: string;
}

function HistoricoTab({ customerId }: { customerId: string }) {
  const [data, setData] = useState<HistoricoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await api<HistoricoData>(`/customers-crm/${customerId}/historico`);
        if (!cancelled) setData(res);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || 'Erro ao carregar histórico');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [customerId]);

  if (loading) {
    return (
      <div className="p-12 text-center text-gray-400">
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
        <div className="mt-2 text-xs">Carregando histórico...</div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="p-6 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
        Erro: {err}
      </div>
    );
  }

  if (!data) return null;

  const fmtDT = (iso: string | null) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  };

  const totalCompras = data.compras.reduce((s, c) => s + Number(c.total || 0), 0);
  const totalDevolucoes = data.devolucoes.reduce((s, r) => s + Number(r.valor || 0), 0);

  return (
    <div className="space-y-6">
      {data.warning && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded text-amber-800 text-xs flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{data.warning}</span>
        </div>
      )}

      {/* Resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3">
          <div className="text-[10px] uppercase text-emerald-700 font-bold">Compras</div>
          <div className="text-lg font-bold text-emerald-900">{data.compras.length}</div>
          <div className="text-[11px] text-emerald-700">R$ {totalCompras.toFixed(2).replace('.', ',')}</div>
        </div>
        <div className="bg-rose-50 border border-rose-200 rounded p-3">
          <div className="text-[10px] uppercase text-rose-700 font-bold">Devoluções</div>
          <div className="text-lg font-bold text-rose-900">{data.devolucoes.length}</div>
          <div className="text-[11px] text-rose-700">R$ {totalDevolucoes.toFixed(2).replace('.', ',')}</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded p-3">
          <div className="text-[10px] uppercase text-amber-700 font-bold">Vales ativos</div>
          <div className="text-lg font-bold text-amber-900">{data.vales?.ativos?.length ?? 0}</div>
          <div className="text-[11px] text-amber-700">R$ {Number(data.vales?.saldoAtivo ?? 0).toFixed(2).replace('.', ',')}</div>
        </div>
        <div className="bg-purple-50 border border-purple-200 rounded p-3">
          <div className="text-[10px] uppercase text-purple-700 font-bold">Marcados</div>
          <div className="text-lg font-bold text-purple-900">{data.marcadosGiga?.qtd ?? 0}</div>
          <div className="text-[11px] text-purple-700">R$ {Number(data.marcadosGiga?.total ?? 0).toFixed(2).replace('.', ',')}</div>
        </div>
      </div>

      {/* Compras */}
      <section>
        <h3 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          Compras ({data.compras.length})
        </h3>
        {data.compras.length === 0 ? (
          <div className="text-xs text-gray-400 italic p-3 border border-dashed rounded">Nenhuma compra registrada</div>
        ) : (
          <div className="space-y-2">
            {data.compras.map((c) => (
              <div key={c.id} className="border rounded p-3 hover:bg-gray-50">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">#{c.saleNumber}</span>
                      {c.nfceNumber && <span className="text-[10px] text-gray-500">NFC-e {c.nfceNumber}</span>}
                      <span className="text-[10px] uppercase font-bold text-purple-700">{c.storeName}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {fmtDT(c.data)} · {c.qtdItens} {c.qtdItens === 1 ? 'peça' : 'peças'}
                      {c.sellerName && ` · ${c.sellerName}`}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {c.payments.map((p, i) => (
                        <span key={i} className="text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200">
                          {p.method} R$ {Number(p.valor).toFixed(2).replace('.', ',')}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-emerald-700">
                      R$ {Number(c.total).toFixed(2).replace('.', ',')}
                    </div>
                    {Number(c.desconto || 0) > 0 && (
                      <div className="text-[10px] text-red-500">−R$ {Number(c.desconto).toFixed(2).replace('.', ',')} desc</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Devoluções */}
      <section>
        <h3 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-rose-500" />
          Devoluções ({data.devolucoes.length})
        </h3>
        {data.devolucoes.length === 0 ? (
          <div className="text-xs text-gray-400 italic p-3 border border-dashed rounded">Nenhuma devolução</div>
        ) : (
          <div className="space-y-2">
            {data.devolucoes.map((r) => (
              <div key={r.id} className="border rounded p-3 hover:bg-gray-50">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">#{r.returnNumber}</span>
                      <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                        r.modo === 'troca' ? 'bg-amber-100 text-amber-800' :
                        r.modo === 'credito' ? 'bg-purple-100 text-purple-800' :
                        r.modo === 'pix' ? 'bg-blue-100 text-blue-800' :
                        'bg-emerald-100 text-emerald-800'
                      }`}>
                        {r.modo}
                      </span>
                      <span className="text-[10px] text-gray-500">{r.storeName}</span>
                      {r.originalSaleNumber && (
                        <span className="text-[10px] text-gray-500">venda orig: #{r.originalSaleNumber}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {fmtDT(r.data)} · {r.qtdItens} {r.qtdItens === 1 ? 'peça' : 'peças'}
                      {r.userName && ` · ${r.userName}`}
                    </div>
                    {r.creditoCode && (
                      <div className="mt-2 text-[11px]">
                        <span className="font-mono bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded border border-amber-300">
                          Vale {r.creditoCode}
                        </span>
                        {r.creditoUsado ? (
                          <span className="ml-2 text-emerald-700">✓ usado {fmtDT(r.creditoUsadoAt)}</span>
                        ) : r.creditoValidade && new Date(r.creditoValidade).getTime() < Date.now() ? (
                          <span className="ml-2 text-red-600">⚠ vencido em {fmtDT(r.creditoValidade)}</span>
                        ) : (
                          <span className="ml-2 text-amber-700">ativo até {fmtDT(r.creditoValidade)}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-rose-700">
                      R$ {Number(r.valor).toFixed(2).replace('.', ',')}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Vales ativos */}
      {data.vales.ativos.length > 0 && (
        <section>
          <h3 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            Vales-troca ativos ({data.vales.ativos.length}) — R$ {data.vales.saldoAtivo.toFixed(2).replace('.', ',')}
          </h3>
          <div className="space-y-1">
            {data.vales.ativos.map((v) => (
              <div key={v.code} className="border border-amber-200 bg-amber-50 rounded p-2 flex items-center justify-between text-xs">
                <div>
                  <span className="font-mono font-bold text-amber-900">{v.code}</span>
                  <span className="ml-2 text-gray-600">{v.loja}</span>
                  <span className="ml-2 text-gray-500">emitido {fmtDT(v.emitidoEm)}</span>
                  {v.validade && <span className="ml-2 text-amber-700">até {fmtDT(v.validade)}</span>}
                </div>
                <div className="font-bold text-amber-900">R$ {Number(v.valor).toFixed(2).replace('.', ',')}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Marcados Giga */}
      {data.marcadosGiga.items.length > 0 && (
        <section>
          <h3 className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-500" />
            Marcados ativos no Giga ({data.marcadosGiga.qtd}) — R$ {data.marcadosGiga.total.toFixed(2).replace('.', ',')}
          </h3>
          <div className="border rounded overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-purple-50">
                <tr>
                  <th className="px-2 py-1 text-left">Data</th>
                  <th className="px-2 py-1 text-left">SKU</th>
                  <th className="px-2 py-1 text-left">Descrição</th>
                  <th className="px-2 py-1 text-center">Qtd</th>
                  <th className="px-2 py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.marcadosGiga.items.map((m) => (
                  <tr key={m.registro} className="border-t hover:bg-purple-50/50">
                    <td className="px-2 py-1 text-gray-500">{fmtDT(m.data)}</td>
                    <td className="px-2 py-1 font-mono">{m.sku}</td>
                    <td className="px-2 py-1 truncate max-w-[180px]" title={m.descricao}>{m.descricao}</td>
                    <td className="px-2 py-1 text-center">{m.qtd}</td>
                    <td className="px-2 py-1 text-right font-medium">R$ {Number(m.total).toFixed(2).replace('.', ',')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA Cashback — saldo + extrato + creditar manual
// ══════════════════════════════════════════════════════════════════════════
function CashbackTab({ d, onUpdate }: { d: CustomerDetail; onUpdate: () => void }) {
  const [showCredit, setShowCredit] = useState(false);
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  async function credit() {
    setBusy(true);
    try {
      const cents = Math.round(parseFloat(value.replace(',', '.')) * 100);
      if (!cents || cents <= 0) throw new Error('Valor inválido');
      await api(`/customers-crm/${d.id}/cashback/credit`, {
        method: 'POST',
        body: JSON.stringify({ valueCents: cents, description: description || 'Crédito manual' }),
      });
      setValue(''); setDescription(''); setShowCredit(false);
      onUpdate();
    } catch (e: any) {
      alert(`Falha: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Cards de saldo */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-gradient-to-br from-green-50 to-green-100 border border-green-300 rounded-lg p-4">
          <div className="text-xs text-green-700 uppercase font-medium">Saldo disponível</div>
          <div className="text-3xl font-bold text-green-800 mt-1">
            {fmtMoney(d.cashbackBalance?.balanceCents ?? 0)}
          </div>
          {d.cashbackBalance?.nextExpirationAt && (
            <div className="text-xs text-green-700 mt-2 flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              Próxima expiração: {new Date(d.cashbackBalance.nextExpirationAt).toLocaleDateString('pt-BR')}
              {' '}({fmtMoney(d.cashbackBalance.nextExpirationCents)})
            </div>
          )}
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-xs text-gray-500 uppercase font-medium">Acumulado total</div>
          <div className="text-xl font-bold text-gray-700 mt-1">
            {fmtMoney(d.cashbackBalance?.accumulatedTotalCents ?? '0')}
          </div>
          <div className="text-xs text-gray-500 mt-2">
            Resgatado: {fmtMoney(d.cashbackBalance?.redeemedTotalCents ?? '0')}<br/>
            Expirado: {fmtMoney(d.cashbackBalance?.expiredTotalCents ?? '0')}
          </div>
        </div>
      </div>

      {/* Botão creditar manual */}
      {!showCredit ? (
        <button
          onClick={() => setShowCredit(true)}
          className="w-full bg-purple-100 hover:bg-purple-200 text-purple-800 px-4 py-2 rounded-lg font-medium flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" /> Creditar cashback manual
        </button>
      ) : (
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3">
          <h3 className="font-medium">Crédito manual</h3>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="Valor R$"
              className="border rounded px-3 py-2"
            />
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Motivo / descrição"
              className="border rounded px-3 py-2"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={credit}
              disabled={busy}
              className="bg-purple-700 hover:bg-purple-800 text-white px-4 py-2 rounded font-medium disabled:opacity-50"
            >
              {busy ? 'Creditando...' : 'Creditar'}
            </button>
            <button onClick={() => setShowCredit(false)} className="px-4 py-2 border rounded">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Extrato */}
      <div>
        <h3 className="font-medium mb-3">Extrato (últimos 20)</h3>
        {d.cashbackTransactions.length === 0 ? (
          <div className="text-sm text-gray-400 italic">Nenhum movimento ainda.</div>
        ) : (
          <div className="space-y-2">
            {d.cashbackTransactions.map(t => (
              <div key={t.id} className="flex items-center justify-between border rounded-lg px-3 py-2 text-sm">
                <div>
                  <div className="font-medium capitalize">{t.type}</div>
                  <div className="text-xs text-gray-500">
                    {new Date(t.createdAt).toLocaleString('pt-BR')}
                    {t.description && ` • ${t.description}`}
                  </div>
                </div>
                <div className={`font-bold ${
                  t.type === 'credit' || t.type === 'reversal' ? 'text-green-700'
                  : t.type === 'redeem' ? 'text-red-700'
                  : 'text-gray-500'
                }`}>
                  {t.type === 'credit' || t.type === 'reversal' ? '+' : t.type === 'redeem' || t.type === 'expiration' ? '-' : ''}
                  {fmtMoney(t.valueCents)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA Endereços
// ══════════════════════════════════════════════════════════════════════════
function EnderecosTab({ d, onUpdate }: { d: CustomerDetail; onUpdate: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    type: 'residential', isPrimary: false, cep: '', street: '', number: '',
    complement: '', district: '', city: '', state: '',
  });
  const [busy, setBusy] = useState(false);
  const [cepLoading, setCepLoading] = useState(false);
  const [cepError, setCepError] = useState<string | null>(null);

  /**
   * Lookup ViaCEP (API pública gratuita). Quando CEP tem 8 dígitos completos,
   * busca rua/bairro/cidade/UF e preenche AUTO. Não sobrescreve o que o usuário
   * já digitou manualmente — só preenche campos vazios.
   */
  async function lookupCep(cepRaw: string) {
    const clean = cepRaw.replace(/\D/g, '');
    if (clean.length !== 8) return;
    setCepLoading(true);
    setCepError(null);
    try {
      const r = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
      const data = await r.json();
      if (data?.erro) {
        setCepError('CEP não encontrado');
        return;
      }
      setForm((prev) => ({
        ...prev,
        // Só preenche se o user não digitou nada — preserva edição manual
        street: prev.street || data.logradouro || '',
        district: prev.district || data.bairro || '',
        city: prev.city || data.localidade || '',
        state: prev.state || (data.uf || '').toUpperCase(),
      }));
    } catch {
      setCepError('Falha ao buscar CEP — preencha manualmente');
    } finally {
      setCepLoading(false);
    }
  }

  /** Onchange do campo CEP — formata e dispara lookup ao completar 8 dígitos */
  function onCepChange(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 8);
    // Formata 12345-678 enquanto digita
    const formatted = digits.length > 5
      ? `${digits.slice(0, 5)}-${digits.slice(5)}`
      : digits;
    setForm((prev) => ({ ...prev, cep: formatted }));
    if (digits.length === 8) lookupCep(digits);
  }

  async function submit() {
    setBusy(true);
    try {
      await api(`/customers-crm/${d.id}/addresses`, { method: 'POST', body: JSON.stringify(form) });
      setShowForm(false);
      setForm({ type: 'residential', isPrimary: false, cep: '', street: '', number: '', complement: '', district: '', city: '', state: '' });
      setCepError(null);
      onUpdate();
    } catch (e: any) {
      alert(`Falha: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {d.addresses.length === 0 && !showForm && (
        <div className="text-sm text-gray-400 italic text-center py-6">Nenhum endereço cadastrado.</div>
      )}

      {d.addresses.map(a => (
        <div key={a.id} className="border rounded-lg p-4 text-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase font-medium text-gray-500 flex items-center gap-1">
              <MapPin className="w-3 h-3" /> {a.type}
              {a.isPrimary && <span className="ml-2 px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Principal</span>}
            </span>
            <span className="text-xs text-gray-400">{a.cep ?? '—'}</span>
          </div>
          <div className="text-gray-700">
            {a.street}{a.number && `, ${a.number}`}{a.complement && ` - ${a.complement}`}<br/>
            {a.district && `${a.district}, `}{a.city}/{a.state}
          </div>
        </div>
      ))}

      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          className="w-full bg-purple-100 hover:bg-purple-200 text-purple-800 px-4 py-2 rounded-lg font-medium flex items-center justify-center gap-2"
        >
          <Plus className="w-4 h-4" /> Adicionar endereço
        </button>
      ) : (
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 space-y-3">
          <h3 className="font-medium">Novo endereço</h3>
          <div className="grid grid-cols-2 gap-2">
            <select value={form.type} onChange={e => setForm({...form, type: e.target.value})} className="border rounded px-2 py-1.5">
              <option value="residential">Residencial</option>
              <option value="delivery">Entrega</option>
              <option value="mailing">Mala direta</option>
              <option value="work">Trabalho</option>
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.isPrimary} onChange={e => setForm({...form, isPrimary: e.target.checked})} />
              Endereço principal
            </label>
            <div className="relative">
              <input
                value={form.cep}
                onChange={(e) => onCepChange(e.target.value)}
                placeholder="CEP"
                inputMode="numeric"
                className={`border rounded px-2 py-1.5 w-full font-mono ${
                  cepError ? 'border-rose-400 bg-rose-50' : ''
                }`}
              />
              {cepLoading && (
                <Loader2 className="w-4 h-4 animate-spin text-purple-600 absolute right-2 top-2.5" />
              )}
            </div>
            <input value={form.state} onChange={e => setForm({...form, state: e.target.value.toUpperCase()})} placeholder="UF" maxLength={2} className="border rounded px-2 py-1.5 uppercase" />
            {cepError && (
              <div className="col-span-2 text-xs text-rose-600">⚠ {cepError}</div>
            )}
            <input value={form.street} onChange={e => setForm({...form, street: e.target.value})} placeholder="Rua" className="border rounded px-2 py-1.5 col-span-2" />
            <input value={form.number} onChange={e => setForm({...form, number: e.target.value})} placeholder="Número" className="border rounded px-2 py-1.5" />
            <input value={form.complement} onChange={e => setForm({...form, complement: e.target.value})} placeholder="Complemento" className="border rounded px-2 py-1.5" />
            <input value={form.district} onChange={e => setForm({...form, district: e.target.value})} placeholder="Bairro" className="border rounded px-2 py-1.5" />
            <input value={form.city} onChange={e => setForm({...form, city: e.target.value})} placeholder="Cidade" className="border rounded px-2 py-1.5" />
          </div>
          <div className="flex gap-2">
            <button onClick={submit} disabled={busy} className="bg-purple-700 hover:bg-purple-800 text-white px-4 py-2 rounded font-medium disabled:opacity-50">
              {busy ? 'Salvando...' : 'Salvar'}
            </button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 border rounded">Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA LGPD — consentimentos por canal
// ══════════════════════════════════════════════════════════════════════════
function LgpdTab({ d, onUpdate }: { d: CustomerDetail; onUpdate: () => void }) {
  const channels: Array<{ key: string; label: string }> = [
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'email',    label: 'E-mail' },
    { key: 'sms',      label: 'SMS' },
    { key: 'mail',     label: 'Mala direta física' },
    { key: 'general',  label: 'Termo geral do programa' },
  ];

  async function toggle(channel: string, granted: boolean) {
    try {
      await api(`/customers-crm/${d.id}/consents`, {
        method: 'POST',
        body: JSON.stringify({ channel, granted, source: 'crm-ui' }),
      });
      onUpdate();
    } catch (e: any) {
      alert(`Falha: ${e.message}`);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 mb-2">
        Cada mudança gera nova linha no histórico. Nenhum opt-in/opt-out é apagado.
      </p>
      {channels.map(c => {
        const granted = d.currentConsents[c.key];
        return (
          <div key={c.key} className="flex items-center justify-between border rounded-lg px-4 py-3">
            <div className="flex items-center gap-3">
              {granted
                ? <ShieldCheck className="w-5 h-5 text-green-600" />
                : <ShieldOff className="w-5 h-5 text-gray-400" />}
              <div>
                <div className="font-medium">{c.label}</div>
                <div className="text-xs text-gray-500">
                  Status atual: <span className={granted ? 'text-green-700 font-medium' : 'text-gray-500'}>
                    {granted ? 'Aceito' : (granted === false ? 'Revogado' : 'Não registrado')}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => toggle(c.key, true)} className="text-xs px-3 py-1 rounded border border-green-500 text-green-700 hover:bg-green-50">
                Opt-in
              </button>
              <button onClick={() => toggle(c.key, false)} className="text-xs px-3 py-1 rounded border border-red-500 text-red-700 hover:bg-red-50">
                Opt-out
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// ABA Tags
// ══════════════════════════════════════════════════════════════════════════
function TagsTab({ d, onUpdate }: { d: CustomerDetail; onUpdate: () => void }) {
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Tag[]>('/customers-crm/tags').then(setAllTags).catch(() => {});
  }, []);

  const customerTagIds = new Set(d.tags.map(t => t.id));

  async function toggle(tagId: string, apply: boolean) {
    setBusy(true);
    try {
      if (apply) {
        await api(`/customers-crm/${d.id}/tags/${tagId}`, { method: 'POST', body: '{}' });
      } else {
        await api(`/customers-crm/${d.id}/tags/${tagId}`, { method: 'DELETE' });
      }
      onUpdate();
    } catch (e: any) {
      alert(`Falha: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Tags aplicadas</h3>
        {d.tags.length === 0 ? (
          <div className="text-sm text-gray-400 italic">Nenhuma tag aplicada.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {d.tags.map(t => (
              <span
                key={t.id}
                className="px-3 py-1 rounded-full text-sm flex items-center gap-2 border"
                style={{ backgroundColor: t.color + '22', borderColor: t.color, color: t.color }}
              >
                <TagIcon className="w-3 h-3" /> {t.name}
                <button onClick={() => toggle(t.id, false)} disabled={busy} className="hover:opacity-70">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2">Aplicar tag</h3>
        <div className="flex flex-wrap gap-2">
          {allTags.filter(t => !customerTagIds.has(t.id)).map(t => (
            <button
              key={t.id}
              onClick={() => toggle(t.id, true)}
              disabled={busy}
              className="px-3 py-1 rounded-full text-sm border hover:opacity-80 flex items-center gap-1"
              style={{ borderColor: t.color, color: t.color }}
            >
              <Plus className="w-3 h-3" /> {t.name}
            </button>
          ))}
          {allTags.length === 0 && (
            <span className="text-sm text-gray-400 italic">Cadastre tags primeiro pela API.</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Modal Criar
// ══════════════════════════════════════════════════════════════════════════
function CreateCustomerModal({
  onClose,
  onCreated,
}: { onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({
    name: '', cpf: '', whatsapp: '', email: '', birthDate: '',
    sizeDefault: '', originSource: 'physical',
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!form.name.trim()) { alert('Nome é obrigatório'); return; }
    setBusy(true);
    try {
      const res = await api<{ id: string }>('/customers-crm', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          cpf: form.cpf || undefined,
          whatsapp: form.whatsapp || undefined,
          email: form.email || undefined,
          birthDate: form.birthDate || undefined,
          sizeDefault: form.sizeDefault || undefined,
          originSource: form.originSource,
        }),
      });
      onCreated(res.id);
    } catch (e: any) {
      alert(`Falha: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">Cadastrar cliente</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-500" /></button>
        </div>
        <div className="space-y-3">
          <input value={form.name} onChange={e => setForm({...form, name: e.target.value})}
            placeholder="Nome completo *" className="w-full border rounded px-3 py-2" />
          <div className="grid grid-cols-2 gap-2">
            <input value={form.cpf} onChange={e => setForm({...form, cpf: e.target.value})}
              placeholder="CPF" className="border rounded px-3 py-2" />
            <input value={form.birthDate} onChange={e => setForm({...form, birthDate: e.target.value})}
              placeholder="Nascimento" type="date" className="border rounded px-3 py-2" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input value={form.whatsapp} onChange={e => setForm({...form, whatsapp: e.target.value})}
              placeholder="WhatsApp" className="border rounded px-3 py-2" />
            <input value={form.sizeDefault} onChange={e => setForm({...form, sizeDefault: e.target.value})}
              placeholder="Manequim (44/46/48...)" className="border rounded px-3 py-2" />
          </div>
          <input value={form.email} onChange={e => setForm({...form, email: e.target.value})}
            placeholder="E-mail" type="email" className="w-full border rounded px-3 py-2" />
          <select value={form.originSource} onChange={e => setForm({...form, originSource: e.target.value})}
            className="w-full border rounded px-3 py-2">
            <option value="physical">Loja física</option>
            <option value="woo">E-commerce (WooCommerce)</option>
            <option value="instagram">Instagram</option>
            <option value="giga">Importado do Giga</option>
            <option value="manual">Manual</option>
          </select>
        </div>
        <div className="mt-5 flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded">Cancelar</button>
          <button onClick={submit} disabled={busy}
            className="bg-purple-700 hover:bg-purple-800 text-white px-4 py-2 rounded font-medium disabled:opacity-50">
            {busy ? 'Salvando...' : 'Cadastrar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Componentes utilitários
// ══════════════════════════════════════════════════════════════════════════
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs uppercase font-medium text-gray-500 mb-2 pb-1 border-b">{title}</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">{children}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm text-gray-900">
        {value && value !== '—' ? value : <span className="text-gray-400 italic">—</span>}
      </div>
    </div>
  );
}
        