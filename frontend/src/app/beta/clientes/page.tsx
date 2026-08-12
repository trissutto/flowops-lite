'use client';

import { FormEvent, Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ChevronDown, ChevronLeft, ChevronRight, Loader2, MessageCircle, Plus, RefreshCw,
  Search, SlidersHorizontal, Store, Trash2, Users, X,
} from 'lucide-react';
import { api } from '@/lib/api';

interface Customer {
  id: string;
  name: string | null;
  nameSocial: string | null;
  cpf: string | null;
  whatsapp: string | null;
  vipTier: string;
  cashbackBalanceCents: number;
  orderCount: number;
  ltvCents: string;
  lastOrderAt: string | null;
  originStore: { id: string; code: string; name: string } | null;
  targetStore: { id: string; code: string; name: string } | null;
  origins: CustomerOrigin[];
}

interface CustomerOrigin {
  id: string; name: string | null; nameSocial: string | null; cpf: string | null;
  whatsapp: string | null; originSource: string | null;
  originStore: { id: string; code: string; name: string } | null;
  targetStore: { id: string; code: string; name: string } | null;
  orderCount: number; ltvCents: string; lastOrderAt: string | null; updatedAt: string;
}

interface ListResponse { data: Customer[]; total: number; page: number; limit: number }
interface Me { role: string }
interface StoreOption { id: string; code: string; name: string }

const LIMIT = 50;
const tierLabel: Record<string, string> = {
  bronze: 'Bronze', prata: 'Prata', silver: 'Prata', ouro: 'Ouro', gold: 'Ouro',
  diamante: 'Diamante', diamond: 'Diamante',
};

