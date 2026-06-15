'use client';

/**
 * /retaguarda/divergencias
 *
 * Compara totais Wincred (MySQL) vs Mirror (Postgres). Tres blocos:
 *  1. Cards de totais (produtos / estoque) com diff
 *  2. Estado do sync incremental (cron 10min) — quando rodou, status, idade
 *  3. Sample de produtos com estoque divergente (mostra W vs M vs diff)
 *
 * Por que existe: antes do cut-over 30/06 precisamos VER que Mirror == Wincred.
 * Se diff>0 persistente, sync incremental tem bug e precisa rodar full sync.
 */

import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, CheckCircle2, RefreshCw, Database, Clock } from 'lucide-react';

interface Divergencias {
  totaisProdutos: { wincred: number; mirror: number; diff: number };
  totaisEstoque: { wincred: number; mirror: number; diff: number };
  syncState: Array<{
    tabela: string;
    lastRunAt: string | null;
    lastDataAlt: string | null;
    lastStatus: string | null;
    lastRowCount: number | null;
    ageMin: number | null;
  }>;
  sampleDiffEstoque: Array<{
    codigo: string;
    loja: string;
    wincred: number;
    mirror: number;
    diff: number;
  }>;
}

function getApiBase() {
  if (typeof window === 'undefined') return process.env.NEXT_PUBLIC_API_URL || '';
  return process.env.NEXT_PUBLIC_API_URL || '';
}

function getToken() {
  try {
    return (
      window.sessionStorage.getItem('flowops_token') ||
      window.localStorage.getItem('flowops_token') ||
      ''
    );
  } catch {
    return '';
  }
}

