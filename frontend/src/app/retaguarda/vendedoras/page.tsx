'use client';

/**
 * /retaguarda/vendedoras
 *
 * Lista de funcionarias com prontuario RH. Mostra: nome, loja, funcao,
 * WhatsApp, registro, ATIVA/DESLIGADA. Clica → /retaguarda/vendedoras/[id]
 * (prontuario completo com dados pessoais, contrato, ferias, documentos).
 *
 * Soft-delete via active=false. Cadastro rapido no topo. Edicao detalhada
 * dentro do prontuario.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Plus, Users, Search, ChevronRight, Power,
} from 'lucide-react';
import { api } from '@/lib/api';

type Cargo = 'VENDEDORA' | 'LIDER_B' | 'LIDER_A' | 'GERENTE_B' | 'GERENTE_A';

const CARGO_LABELS: Record<string, string> = {
  VENDEDORA: 'Vendedora',
  LIDER_B: 'Líder B',
  LIDER_A: 'Líder A',
  GERENTE_B: 'Gerente B',
  GERENTE_A: 'Gerente A',
};

const CARGO_COLORS: Record<string, string> = {
  VENDEDORA: 'bg-emerald-100 text-emerald-700',
  LIDER_B: 'bg-blue-100 text-blue-700',
  LIDER_A: 'bg-blue-200 text-blue-800',
  GERENTE_B: 'bg-violet-100 text-violet-700',
  GERENTE_A: 'bg-violet-200 text-violet-800',
};

type Seller = {
  id: string;
  name: string;
  whatsapp: string | null;
  active: boolean;
  createdAt: string;
  cargo?: string;
  cargoFuncao?: string | null;
  storeCodeOrigin?: string | null;
  responsibleStoreId?: string | null;
  dataAdmissao?: string | null;
  wincredCodigo?: string | null;
};

type Store = { id: string; code: string; name: string; active: boolean };

const fmtDate = (s?: string | null) => {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('pt-BR');
  } catch {
    return '—';
  }
};

const fmtPhone = (p?: string | null) => {
  if (!p) return '—';
  const d = p.replace(/\D/g, '');
  if (d.length === 13) return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  return p;
};

export default function VendedorasPage() {
  const router = useRouter();
  const [items, setItems] = useState<Seller[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(true);  // ATIVO + INATIVO por default
  const [search, setSearch] = useState('');
  const [filterStore, setFilterStore] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('active');

  const [togglingId, setTogglingId] = useState<string | null>(null);
  // Edição inline de LOJA/FUNÇÃO direto na lista (sem abrir o prontuário)
  const [savingCell, setSavingCell] = useState<string | null>(null); // `${id}:loja` | `${id}:cargo`

  const load = async () => {
    setLoading(true);
    try {
      const [sl, st] = await Promise.all([
        api<Seller[]>('/sellers?includeInactive=1'),
        api<Store[]>('/stores'),
      ]);
      setItems(Array.isArray(sl) ? sl : []);
      setStores(st.filter((x) => x.active).sort((a, b) => a.code.localeCompare(b.code)));
    } catch (err: any) {
      if (String(err?.message || '').includes('401')) {
        router.push('/login');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleAtivo(seller: Seller, e: React.MouseEvent) {
    e.stopPropagation();  // nao abre prontuario
    const msg = seller.active
      ? `DESLIGAR "${seller.name}"?\n\nVai sumir do PDV. Histórico de vendas dela fica preservado.`
      : `Reativar "${seller.name}"?`;
    if (!confirm(msg)) return;
    setTogglingId(seller.id);
    try {
      await api(`/sellers/${seller.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !seller.active }),
      });
      // Atualiza local sem refazer load (mais fluido)
      setItems((prev) =>
        prev.map((x) => (x.id === seller.id ? { ...x, active: !x.active } : x)),
      );
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setTogglingId(null);
    }
  }

  /** Troca a LOJA inline. Grava storeCodeOrigin sempre; líder/gerente também
   *  passa a responder pela loja escolhida (responsibleStoreId). */
  async function changeLoja(seller: Seller, code: string) {
    const store = stores.find((st) => st.code === code) || null;
    const cargo = seller.cargo || 'VENDEDORA';
    const body: any = { storeCodeOrigin: code || null };
    if (cargo !== 'VENDEDORA') body.responsibleStoreId = store?.id || null;
    setSavingCell(`${seller.id}:loja`);
    try {
      await api(`/sellers/${seller.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setItems((prev) =>
        prev.map((x) =>
          x.id === seller.id
            ? { ...x, storeCodeOrigin: code || null, responsibleStoreId: cargo !== 'VENDEDORA' ? (store?.id || null) : x.responsibleStoreId }
            : x,
        ),
      );
    } catch (e: any) {
      alert('Erro ao trocar loja: ' + (e?.message || e));
    } finally {
      setSavingCell(null);
    }
  }

  /** Troca a FUNÇÃO inline. Virou líder/gerente → responde pela loja atual;
   *  virou vendedora → backend zera responsibleStoreId (mantém a loja de origem). */
  async function changeCargo(seller: Seller, cargo: Cargo) {
    const respStore = stores.find((st) => st.id === seller.responsibleStoreId);
    const lojaCode = respStore?.code || seller.storeCodeOrigin || null;
    const lojaStore = lojaCode ? stores.find((st) => st.code === lojaCode) || null : null;
    const body: any = { cargo };
    if (cargo !== 'VENDEDORA' && lojaStore) body.responsibleStoreId = lojaStore.id;
    // Virando vendedora, preserva a loja visível como origem (o backend zera o responsible)
    if (cargo === 'VENDEDORA' && !seller.storeCodeOrigin && lojaCode) body.storeCodeOrigin = lojaCode;
    setSavingCell(`${seller.id}:cargo`);
    try {
      await api(`/sellers/${seller.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setItems((prev) =>
        prev.map((x) =>
          x.id === seller.id
            ? {
                ...x,
                cargo,
                responsibleStoreId: cargo === 'VENDEDORA' ? null : (lojaStore?.id || x.responsibleStoreId),
                storeCodeOrigin: x.storeCodeOrigin || lojaCode,
              }
            : x,
        ),
      );
    } catch (e: any) {
      alert('Erro ao trocar função: ' + (e?.message || e));
    } finally {
      setSavingCell(null);
    }
  }

  // Indexa loja por code pra mostrar nome
  const storeByCode = new Map<string, Store>();
  for (const s of stores) storeByCode.set(s.code, s);

  const countByStore = new Map<string, number>();
  for (const s of items) {
    if (s.storeCodeOrigin) {
      countByStore.set(s.storeCodeOrigin, (countByStore.get(s.storeCodeOrigin) || 0) + 1);
    }
  }

  const filtered = items.filter((s) => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterStore) {
      const respStore = stores.find((st) => st.id === s.responsibleStoreId);
      if (s.storeCodeOrigin !== filterStore && respStore?.code !== filterStore) return false;
    }
    if (filterStatus === 'active' && !s.active) return false;
    if (filterStatus === 'inactive' && s.active) return false;
    return true;
  });

  const activeCount = items.filter((s) => s.active).length;
  const inactiveCount = items.filter((s) => !s.active).length;

  return (
    <div className="min-h-screen pastel-page">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-6xl mx-auto">
          <Link href="/retaguarda" className="p-2 hover:bg-white/10 rounded">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <Users className="w-6 h-6" />
          <div className="flex-1">
            <h1 className="text-xl font-bold">Funcionárias</h1>
            <p className="text-xs text-white/80">
              Prontuário RH: contrato, férias, documentos, comissão
            </p>
          </div>
          <button onClick={load} className="p-2 hover:bg-white/10 rounded">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-4 space-y-4">
        {/* CTA Nova funcionária */}
        <div className="bg-gradient-to-br from-emerald-500 to-teal-600 text-white rounded-xl p-5 shadow flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center">
            <Plus className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <h2 className="font-bold text-lg">Cadastrar nova funcionária</h2>
            <p className="text-sm text-white/90">
              Dados pessoais, contrato, comissão. CEP auto-preenche endereço.
            </p>
          </div>
          <Link
            href="/retaguarda/vendedoras/nova"
            className="bg-white text-emerald-700 hover:bg-emerald-50 font-bold px-5 py-3 rounded-lg shadow flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Nova funcionária
          </Link>
        </div>

        {/* Filtros */}
        <div className="flex gap-2 flex-wrap items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar funcionária..."
              className="w-full pl-9 pr-3 py-2 border rounded-lg"
            />
          </div>
          <select
            value={filterStore}
            onChange={(e) => setFilterStore(e.target.value)}
            className="px-3 py-2 border rounded-lg bg-white font-bold text-sm min-w-[220px]"
          >
            <option value="">Todas as lojas ({items.length})</option>
            {stores.map((st) => {
              const count = countByStore.get(st.code) || 0;
              return (
                <option key={st.id} value={st.code}>
                  {st.code} {st.name} ({count})
                </option>
              );
            })}
          </select>
          <div className="flex bg-slate-100 rounded-lg p-1 gap-1">
            <button
              onClick={() => setFilterStatus('active')}
              className={`px-3 py-1.5 rounded text-xs font-bold ${
                filterStatus === 'active' ? 'bg-emerald-600 text-white shadow' : 'text-slate-600'
              }`}
            >
              Ativas ({activeCount})
            </button>
            <button
              onClick={() => setFilterStatus('inactive')}
              className={`px-3 py-1.5 rounded text-xs font-bold ${
                filterStatus === 'inactive' ? 'bg-slate-600 text-white shadow' : 'text-slate-600'
              }`}
            >
              Desligadas ({inactiveCount})
            </button>
            <button
              onClick={() => setFilterStatus('all')}
              className={`px-3 py-1.5 rounded text-xs font-bold ${
                filterStatus === 'all' ? 'bg-slate-800 text-white shadow' : 'text-slate-600'
              }`}
            >
              Todas
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-500">{filtered.length} mostrando</p>

        {/* Lista */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Nome</th>
                <th className="text-left px-3 py-2">Loja</th>
                <th className="text-left px-3 py-2">Função</th>
                <th className="text-left px-3 py-2">WhatsApp</th>
                <th className="text-left px-3 py-2">Registro</th>
                <th className="text-center px-3 py-2">Status</th>
                <th className="text-center px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const cargo = (s.cargo as Cargo) || 'VENDEDORA';
                const respStore = stores.find((st) => st.id === s.responsibleStoreId);
                const lojaShow = respStore?.code || s.storeCodeOrigin || null;
                const lojaInfo = lojaShow ? storeByCode.get(lojaShow) : null;
                return (
                  <tr
                    key={s.id}
                    onClick={() => router.push(`/retaguarda/vendedoras/${s.id}`)}
                    className={`border-t border-slate-100 hover:bg-emerald-50/50 cursor-pointer transition ${
                      !s.active ? 'opacity-50' : ''
                    }`}
                  >
                    <td className="px-3 py-2 font-bold">
                      {s.name}
                      {s.wincredCodigo && (
                        <span className="ml-1 text-[10px] text-slate-400 font-mono">
                          #{s.wincredCodigo}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={lojaShow || ''}
                        disabled={savingCell === `${s.id}:loja`}
                        onChange={(e) => changeLoja(s, e.target.value)}
                        className={`text-xs border border-slate-200 rounded-lg px-1.5 py-1 bg-white hover:border-emerald-400 cursor-pointer max-w-[180px] ${
                          savingCell === `${s.id}:loja` ? 'opacity-50' : ''
                        }`}
                        title="Trocar a loja direto aqui"
                      >
                        <option value="">—</option>
                        {stores.map((st) => (
                          <option key={st.id} value={st.code}>
                            {st.code} {st.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={cargo}
                        disabled={savingCell === `${s.id}:cargo`}
                        onChange={(e) => changeCargo(s, e.target.value as Cargo)}
                        className={`text-xs font-bold rounded-lg px-1.5 py-1 border border-slate-200 cursor-pointer uppercase ${CARGO_COLORS[cargo] || 'bg-slate-100 text-slate-600'} ${
                          savingCell === `${s.id}:cargo` ? 'opacity-50' : ''
                        }`}
                        title="Trocar a função direto aqui"
                      >
                        {(Object.keys(CARGO_LABELS) as Cargo[]).map((c) => (
                          <option key={c} value={c}>
                            {CARGO_LABELS[c]}
                          </option>
                        ))}
                      </select>
                      {s.cargoFuncao && (
                        <div className="text-[10px] text-slate-500 mt-0.5">{s.cargoFuncao}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{fmtPhone(s.whatsapp)}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {fmtDate(s.dataAdmissao || s.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={(e) => toggleAtivo(s, e)}
                        disabled={togglingId === s.id}
                        className={`text-xs font-bold px-2.5 py-1 rounded flex items-center gap-1 mx-auto disabled:opacity-50 ${
                          s.active
                            ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                            : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                        }`}
                        title={s.active ? 'Clique pra DESLIGAR' : 'Clique pra REATIVAR'}
                      >
                        <Power className="w-3 h-3" />
                        {s.active ? 'ATIVA' : 'DESLIGADA'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-center text-slate-400">
                      <ChevronRight className="w-4 h-4" />
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-slate-400 text-sm">
                    Nenhuma funcionária com esse filtro
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>
    </div>
  );
}
