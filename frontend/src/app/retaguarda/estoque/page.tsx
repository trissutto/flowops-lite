'use client';

/**
 * /retaguarda/estoque
 *
 * Espelho de estoque das 5 lojas migradas. Sync manual do Wincred.
 * Pré-requisito da Fase 5 (cut-over): garantir que o Postgres tem dados
 * consistentes pra PDV virar fonte de verdade.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Search, Database, Loader2, CheckCircle2, AlertCircle, History } from 'lucide-react';
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

type SyncRow = {
  storeCode: string;
  totalSkus: number;
  inserted: number;
  updated: number;
  sameQty: number;
  durationMs: number;
  error?: string;
};

export default function EstoquePage() {
  const router = useRouter();
  const [managedStores, setManagedStores] = useState<string[]>([]);
  const [summary, setSummary] = useState<StoreSummary[]>([]);
  const [selectedStore, setSelectedStore] = useState<string>('');
  const [searchSku, setSearchSku] = useState('');
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<SyncRow[] | null>(null);

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

  const syncAll = async () => {
    if (!confirm('Sincronizar TODAS as 5 lojas do Wincred? Pode demorar até 1 minuto.')) return;
    setSyncing('all');
    setSyncResult(null);
    try {
      const r = await api<{ lojas: SyncRow[] }>('/admin/stock-mirror/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setSyncResult(r.lojas || []);
      await loadSummary();
      await loadRows();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || 'falhou'));
    } finally {
      setSyncing(null);
    }
  };

  const syncOne = async (storeCode: string) => {
    setSyncing(storeCode);
    setSyncResult(null);
    try {
      const r = await api<{ lojas: SyncRow[] }>('/admin/stock-mirror/sync', {
        method: 'POST',
        body: JSON.stringify({ storeCodes: [storeCode] }),
      });
      setSyncResult(r.lojas || []);
      await loadSummary();
      if (selectedStore === storeCode) await loadRows();
    } catch (e: any) {
      alert('Erro: ' + (e?.message || 'falhou'));
    } finally {
      setSyncing(null);
    }
  };

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
              Fase 2 da migração — independência do Giga em 5 lojas
            </p>
          </div>
          <button
            onClick={syncAll}
            disabled={syncing !== null}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {syncing === 'all'
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Sincronizando...</>
              : <><RefreshCw className="w-4 h-4" /> Sync TUDO do Giga</>
            }
          </button>
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
                <button
                  onClick={(e) => { e.stopPropagation(); syncOne(s.storeCode); }}
                  disabled={syncing !== null}
                  className="mt-2 w-full px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-[10px] font-bold disabled:opacity-50"
                >
                  {syncing === s.storeCode
                    ? <Loader2 className="w-3 h-3 inline animate-spin" />
                    : '🔄 Sync esta'
                  }
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Resultado do último sync */}
        {syncResult && (
          <section className="bg-emerald-50 border border-emerald-300 rounded-xl p-4">
            <div className="font-bold text-emerald-900 mb-2 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> Sync concluído
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
              {syncResult.map((s) => (
                <div key={s.storeCode} className={`p-2 rounded border ${
                  s.error ? 'bg-rose-50 border-rose-300' : 'bg-white border-emerald-200'
                }`}>
                  <div className="font-bold">{s.storeCode}</div>
                  {s.error ? (
                    <div className="text-rose-700 mt-1 text-[10px]">{s.error}</div>
                  ) : (
                    <>
                      <div>{s.totalSkus} SKUs em {(s.durationMs / 1000).toFixed(1)}s</div>
                      <div className="text-[10px] text-slate-600 mt-1">
                        🆕 {s.inserted} · 🔄 {s.updated} · ✓ {s.sameQty}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

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
              Nenhum SKU encontrado. Sincronize a loja pra popular o estoque local.
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
          <div>1. Botão <strong>Sync TUDO</strong> baixa o estoque atual do Wincred pra essas 5 lojas no PostgreSQL.</div>
          <div>2. Cada mudança é logada em <code>stock_movements</code> pra auditoria.</div>
          <div>3. Sync é manual hoje. Vai virar cron 4x/dia na Fase 5.</div>
          <div>4. PDV ainda lê do Giga pra venda. Vai virar fonte única (PostgreSQL) no cut-over 30/06.</div>
        </div>
      </main>
    </div>
  );
}