export default function DivergenciasPage() {
  const [data, setData] = useState<Divergencias | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastFetchMs, setLastFetchMs] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const t0 = Date.now();
    try {
      const r = await fetch(`${getApiBase()}/admin/wincred-mirror/divergencias`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const j = await r.json();
      setData(j);
      setLastFetchMs(Date.now() - t0);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runIncremental() {
    setSyncing(true);
    try {
      const r = await fetch(`${getApiBase()}/admin/wincred-mirror/sync/incremental`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const j = await r.json();
      alert(
        `Sync incremental OK\n\nProdutos atualizados: ${j.produtosAtualizados}\nEstoque atualizado: ${j.estoqueAtualizado}\nDuracao: ${j.durationMs}ms`,
      );
      await load();
    } catch (e: any) {
      alert(`Erro: ${e?.message || e}`);
    } finally {
      setSyncing(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000); // refresh 1min
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-600" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="bg-white border border-red-200 rounded-xl p-6 max-w-md w-full shadow">
          <div className="flex items-center gap-2 text-red-700 font-bold mb-2">
            <AlertTriangle className="w-5 h-5" />
            Erro ao carregar
          </div>
          <p className="text-sm text-slate-700 mb-3">{error}</p>
          <button
            onClick={load}
            className="w-full bg-slate-800 hover:bg-slate-900 text-white font-bold py-2 rounded-lg"
          >
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const diffProdOk = Math.abs(data.totaisProdutos.diff) < 100;
  const diffEstOk = Math.abs(data.totaisEstoque.diff) < 1000;

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <Database className="w-7 h-7 text-emerald-600" />
              Divergencias Wincred vs Mirror
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Comparativo das tabelas espelhadas. Atualiza a cada 1min.
              {lastFetchMs != null && (
                <span className="ml-2 text-xs text-slate-400">({lastFetchMs}ms)</span>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={runIncremental}
              disabled={syncing}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold px-4 py-2 rounded-lg flex items-center gap-2"
            >
              {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Sync Incremental
            </button>
            <button
              onClick={load}
              className="bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold px-4 py-2 rounded-lg flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              Atualizar
            </button>
          </div>
        </div>

        {/* Cards totais */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <CardTotal
            label="Produtos (PLUS SIZE)"
            wincred={data.totaisProdutos.wincred}
            mirror={data.totaisProdutos.mirror}
            diff={data.totaisProdutos.diff}
            ok={diffProdOk}
          />
          <CardTotal
            label="Estoque (linhas codigo+loja)"
            wincred={data.totaisEstoque.wincred}
            mirror={data.totaisEstoque.mirror}
            diff={data.totaisEstoque.diff}
            ok={diffEstOk}
          />
        </div>

        {/* Estado do sync */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm mb-6">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
            <Clock className="w-5 h-5 text-slate-500" />
            <h2 className="font-bold text-slate-800">Estado do sync incremental</h2>
            <span className="ml-2 text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-600">
              cron: a cada 10 min
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">Tabela</th>
                <th className="text-left px-4 py-2">Ultimo run</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-right px-4 py-2">Linhas</th>
                <th className="text-left px-4 py-2">Janela DATAALT</th>
                <th className="text-right px-4 py-2">Idade (min)</th>
              </tr>
            </thead>
            <tbody>
              {data.syncState.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-6 text-slate-400">
                    Sync incremental ainda nao rodou. Clique &quot;Sync Incremental&quot; ou aguarde o cron.
                  </td>
                </tr>
              ) : (
                data.syncState.map((s) => (
                  <tr key={s.tabela} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono text-xs">{s.tabela}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString('pt-BR') : '—'}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs font-bold px-2 py-0.5 rounded ${
                          s.lastStatus === 'OK'
                            ? 'bg-emerald-100 text-emerald-700'
                            : s.lastStatus === 'FAIL'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {s.lastStatus || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{s.lastRowCount ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {s.lastDataAlt ? new Date(s.lastDataAlt).toLocaleDateString('pt-BR') : '—'}
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-mono text-xs ${
                        s.ageMin != null && s.ageMin > 30 ? 'text-red-600 font-bold' : 'text-slate-600'
                      }`}
                    >
                      {s.ageMin ?? '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Sample diff estoque */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
            <AlertTriangle
              className={`w-5 h-5 ${
                data.sampleDiffEstoque.length === 0 ? 'text-emerald-500' : 'text-amber-500'
              }`}
            />
            <h2 className="font-bold text-slate-800">
              Divergencias de estoque (sample 30 produtos com DATAALT recente)
            </h2>
            <span className="ml-2 text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-600">
              {data.sampleDiffEstoque.length} linhas divergentes
            </span>
          </div>
          {data.sampleDiffEstoque.length === 0 ? (
            <div className="text-center py-8 text-emerald-700">
              <CheckCircle2 className="w-10 h-10 mx-auto mb-2" />
              <p className="font-bold">Tudo batendo!</p>
              <p className="text-sm text-slate-600 mt-1">
                Wincred e Mirror identicos pros 30 produtos mais recentes.
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Codigo</th>
                  <th className="text-left px-4 py-2">Loja</th>
                  <th className="text-right px-4 py-2">Wincred</th>
                  <th className="text-right px-4 py-2">Mirror</th>
                  <th className="text-right px-4 py-2">Diff</th>
                </tr>
              </thead>
              <tbody>
                {data.sampleDiffEstoque.slice(0, 50).map((r, i) => (
                  <tr key={`${r.codigo}-${r.loja}-${i}`} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono text-xs">{r.codigo}</td>
                    <td className="px-4 py-2 font-mono">{r.loja}</td>
                    <td className="px-4 py-2 text-right font-mono">{r.wincred}</td>
                    <td className="px-4 py-2 text-right font-mono">{r.mirror}</td>
                    <td
                      className={`px-4 py-2 text-right font-mono font-bold ${
                        r.diff > 0 ? 'text-amber-700' : 'text-red-700'
                      }`}
                    >
                      {r.diff > 0 ? `+${r.diff}` : r.diff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer legenda */}
        <div className="mt-4 text-xs text-slate-500 px-2">
          <p>
            <span className="font-bold">Como interpretar:</span> diff &gt; 0 = Wincred tem mais peca que Mirror
            (sync ficou pra tras). diff &lt; 0 = Mirror tem mais peca que Wincred (peca vendida no Wincred
            ainda nao replicou). Idade do sync (min) &gt; 30 indica cron com problema — investigar logs.
          </p>
        </div>
      </div>
    </div>
  );
}

function CardTotal({
  label,
  wincred,
  mirror,
  diff,
  ok,
}: {
  label: string;
  wincred: number;
  mirror: number;
  diff: number;
  ok: boolean;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
      <div className="text-xs font-bold uppercase text-slate-500 mb-2">{label}</div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-[10px] text-slate-500">WINCRED</div>
          <div className="text-2xl font-bold text-slate-800">{wincred.toLocaleString('pt-BR')}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500">MIRROR</div>
          <div className="text-2xl font-bold text-emerald-700">{mirror.toLocaleString('pt-BR')}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500">DIFF</div>
          <div
            className={`text-2xl font-bold ${
              ok ? 'text-emerald-700' : Math.abs(diff) > wincred * 0.05 ? 'text-red-700' : 'text-amber-700'
            }`}
          >
            {diff > 0 ? '+' : ''}
            {diff.toLocaleString('pt-BR')}
          </div>
        </div>
      </div>
      <div className="mt-2 text-xs">
        {ok ? (
          <span className="text-emerald-700 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Dentro da tolerancia
          </span>
        ) : (
          <span className="text-amber-700 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Acima da tolerancia — rodar sync incremental
          </span>
        )}
      </div>
    </div>
  );
}
