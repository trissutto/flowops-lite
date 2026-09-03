'use client';

/**
 * /retaguarda/estoque
 *
 * Espelho de estoque — só consulta. O Flow (Postgres) é a fonte do estoque
 * desde 14/07; o MySQL do Giga foi desligado e o sync manual saiu da tela
 * em 09/26 (o endpoint POST /admin/stock-mirror/sync morreu junto).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Search, Database, Loader2, History } from 'lucide-react';
import { api } from '@/lib/api';

type StoreSummary = {
  storeCode: string;
  managed: boolean;
  totalSkus: number;
  totalQty: number;
  lastSync: string | null;
};

type StockRow = {
  id: string;
  storeCode: string;
  sku: string;
  qty: number;
  syncedAt: string;
  updatedAt: string;
};

// O tipo SyncRow morreu junto com o sync manual (09/26): o MySQL do Giga foi
// desligado — o Flow é a fonte do estoque e não há mais de onde puxar.

export default function EstoquePage() {
  const router = useRouter();
  const [managedStores, setManagedStores] = useState<string[]>([]);
  const [summary, setSummary] = useState<StoreSummary[]>([]);
  const [selectedStore, setSelectedStore] = useState<string>('');
  const [searchSku, setSearchSku] = useState('');
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) router.push('/login');
  }, [router]);

  const loadSummary = async () => {
    try {
      const r = await api<{ managedStores: string[]; lojas: StoreSummary[] }>(
        '/admin/stock-mirror/summary',
      );
      setManagedStores(r.managedStores || []);
      setSummary(r.lojas || []);
      if (!selectedStore && r.lojas?.[0]) setSelectedStore(r.lojas[0].storeCode);
    } catch (e: any) {
      console.error(e);
    }
  };

  useEffect(() => { loadSummary(); }, []); // eslint-disable-line

  const loadRows = async () => {
    if (!selectedStore) return;
    setLoadingRows(true);
    try {
      const q = new URLSearchParams({ storeCode: selectedStore });
      if (searchSku.trim()) q.set('sku', searchSku.trim());
      if (onlyAvailable) q.set('onlyAvailable', '1');
      const data = await api<StockRow[]>(`/admin/stock-mirror/list?${q}`);
      setRows(data || []);
    } catch (e: any) {
      console.error(e);
    } finally {
      setLoadingRows(false);
    }
  };

  useEffect(() => { loadRows(); }, [selectedStore, onlyAvailable]); // eslint-disable-line

  // syncAll/syncOne (POST /admin/stock-mirror/sync) foram removidos em 09/26:
  // o endpoint morreu junto com o MySQL do Giga — esta tela é só consulta.

  const fmtDate = (iso: string | null) => {
    if (!iso) return 'nunca';
    const d = new Date(iso);
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `${min}min atrás`;
    if (min < 1440) return `${Math.floor(min / 60)}h atrás`;
    return d.toLocaleDateString('pt-BR');
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/retaguarda" className="p-2 rounded hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="font-bold text-lg flex items-center gap-2">
              <Database className="w-5 h-5" /> Espelho de Estoque (PostgreSQL)
            </h1>
            <p className="text-xs text-slate-500">
              Consulta do espelho — o Flow é a fonte do estoque; o Giga foi desligado
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* Cards das 5 lojas */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2">
            Lojas gerenciadas ({managedStores.length})
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {summary.map((s) => (
              <div
                key={s.storeCode}
                className={`rounded-xl border-2 p-3 cursor-pointer transition ${
                  selectedStore === s.storeCode
                    ? 'bg-blue-50 border-blue-400'
                    : 'bg-white border-slate-200 hover:border-blue-300'
                }`}
                onClick={() => setSelectedStore(s.storeCode)}
              >
                <div className="font-bold">{s.storeCode}</div>
                <div className="text-2xl font-black tabular-nums my-1">{s.totalSkus.toLocaleString('pt-BR')}</div>
                <div className="text-[10px] text-slate-500">SKUs cadastrados</div>
                <div className="text-xs text-slate-600 mt-1">
                  Total: <strong>{s.totalQty.toLocaleString('pt-BR')}</strong> peças
                </div>
                <div className="text-[10px] text-slate-400 mt-1">
                  Último sync: {fmtDate(s.lastSync)}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Lista de SKUs */}
        <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-3 flex-wrap">
            <div className="font-bold flex-1">
              {selectedStore ? `Estoque ${selectedStore}` : 'Selecione uma loja'}
              <span className="text-xs text-slate-500 ml-2">({rows.length} resultado{rows.length === 1 ? '' : 's'})</span>
            </div>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchSku}
                onChange={(e) => setSearchSku(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadRows()}
                placeholder="Buscar SKU..."
                className="pl-9 pr-3 py-2 border border-slate-300 rounded text-sm w-56"
              />
            </div>
            <label className="text-xs flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={onlyAvailable}
                onChange={(e) => setOnlyAvailable(e.target.checked)}
              />
              Só com estoque
            </label>
            <button
              onClick={loadRows}
              className="px-3 py-2 border border-slate-300 hover:bg-slate-50 rounded text-sm"
            >
              Buscar
            </button>
          </div>

          {loadingRows ? (
            <div className="p-8 text-center text-slate-500">
              <Loader2 className="w-6 h-6 animate-spin mx-auto" />
              <div className="text-sm mt-2">Carregando...</div>
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              Nenhum SKU no espelho pra esse filtro.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 sticky top-0 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">SKU</th>
                    <th className="px-3 py-2 text-right">Qtd</th>
                    <th className="px-3 py-2 text-left">Último sync</th>
                    <th className="px-3 py-2 text-left">Última mudança</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id} className={`hover:bg-slate-50 ${r.qty === 0 ? 'bg-rose-50/30 text-slate-400' : ''}`}>
                      <td className="px-3 py-1.5 font-mono">{r.sku}</td>
                      <td className={`px-3 py-1.5 text-right font-bold tabular-nums ${
                        r.qty === 0 ? 'text-rose-600' : 'text-emerald-700'
                      }`}>
                        {r.qty}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-slate-500">{fmtDate(r.syncedAt)}</td>
                      <td className="px-3 py-1.5 text-xs text-slate-500">{fmtDate(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Info */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900 space-y-1">
          <div className="font-bold flex items-center gap-1">
            <History className="w-3 h-3" /> Como funciona
          </div>
          <div>1. O <strong>Flow (PostgreSQL)</strong> é a fonte do estoque — o Giga foi desligado e o sync manual morreu junto.</div>
          <div>2. Cada mudança é logada em <code>stock_movements</code> pra auditoria.</div>
        </div>
      </main>
    </div>
  );
}