function money(cents: number | string) {
  return (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function phone(value: string | null) {
  if (!value) return 'Não informado';
  const digits = value.replace(/\D/g, '').replace(/^55/, '');
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  return value;
}

function dateLabel(value: string | null) {
  if (!value) return 'Sem compras';
  const date = new Date(value);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days > 1 && days < 30) return `Há ${days} dias`;
  return date.toLocaleDateString('pt-BR');
}

function BetaClientesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isMatrix, setIsMatrix] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteOrigin, setDeleteOrigin] = useState<CustomerOrigin | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '');
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [storeId, setStoreId] = useState(searchParams.get('storeId') || '');
  const [tier, setTier] = useState(searchParams.get('tier') || '');
  const [hasWhatsapp, setHasWhatsapp] = useState(searchParams.get('hasWhatsapp') === '1');
  const [hasCashback, setHasCashback] = useState(searchParams.get('hasCashback') === '1');
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get('page')) || 1));

  useEffect(() => {
    api<Me>('/auth/me').then((me) => {
      const matrix = me.role === 'admin' || me.role === 'operator';
      setIsMatrix(matrix);
      setIsAdmin(me.role === 'admin');
      if (matrix) api<StoreOption[]>('/stores').then(setStores).catch(() => setStores([]));
    }).catch(() => setIsMatrix(false));
  }, []);

  const queryString = useMemo(() => {
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    if (storeId) query.set('storeId', storeId);
    if (tier) query.set('tier', tier);
    if (hasWhatsapp) query.set('hasWhatsapp', '1');
    if (hasCashback) query.set('hasCashback', '1');
    if (page > 1) query.set('page', String(page));
    return query.toString();
  }, [hasCashback, hasWhatsapp, page, search, storeId, tier]);

  useEffect(() => {
    window.history.replaceState({}, '', queryString ? `/beta/clientes?${queryString}` : '/beta/clientes');
  }, [queryString]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
    if (search) query.set('search', search);
    if (storeId && isMatrix) query.set('storeId', storeId);
    if (tier) query.set('tier', tier);
    if (hasWhatsapp) query.set('hasWhatsapp', 'true');
    if (hasCashback) query.set('hasCashbackBalance', 'true');
    try {
      const response = await api<ListResponse>(`/customers-crm/beta-list?${query}`);
      setCustomers(response.data);
      setTotal(response.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível carregar os clientes.');
    } finally {
      setLoading(false);
    }
  }, [hasCashback, hasWhatsapp, isMatrix, page, search, storeId, tier]);

  useEffect(() => { void load(); }, [load]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  function clearFilters() {
    setSearch(''); setSearchInput(''); setStoreId(''); setTier('');
    setHasWhatsapp(false); setHasCashback(false); setPage(1);
  }

  function openCustomer(id: string) {
    const returnTo = queryString ? `/beta/clientes?${queryString}` : '/beta/clientes';
    router.push(`/beta/clientes/${id}?returnTo=${encodeURIComponent(returnTo)}`);
  }

  async function confirmDelete() {
    if (!deleteOrigin) return;
    setDeleting(true);
    try {
      await api(`/customers-crm/beta-duplicates/${deleteOrigin.id}`, { method: 'DELETE' });
      setNotice('Duplicidade retirada da ficha. O histórico foi preservado para auditoria.');
      setDeleteOrigin(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível excluir a duplicidade.');
    } finally {
      setDeleting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const activeFilters = [storeId, tier, hasWhatsapp, hasCashback].filter(Boolean).length;

  return (
    <main className="mx-auto w-full max-w-[1480px] px-5 py-7 lg:px-8">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[13px] text-[#6D6B64]">
            <Users className="h-4 w-4" /> Clientes
          </div>
          <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-[#24231F]">Clientes</h1>
          <p className="mt-1 text-sm text-[#6D6B64]">Uma única base para lojas, site, PDV e vendas ao vivo.</p>
        </div>
        <div className="flex items-center gap-2">
          {isMatrix && <a href="/clientes-crm/sincronizacao" className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#CFCFC9] bg-white px-3.5 text-sm font-medium text-[#34332F] shadow-sm hover:bg-[#F5F5F2]"><RefreshCw className="h-4 w-4" /> Sincronizações</a>}
          <a href="/clientes-crm?create=1" className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#30302E] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#1F1F1D]"><Plus className="h-4 w-4" /> Cadastrar cliente</a>
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-[#DDDCD7] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        {notice && <div className="flex items-center justify-between border-b border-[#B9DDC3] bg-[#F1FAF3] px-4 py-3 text-sm text-[#25643A]"><span>{notice}</span><button onClick={() => setNotice('')}><X className="h-4 w-4" /></button></div>}
        <div className="border-b border-[#E5E4DF] px-4 pt-3">
          <div className="flex items-center gap-6">
            <button className="border-b-2 border-[#24231F] px-1 pb-3 text-sm font-semibold text-[#24231F]">Todos</button>
            <span className="pb-3 text-sm text-[#77756F]">{total.toLocaleString('pt-BR')} clientes</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 border-b border-[#E5E4DF] p-4">
          <form onSubmit={submitSearch} className="relative min-w-[260px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#77756F]" />
            <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Buscar por nome, CPF ou WhatsApp" className="h-10 w-full rounded-lg border border-[#CFCFC9] bg-white pl-9 pr-3 text-sm text-[#24231F] outline-none focus:border-[#8C7325] focus:ring-2 focus:ring-[#D4AF37]/20" />
          </form>
          <button onClick={() => setFiltersOpen(!filtersOpen)} className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#CFCFC9] px-3.5 text-sm font-medium text-[#34332F] hover:bg-[#F5F5F2]"><SlidersHorizontal className="h-4 w-4" /> Filtros {activeFilters > 0 && <span className="rounded-full bg-[#24231F] px-1.5 text-xs text-white">{activeFilters}</span>}</button>
          {(search || activeFilters > 0) && <button onClick={clearFilters} className="inline-flex h-10 items-center gap-1 px-2 text-sm text-[#6D6B64] hover:text-[#24231F]"><X className="h-4 w-4" /> Limpar</button>}
        </div>

        {filtersOpen && <div className="grid gap-3 border-b border-[#E5E4DF] bg-[#FAFAF8] p-4 sm:grid-cols-2 lg:grid-cols-4">
          {isMatrix && <label className="text-xs font-medium text-[#5D5B55]">Loja<select value={storeId} onChange={(e) => { setStoreId(e.target.value); setPage(1); }} className="mt-1.5 h-10 w-full rounded-lg border border-[#CFCFC9] bg-white px-3 text-sm"><option value="">Todas as lojas</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.code} · {store.name}</option>)}</select></label>}
          <label className="text-xs font-medium text-[#5D5B55]">Categoria<select value={tier} onChange={(e) => { setTier(e.target.value); setPage(1); }} className="mt-1.5 h-10 w-full rounded-lg border border-[#CFCFC9] bg-white px-3 text-sm"><option value="">Todas</option><option value="bronze">Bronze</option><option value="prata">Prata</option><option value="ouro">Ouro</option><option value="diamante">Diamante</option></select></label>
          <label className="flex h-10 items-center gap-2 self-end rounded-lg border border-[#CFCFC9] bg-white px-3 text-sm text-[#34332F]"><input type="checkbox" checked={hasWhatsapp} onChange={(e) => { setHasWhatsapp(e.target.checked); setPage(1); }} className="accent-[#24231F]" /> Com WhatsApp</label>
          <label className="flex h-10 items-center gap-2 self-end rounded-lg border border-[#CFCFC9] bg-white px-3 text-sm text-[#34332F]"><input type="checkbox" checked={hasCashback} onChange={(e) => { setHasCashback(e.target.checked); setPage(1); }} className="accent-[#24231F]" /> Com saldo de cashback</label>
        </div>}

        {error ? <div className="m-4 rounded-lg border border-[#E3B6B0] bg-[#FFF4F2] p-4 text-sm text-[#8A332A]">Falha ao carregar clientes: {error} <button onClick={() => void load()} className="ml-2 font-semibold underline">Tentar novamente</button></div> :
        loading ? <div className="flex min-h-[360px] items-center justify-center gap-2 text-sm text-[#6D6B64]"><Loader2 className="h-5 w-5 animate-spin" /> Carregando clientes...</div> :
        customers.length === 0 ? <div className="flex min-h-[360px] flex-col items-center justify-center text-center"><Users className="mb-3 h-9 w-9 text-[#AAA8A1]" /><p className="font-medium text-[#34332F]">Nenhum cliente encontrado</p><p className="mt-1 text-sm text-[#77756F]">Ajuste os filtros ou faça um novo cadastro.</p></div> :
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1020px] border-collapse text-left">
            <thead className="bg-[#F7F7F5] text-[12px] font-semibold uppercase tracking-wide text-[#6D6B64]"><tr><th className="px-5 py-3">Cliente</th><th className="px-4 py-3">Contato</th><th className="px-4 py-3">Loja de relacionamento</th><th className="px-4 py-3">Categoria</th><th className="px-4 py-3 text-right">Pedidos</th><th className="px-4 py-3 text-right">Total gasto</th><th className="px-4 py-3">Última compra</th><th className="w-10 px-3 py-3" /></tr></thead>
            <tbody>{customers.map((customer) => {
              const store = customer.targetStore || customer.originStore;
              const expanded = expandedId === customer.id;
              return <Fragment key={customer.id}>
                <tr onClick={() => openCustomer(customer.id)} className="cursor-pointer border-t border-[#ECEBE7] text-sm hover:bg-[#F8F8F5]">
                  <td className="px-5 py-3.5"><div className="font-semibold text-[#24231F]">{customer.nameSocial || customer.name || 'Cliente sem nome'}</div><div className="mt-0.5 text-xs text-[#85827B]">{customer.cpf || 'CPF não informado'}</div></td>
                  <td className="px-4 py-3.5"><div className="flex items-center gap-1.5 text-[#34332F]"><MessageCircle className="h-3.5 w-3.5 text-[#77756F]" /> {phone(customer.whatsapp)}</div></td>
                  <td className="px-4 py-3.5"><div className="flex items-center gap-1.5 text-[#34332F]"><Store className="h-3.5 w-3.5 text-[#8C7325]" /> {store ? `${store.code} · ${store.name}` : 'Não definida'}</div></td>
                  <td className="px-4 py-3.5"><span className="inline-flex rounded-full border border-[#D8D6CF] bg-[#F6F5F1] px-2.5 py-1 text-xs font-medium text-[#504E48]">{tierLabel[customer.vipTier?.toLowerCase()] || customer.vipTier || 'Bronze'}</span></td>
                  <td className="px-4 py-3.5 text-right tabular-nums text-[#34332F]">{customer.orderCount}</td>
                  <td className="px-4 py-3.5 text-right font-semibold tabular-nums text-[#2E7D46]">{money(customer.ltvCents)}</td>
                  <td className="px-4 py-3.5 text-[#5D5B55]">{dateLabel(customer.lastOrderAt)}</td>
                  <td className="px-3 py-3.5"><button onClick={(event) => { event.stopPropagation(); setExpandedId(expanded ? null : customer.id); }} title="Ver cadastros vinculados" className="rounded-md p-1.5 hover:bg-[#EDECE7]"><ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} /></button></td>
                </tr>
                {expanded && <tr className="border-t border-[#ECEBE7] bg-[#F8F8F5]"><td colSpan={8} className="px-5 py-4">
                  <div className="mb-3"><div className="text-sm font-semibold">{customer.origins.length} cadastros vinculados</div><div className="text-xs text-[#77756F]">Os totais acima são a soma destes registros.</div></div>
                  <div className="space-y-2">{customer.origins.map((origin) => { const originStore = origin.originStore || origin.targetStore; return <div key={origin.id} className="grid items-center gap-3 rounded-lg border border-[#DEDDD8] bg-white p-3 text-xs md:grid-cols-[1.4fr_1fr_.7fr_.7fr_auto]">
                    <div><div className="font-semibold">{origin.nameSocial || origin.name || 'Sem nome'}</div><div className="text-[#85827B]">{origin.cpf || 'CPF não informado'} · {origin.originSource || 'origem não informada'}</div></div>
                    <div className="flex items-center gap-1.5"><Store className="h-3.5 w-3.5 text-[#8C7325]" />{originStore ? `${originStore.code} · ${originStore.name}` : 'Loja não definida'}</div>
                    <div>{origin.orderCount} pedidos</div><div className="font-semibold text-[#2E7D46]">{money(origin.ltvCents)}</div>
                    {isAdmin && customer.origins.length > 1 ? <button onClick={() => setDeleteOrigin(origin)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#D9A9A3] px-3 py-2 font-semibold text-[#9A342B] hover:bg-[#FFF2F0]"><Trash2 className="h-3.5 w-3.5" /> Excluir duplicidade</button> : <span />}
                  </div>; })}</div>
                </td></tr>}
              </Fragment>;
            })}</tbody>
          </table>
        </div>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E5E4DF] px-5 py-4 text-sm text-[#6D6B64]">
          <span>{total === 0 ? '0 resultados' : `${((page - 1) * LIMIT + 1).toLocaleString('pt-BR')}–${Math.min(page * LIMIT, total).toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}`}</span>
          <div className="flex items-center gap-2"><button disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#CFCFC9] px-3 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /> Anterior</button><span className="px-2 text-xs">Página {page} de {totalPages}</span><button disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)} className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#CFCFC9] px-3 disabled:opacity-40">Próxima <ChevronRight className="h-4 w-4" /></button></div>
        </div>
      </section>
      {deleteOrigin && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"><div className="w-full max-w-md rounded-xl border border-[#DDDCD7] bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between"><div><h2 className="text-lg font-semibold">Excluir esta duplicidade?</h2><p className="mt-1 text-sm text-[#6D6B64]">A ficha principal e o histórico de vendas serão preservados.</p></div><button onClick={() => setDeleteOrigin(null)} disabled={deleting}><X className="h-5 w-5" /></button></div>
        <div className="rounded-lg bg-[#F7F7F5] p-4 text-sm"><div className="font-semibold">{deleteOrigin.nameSocial || deleteOrigin.name || 'Cliente sem nome'}</div><div className="mt-2 text-[#6D6B64]">Loja: {(deleteOrigin.originStore || deleteOrigin.targetStore)?.name || 'Não definida'}</div><div className="text-[#6D6B64]">Pedidos: {deleteOrigin.orderCount} · Total: {money(deleteOrigin.ltvCents)}</div></div>
        <div className="mt-5 flex justify-end gap-2"><button onClick={() => setDeleteOrigin(null)} disabled={deleting} className="rounded-lg border border-[#CFCFC9] px-4 py-2 text-sm font-medium">Cancelar</button><button onClick={() => void confirmDelete()} disabled={deleting} className="inline-flex items-center gap-2 rounded-lg bg-[#A33A31] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{deleting && <Loader2 className="h-4 w-4 animate-spin" />}Excluir duplicidade</button></div>
      </div></div>}
    </main>
  );
}

export default function BetaClientesPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-[#6D6B64]"><Loader2 className="h-5 w-5 animate-spin" /> Carregando clientes...</div>}>
      <BetaClientesContent />
    </Suspense>
  );
}
