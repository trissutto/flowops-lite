'use client';

/**
 * /retaguarda/wincred-mirror
 *
 * Tela admin pra disparar e monitorar o sync das 6 tabelas espelho do
 * Wincred no Postgres. Mostra contagens (PG vs MySQL), ultimo sync e
 * botoes pra rodar sync por tabela ou full.
 *
 * Onda 1.3 da migracao Wincred -> Flowops.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Database, RefreshCw, Play, Loader2, CheckCircle2,
  AlertTriangle, Clock,
} from 'lucide-react';
import { api } from '@/lib/api';

type TableStatus = {
  name: string;
  countPostgres: number;
  countWincred: number | null;
  lastSyncedAt: string | null;
  ageMin: number | null;
};

type StatusResp = { tables: TableStatus[] };

type SyncResult = {
  table: string;
  success: boolean;
  processed: number;
  durationMs: number;
  error?: string;
};

const TABLE_LABELS: Record<string, string> = {
  produtos: 'Produtos',
  estoque: 'Estoque por loja',
  grupos: 'Grupos',
  subgrupos: 'Subgrupos',
  fornecedores: 'Fornecedores',
  codigos: 'Codigos (sequencia)',
};

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('pt-BR');
}

function fmtAge(min: number | null): string {
  if (min == null) return 'nunca';
  if (min < 60) return `${min} min atras`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h atras`;
  return `${Math.floor(h / 24)}d atras`;
}

export default function WincredMirrorPage() {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [results, setResults] = useState<SyncResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<StatusResp>('/admin/wincred-mirror/status');
      setStatus(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  // Etapa em execução no sync background (mostrada no botão: "produtos...")
  const [bgCurrent, setBgCurrent] = useState<string | null>(null);

  /**
   * SYNC COMPLETO em BACKGROUND (02/07): o POST responde na hora ("started")
   * e o servidor roda sozinho — antes a requisição segurava o sync inteiro
   * e, com 352k produtos, estourava o timeout do proxy ("Failed to fetch")
   * matando o processo no meio. Aqui a tela fica fazendo poll do progresso
   * (leve, a cada 4s) até terminar.
   */
  const syncAllBackground = async () => {
    if (syncing) return;
    setSyncing('all');
    setError(null);
    setResults([]);
    try {
      const start = await api<{ started: boolean; alreadyRunning: boolean }>(
        '/admin/wincred-mirror/sync/all',
        { method: 'POST' },
      );
      if (!start.started && start.alreadyRunning) {
        setError('Já existe um sync em andamento — acompanhando o progresso dele.');
      }
      // Poll do progresso até terminar (máx ~20min de guarda)
      const t0 = Date.now();
      while (Date.now() - t0 < 20 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 4000));
        try {
          const p = await api<{
            running: boolean; current: string | null; results: SyncResult[]; error: string | null;
          }>('/admin/wincred-mirror/sync/progress');
          setBgCurrent(p.current);
          setResults(p.results || []);
          if (!p.running) {
            if (p.error) setError(`Sync abortado: ${p.error}`);
            break;
          }
        } catch { /* rede piscou — tenta no próximo tick */ }
      }
      await loadStatus();
    } catch (e: any) {
      setError(e?.message || 'Erro ao iniciar o sync');
    } finally {
      setSyncing(null);
      setBgCurrent(null);
    }
  };

  const sync = async (label: string, endpoint: string) => {
    if (syncing) return;
    if (label === 'all') return syncAllBackground();
    setSyncing(label);
    setError(null);
    try {
      const r = await api<SyncResult | { total: SyncResult[]; durationMs: number }>(
        endpoint,
        { method: 'POST' },
      );
      if ((r as any).total) {
        setResults((r as any).total);
      } else {
        setResults([r as SyncResult]);
      }
      await loadStatus();
    } catch (e: any) {
      setError(e?.message || 'Erro no sync');
    } finally {
      setSyncing(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-100 text-slate-500">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white flex items-center justify-center shadow">
          <Database className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Wincred Mirror</h1>
          <p className="text-sm text-slate-500">
            Espelho das 6 tabelas Wincred no Postgres. <b>Somente leitura</b> no Wincred.
          </p>
        </div>
        <Link
          href="/retaguarda/divergencias"
          className="px-3 py-2 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 text-sm font-bold flex items-center gap-1"
          title="Comparar Wincred vs Mirror"
        >
          <AlertTriangle className="w-4 h-4" />
          Divergencias
        </Link>
        <button
          onClick={loadStatus}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 disabled:opacity-50"
          title="Recarregar"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm text-red-800">{error}</div>
        </div>
      )}

      {/* Acao principal: sync full */}
      <div className="bg-gradient-to-br from-violet-50 to-purple-50 border border-violet-200 rounded-xl p-5 flex items-center gap-4">
        <div>
          <h2 className="font-bold text-violet-900 mb-1">Sync Completo</h2>
          <p className="text-xs text-violet-700">
            Roda sync das 6 tabelas na ordem ideal (pequenas primeiro, produtos+estoque por ultimo). Demora 1-3 minutos.
          </p>
        </div>
        <button
          onClick={() => sync('all', '/admin/wincred-mirror/sync/all')}
          disabled={!!syncing}
          className="ml-auto shrink-0 px-5 py-3 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-bold flex items-center gap-2 shadow disabled:opacity-50"
        >
          {syncing === 'all' ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Sincronizando{bgCurrent ? ` ${bgCurrent}` : ''}...</>
          ) : (
            <><Play className="w-4 h-4" /> Rodar Sync Completo</>
          )}
        </button>
      </div>

      {/* Teste rapido: peek de uma REF no Postgres */}
      <PeekRefBox />

      {/* Status por tabela */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
          <h2 className="font-bold text-slate-800">Status por tabela</h2>
        </div>
        {loading && !status ? (
          <div className="p-10 text-center text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
            Carregando...
          </div>
        ) : status ? (
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2 text-left text-[10px] uppercase font-bold text-slate-600">Tabela</th>
                <th className="px-4 py-2 text-right text-[10px] uppercase font-bold text-slate-600">Postgres</th>
                <th className="px-4 py-2 text-right text-[10px] uppercase font-bold text-slate-600">Wincred</th>
                <th className="px-4 py-2 text-right text-[10px] uppercase font-bold text-slate-600">Diff</th>
                <th className="px-4 py-2 text-left text-[10px] uppercase font-bold text-slate-600">Ultima Sync</th>
                <th className="px-4 py-2 text-center text-[10px] uppercase font-bold text-slate-600">Acao</th>
              </tr>
            </thead>
            <tbody>
              {status.tables.map((t) => {
                const diff = t.countWincred != null ? t.countWincred - t.countPostgres : null;
                const isSyncing = syncing === t.name || syncing === 'all';
                return (
                  <tr key={t.name} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="px-4 py-2 font-bold text-slate-800">{TABLE_LABELS[t.name] ?? t.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtNum(t.countPostgres)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">{fmtNum(t.countWincred)}</td>
                    <td className={`px-4 py-2 text-right tabular-nums font-bold ${
                      diff === 0 ? 'text-emerald-600' :
                      diff != null && Math.abs(diff) > 10 ? 'text-red-600' :
                      'text-amber-600'
                    }`}>
                      {diff != null ? (diff > 0 ? `+${fmtNum(diff)}` : fmtNum(diff)) : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500 flex items-center gap-1.5">
                      <Clock className="w-3 h-3" />
                      {fmtAge(t.ageMin)}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <button
                        onClick={() => sync(t.name, `/admin/wincred-mirror/sync/${t.name}`)}
                        disabled={!!syncing}
                        className="px-2 py-1 rounded bg-violet-100 hover:bg-violet-200 text-violet-700 text-xs font-bold disabled:opacity-50"
                        title={`Re-sync so ${t.name}`}
                      >
                        {isSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        ) : null}
      </div>

      {/* Resultados do ultimo sync */}
      {results.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 bg-emerald-50">
            <h2 className="font-bold text-emerald-900 flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" />
              Resultado do ultimo sync
            </h2>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-2 text-left text-[10px] uppercase font-bold text-slate-600">Tabela</th>
                <th className="px-4 py-2 text-center text-[10px] uppercase font-bold text-slate-600">Status</th>
                <th className="px-4 py-2 text-right text-[10px] uppercase font-bold text-slate-600">Linhas</th>
                <th className="px-4 py-2 text-right text-[10px] uppercase font-bold text-slate-600">Duracao</th>
                <th className="px-4 py-2 text-left text-[10px] uppercase font-bold text-slate-600">Erro</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.table} className="border-b border-slate-100">
                  <td className="px-4 py-2 font-bold text-slate-800">{TABLE_LABELS[r.table] ?? r.table}</td>
                  <td className="px-4 py-2 text-center">
                    {r.success ? (
                      <span className="text-emerald-600 font-bold">OK</span>
                    ) : (
                      <span className="text-red-600 font-bold">FALHOU</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtNum(r.processed)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">{r.durationMs}ms</td>
                  <td className="px-4 py-2 text-xs text-red-600">{r.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}


function PeekRefBox() {
  const [ref, setRef] = useState('VLM-222');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await api(`/admin/wincred-mirror/peek?ref=${encodeURIComponent(ref)}`);
      setResult(r);
    } catch (e: any) {
      setError(e?.message || 'erro');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="font-bold text-amber-900">Debug: Testar REF no Postgres</h2>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="VLM-222"
          className="px-3 py-2 border border-amber-300 rounded-lg text-sm w-48"
        />
        <button
          onClick={run}
          disabled={loading || !ref.trim()}
          className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold disabled:opacity-50"
        >
          {loading ? 'Buscando...' : 'Testar'}
        </button>
      </div>
      {error && <div className="mt-2 text-sm text-red-700">{error}</div>}
      {result && (
        <pre className="mt-3 bg-slate-900 text-emerald-300 p-3 rounded text-[11px] overflow-x-auto font-mono">
{JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
