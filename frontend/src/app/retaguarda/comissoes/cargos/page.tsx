'use client';

/**
 * /retaguarda/comissoes/cargos
 *
 * Atribui CARGO + LOJA RESPONSAVEL pras vendedoras. Define quem é
 * vendedora pura (% sobre vendas proprias) e quem e lider/gerente
 * (% sobre loja toda que responde).
 *
 * Vinculado a F4 — modelo Lurd's de comissao.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Save, Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api';

type Cargo = 'VENDEDORA' | 'LIDER_B' | 'LIDER_A' | 'GERENTE_B' | 'GERENTE_A';

const CARGOS: { value: Cargo; label: string; pct: string; color: string }[] = [
  { value: 'VENDEDORA', label: 'Vendedora', pct: '2% próprias', color: 'bg-emerald-100 text-emerald-700' },
  { value: 'LIDER_B',   label: 'Líder B',   pct: '0,5% loja',   color: 'bg-blue-100 text-blue-700' },
  { value: 'LIDER_A',   label: 'Líder A',   pct: '1,0% loja',   color: 'bg-blue-200 text-blue-800' },
  { value: 'GERENTE_B', label: 'Gerente B', pct: '1,5% loja',   color: 'bg-violet-100 text-violet-700' },
  { value: 'GERENTE_A', label: 'Gerente A', pct: '2,0% loja',   color: 'bg-violet-200 text-violet-800' },
];

type Seller = {
  id: string;
  name: string;
  active: boolean;
  cargo?: Cargo | string;
  responsibleStoreId?: string | null;
};

type Store = { id: string; code: string; name: string; active: boolean };

export default function CargosPage() {
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  async function load() {
    setLoading(true);
    try {
      const [se, st] = await Promise.all([
        api<Seller[]>('/sellers'),
        api<Store[]>('/stores'),
      ]);
      setSellers(se.sort((a, b) => a.name.localeCompare(b.name)));
      setStores(st.filter((s) => s.active).sort((a, b) => a.code.localeCompare(b.code)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function setCargo(seller: Seller, cargo: Cargo) {
    setSavingId(seller.id);
    try {
      await api(`/sellers/${seller.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ cargo }),
      });
      setSellers((prev) =>
        prev.map((s) =>
          s.id === seller.id
            ? { ...s, cargo, responsibleStoreId: cargo === 'VENDEDORA' ? null : s.responsibleStoreId }
            : s,
        ),
      );
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setSavingId(null);
    }
  }

  async function setStoreResp(seller: Seller, storeId: string) {
    setSavingId(seller.id);
    try {
      await api(`/sellers/${seller.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ responsibleStoreId: storeId || null }),
      });
      setSellers((prev) =>
        prev.map((s) => (s.id === seller.id ? { ...s, responsibleStoreId: storeId || null } : s)),
      );
    } catch (e: any) {
      alert('Erro: ' + (e?.message || e));
    } finally {
      setSavingId(null);
    }
  }

  const filtered = search
    ? sellers.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
    : sellers;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link
          href="/retaguarda/comissoes"
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
          title="Voltar"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cargos das Vendedoras</h1>
          <p className="text-sm text-slate-500">
            Define cargo + loja que cada uma responde. Líder/Gerente ganham % sobre a loja toda.
          </p>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar vendedora..."
          className="w-full pl-9 pr-3 py-2 border rounded-lg"
        />
      </div>

      {loading ? (
        <Loader2 className="w-6 h-6 animate-spin mx-auto" />
      ) : (
        <div className="bg-white border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-600">
              <tr>
                <th className="text-left px-3 py-2 w-1/3">Vendedora</th>
                <th className="text-left px-3 py-2">Cargo</th>
                <th className="text-left px-3 py-2 w-1/4">Loja responsável</th>
                <th className="text-center px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const cargo = (s.cargo as Cargo) || 'VENDEDORA';
                const isResp = cargo !== 'VENDEDORA';
                return (
                  <tr key={s.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-bold">{s.name}</td>
                    <td className="px-3 py-2">
                      <select
                        value={cargo}
                        onChange={(e) => setCargo(s, e.target.value as Cargo)}
                        disabled={savingId === s.id}
                        className="px-2 py-1 border rounded text-xs disabled:opacity-50"
                      >
                        {CARGOS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label} ({c.pct})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      {isResp ? (
                        <select
                          value={s.responsibleStoreId || ''}
                          onChange={(e) => setStoreResp(s, e.target.value)}
                          disabled={savingId === s.id}
                          className="px-2 py-1 border rounded text-xs disabled:opacity-50 w-full"
                        >
                          <option value="">— escolha loja —</option>
                          {stores.map((st) => (
                            <option key={st.id} value={st.id}>
                              {st.code} {st.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {savingId === s.id && (
                        <Loader2 className="w-4 h-4 animate-spin text-slate-400 mx-auto" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
