'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '@/lib/api';
import {
  Search, Plus, Users, Filter, X, ChevronRight, Award, Wallet,
  Calendar, Phone, Mail, MapPin, Tag as TagIcon, ShieldCheck, ShieldOff,
  CheckCircle2, AlertCircle, Loader2, MessageCircle,
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

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────
const TIER_LABEL: Record<string, string> = {
  bronze: 'Bronze', prata: 'Prata', ouro: 'Ouro', diamante: 'Diamante',
};
const TIER_BG: Record<string, string> = {
  bronze:   'bg-orange-100 text-orange-800 border-orange-300',
  prata:    'bg-gray-100 text-gray-800 border-gray-300',
  ouro:     'bg-yellow-100 text-yellow-800 border-yellow-300',
  diamante: 'bg-cyan-100 text-cyan-800 border-cyan-300',
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
      const res = await api<ListResponse>(`/customers-crm?${q}`);
      setData(res.data);
      setTotal(res.total);
    } catch (e: any) {
      setError(`Falha ao carregar: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, tier, hasWhatsapp, hasCashbackBalance]);

  useEffect(() => { load(); }, [load]);

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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-7 h-7 text-purple-700" />
            Clientes CRM
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Base mestra de clientes (Giga + WooCommerce + Instagram + cadastros PDV)
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-purple-700 hover:bg-purple-800 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2 shadow-sm"
        >
          <Plus className="w-4 h-4" /> Cadastrar cliente
        </button>
      </div>

      {/* ── Stats rápidas ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard label="Clientes na base" value={total.toLocaleString('pt-BR')} icon={<Users className="w-5 h-5" />} />
        <StatCard label="Com WhatsApp"     value={data.filter(c => c.whatsapp).length.toLocaleString('pt-BR')} icon={<MessageCircle className="w-5 h-5" />} hint="(amostra exibida)" />
        <StatCard label="Com saldo cashback" value={data.filter(c => c.cashbackBalanceCents > 0).length.toLocaleString('pt-BR')} icon={<Wallet className="w-5 h-5" />} hint="(amostra exibida)" />
        <StatCard label="Tier Ouro+"       value={data.filter(c => c.vipTier === 'ouro' || c.vipTier === 'diamante').length.toLocaleString('pt-BR')} icon={<Award className="w-5 h-5" />} hint="(amostra exibida)" />
      </div>

      {/* ── Barra de busca + filtros ──────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-4 mb-4 shadow-sm">
        <form onSubmit={onSearchSubmit} className="flex gap-2 items-center">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              placeholder="Buscar por nome, CPF, WhatsApp, e-mail..."
              className="w-full pl-10 pr-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
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
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-700">Cliente</th>
                <th className="text-left px-4 py-3 font-medium text-gray-700">Contato</th>
                <th className="text-center px-4 py-3 font-medium text-gray-700">Tier</th>
                <th className="text-right px-4 py-3 font-medium text-gray-700">Cashback</th>
                <th className="text-center px-4 py-3 font-medium text-gray-700">Manequim</th>
                <th className="text-right px-4 py-3 font-medium text-gray-700">LTV</th>
                <th className="text-center px-4 py-3 font-medium text-gray-700">Última compra</th>
                <th className="text-center px-4 py-3 font-medium text-gray-700">Loja</th>
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
              {!loading && data.map(c => (
                <tr
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className="border-b hover:bg-purple-50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">
                      {c.nameSocial || c.name || <span className="italic text-gray-400">sem nome</span>}
                    </div>
                    <div className="text-xs text-gray-500">{c.cpf ?? 'sem CPF'}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {c.whatsapp && <div className="flex items-center gap-1"><Phone className="w-3 h-3" /> {fmtPhone(c.whatsapp)}</div>}
                    {c.email   && <div className="flex items-center gap-1 text-gray-500"><Mail className="w-3 h-3" /> {c.email}</div>}
                    {!c.whatsapp && !c.email && <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-full border font-medium ${TIER_BG[c.vipTier] ?? 'bg-gray-100'}`}>
                      {TIER_LABEL[c.vipTier] ?? c.vipTier}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {c.cashbackBalanceCents > 0
                      ? <span className="font-semibold text-green-700">{fmtMoney(c.cashbackBalanceCents)}</span>
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-xs">
                    {c.sizeDefault ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">
                    {Number(c.ltvCents) > 0 ? fmtMoney(c.ltvCents) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-gray-600">{fmtDate(c.lastOrderAt)}</td>
                  <td className="px-4 py-3 text-center text-xs text-gray-600">{c.originStore?.code ?? '—'}</td>
                  <td className="text-gray-400"><ChevronRight className="w-4 h-4" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Paginação */}
        {total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50 text-sm">
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
  const [tab, setTab] = useState<'perfil' | 'cashback' | 'enderecos' | 'lgpd' | 'tags'>('perfil');
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
            {(['perfil','cashback','enderecos','lgpd','tags'] as const).map(t => (
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

  async function submit() {
    setBusy(true);
    try {
      await api(`/customers-crm/${d.id}/addresses`, { method: 'POST', body: JSON.stringify(form) });
      setShowForm(false);
      setForm({ type: 'residential', isPrimary: false, cep: '', street: '', number: '', complement: '', district: '', city: '', state: '' });
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
            <input value={form.cep} onChange={e => setForm({...form, cep: e.target.value})} placeholder="CEP" className="border rounded px-2 py-1.5" />
            <input value={form.state} onChange={e => setForm({...form, state: e.target.value})} placeholder="UF" maxLength={2} className="border rounded px-2 py-1.5 uppercase" />
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
