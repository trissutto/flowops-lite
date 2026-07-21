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

      {/* Importação COMPLETA da tabela clientes do Giga (base da consulta
          nativa de clientes + crediário nativo). Botão pedido do dono 21/07. */}
      <ClientesGigaBox />

      {/* CREDIÁRIO NATIVO fase 1: importa o `movimento` INTEIRO (abertas e
          pagas) — a ficha da cliente passa a mostrar o crediário completo. */}
      <CrediarioNativoBox />

      {/* Teste rapido: peek de uma REF no Postgres */}
      <PeekRefBox />

      {/* Incidente DATAALT 13/07: corrigir a data na tabela NATIVA `product`
          (fonte do bipe com PRODUCT_NATIVE_READS=1) copiando do espelho já
          restaurado. Dry-run primeiro; execução só no segundo clique. */}
      <FixDataAltNativoBox />

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


/**
 * INCIDENTE DATAALT (13/07): a tabela nativa `product` guardou a data suja e o
 * bipe do PDV lê dela (PRODUCT_NATIVE_READS=1) — promo "Liquida antigos"
 * mostrava "Sem promo · 2026" em peça de 2023. Este box corrige copiando a
 * data DO ESPELHO (já restaurado do backup 12/07), SÓ nas linhas sujas.
 * Passo 1 (dry-run) mostra contagem+amostra sem escrever; passo 2 executa.
 */
function FixDataAltNativoBox() {
  const [loading, setLoading] = useState(false);
  const [dry, setDry] = useState<any | null>(null);
  const [done, setDone] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (executar: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api('/products-editor/restaurar-dataalt-nativo-espelho', {
        method: 'POST',
        body: JSON.stringify({ executar }),
      });
      if (executar) { setDone(r); setDry(null); }
      else { setDry(r); setDone(null); }
    } catch (e: any) {
      setError(e?.message || 'erro');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-rose-50 border border-rose-200 rounded-xl p-4">
      <h2 className="font-bold text-rose-900 mb-1">Incidente DATAALT — corrigir tabela nativa (bipe do PDV)</h2>
      <p className="text-xs text-rose-700 mb-3">
        Copia a data de cadastro do ESPELHO (restaurado do backup 12/07) pra tabela nativa
        `product`, só nas linhas com data ≥ 13/07 cujo espelho tem data anterior. Não toca no
        Giga nem em datas já corretas. Rode o dry-run primeiro.
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => run(false)}
          disabled={loading}
          className="px-4 py-2 rounded-lg border border-rose-400 text-rose-700 text-sm font-bold hover:bg-rose-100 disabled:opacity-50"
        >
          {loading ? 'Verificando…' : '1. Ver o que seria corrigido (dry-run)'}
        </button>
        <button
          onClick={() => run(true)}
          disabled={loading || !dry?.candidatos}
          className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold disabled:opacity-50"
        >
          2. Executar correção{dry?.candidatos ? ` (${dry.candidatos} linhas)` : ''}
        </button>
      </div>
      {error && <div className="mt-2 text-sm text-red-700">{error}</div>}
      {dry && (
        <pre className="mt-3 bg-slate-900 text-amber-300 p-3 rounded text-[11px] overflow-x-auto font-mono">
{JSON.stringify(dry, null, 2)}
        </pre>
      )}
      {done && (
        <div className="mt-3 rounded-lg bg-emerald-100 px-3 py-2 text-sm font-bold text-emerald-800">
          ✅ {done.atualizados} linha(s) corrigidas na tabela nativa. Rebipe a peça pra conferir a promo.
        </div>
      )}
    </div>
  );
}

/* ─── Importação COMPLETA da tabela `clientes` do Giga ───────────────────────
   Base da Consulta de Clientes nativa + crediário nativo (sair da Giga).
   POST dispara em background; a caixa faz poll do status a cada 4s. */
function ClientesGigaBox() {
  const [st, setSt] = useState<{
    total: number; comCpf: number; pessoasUnicas: number; vinculadosAoCrm: number;
    porLoja?: Array<{ loja: string; fichas: number }>;
    ultimoSync: string | null; rodando: boolean;
    ultimoResultado?: { erro?: string } | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try { setSt(await api('/admin/clientes-giga/status')); } catch { /* mantém último */ }
  };
  useEffect(() => { load(); }, []);

  const rodar = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ started: boolean; alreadyRunning: boolean }>(
        '/admin/clientes-giga/sync', { method: 'POST' },
      );
      if (!r.started && r.alreadyRunning) setErr('Já tem uma importação rodando — acompanhando.');
      // Poll até terminar (guarda de 15min)
      const t0 = Date.now();
      while (Date.now() - t0 < 15 * 60 * 1000) {
        await new Promise((res) => setTimeout(res, 4000));
        await load();
        const cur = await api<any>('/admin/clientes-giga/status').catch(() => null);
        if (cur && !cur.rodando) {
          setSt(cur);
          if (cur.ultimoResultado?.erro) setErr(`Importação falhou: ${cur.ultimoResultado.erro}`);
          break;
        }
      }
    } catch (e: any) {
      setErr(e?.message || 'Erro ao iniciar a importação');
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <div className="bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl p-5">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[260px]">
          <h2 className="font-bold text-emerald-900 mb-1">Clientes do Giga — importação completa</h2>
          <p className="text-xs text-emerald-700">
            Traz a tabela <b>clientes</b> inteira (todos os campos e lojas) pro Flow e vincula ao CRM por CPF.
            Base da Consulta de Clientes nativa. Demora alguns minutos na primeira carga.
          </p>
          {st && (
            <div className="mt-2 flex gap-3 flex-wrap text-[11px] font-bold text-emerald-800">
              <span>{st.total.toLocaleString('pt-BR')} fichas</span>
              <span>· {st.pessoasUnicas.toLocaleString('pt-BR')} pessoas (CPF)</span>
              <span>· {st.vinculadosAoCrm.toLocaleString('pt-BR')} no CRM</span>
              {st.ultimoSync && <span className="text-emerald-600 font-normal">· último: {new Date(st.ultimoSync).toLocaleString('pt-BR')}</span>}
            </div>
          )}
          {/* POR LOJA — confere que TODAS as lojas vieram (a tabela do Giga é
              uma só pra rede; aqui dá pra ver se alguma loja veio zerada) */}
          {st?.porLoja && st.porLoja.length > 0 && (
            <div className="mt-2 flex gap-1.5 flex-wrap">
              {st.porLoja.map((l) => (
                <span key={l.loja} className="rounded-md bg-white/70 border border-emerald-200 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 tabular-nums">
                  LJ{l.loja}: {l.fichas.toLocaleString('pt-BR')}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={rodar}
          disabled={busy || !!st?.rodando}
          className="shrink-0 px-5 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold flex items-center gap-2 shadow disabled:opacity-50"
        >
          {busy || st?.rodando ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Importando clientes...</>
          ) : (
            <><Play className="w-4 h-4" /> Importar clientes do Giga</>
          )}
        </button>
      </div>
      {err && <div className="mt-2 text-xs font-bold text-red-700">{err}</div>}
    </div>
  );
}

/* ─── CREDIÁRIO NATIVO (fase 1) — importa o movimento inteiro do Giga ────── */
function CrediarioNativoBox() {
  const [st, setSt] = useState<{
    total: number; abertas: number; pagas: number; vencidas: number;
    ultimoSync: string | null; rodando: boolean;
    ultimoResultado?: { erro?: string } | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try { setSt(await api('/admin/crediario-nativo/status')); } catch { /* mantém */ }
  };
  useEffect(() => { load(); }, []);

  const rodar = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ started: boolean; alreadyRunning: boolean }>(
        '/admin/crediario-nativo/sync', { method: 'POST' },
      );
      if (!r.started && r.alreadyRunning) setErr('Já tem uma importação rodando — acompanhando.');
      const t0 = Date.now();
      while (Date.now() - t0 < 20 * 60 * 1000) {
        await new Promise((res) => setTimeout(res, 4000));
        const cur = await api<any>('/admin/crediario-nativo/status').catch(() => null);
        if (cur) setSt(cur);
        if (cur && !cur.rodando) {
          if (cur.ultimoResultado?.erro) setErr(`Importação falhou: ${cur.ultimoResultado.erro}`);
          break;
        }
      }
    } catch (e: any) {
      setErr(e?.message || 'Erro ao iniciar a importação');
    } finally { setBusy(false); load(); }
  };

  return (
    <div className="bg-gradient-to-br from-sky-50 to-blue-50 border border-sky-200 rounded-xl p-5">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[260px]">
          <h2 className="font-bold text-sky-900 mb-1">Crediário nativo — importação do movimento</h2>
          <p className="text-xs text-sky-700">
            Traz o <b>movimento</b> inteiro (parcelas abertas E pagas — todo o histórico) pro Flow.
            A ficha da cliente passa a mostrar o crediário completo. Fase 2: venda/baixa gravam no Flow.
          </p>
          {st && (
            <div className="mt-2 flex gap-3 flex-wrap text-[11px] font-bold text-sky-800">
              <span>{st.total.toLocaleString('pt-BR')} parcelas</span>
              <span>· {st.abertas.toLocaleString('pt-BR')} abertas</span>
              <span className="text-red-700">· {st.vencidas.toLocaleString('pt-BR')} vencidas</span>
              <span className="text-emerald-700">· {st.pagas.toLocaleString('pt-BR')} pagas</span>
              {st.ultimoSync && <span className="text-sky-600 font-normal">· último: {new Date(st.ultimoSync).toLocaleString('pt-BR')}</span>}
            </div>
          )}
        </div>
        <button
          onClick={rodar}
          disabled={busy || !!st?.rodando}
          className="shrink-0 px-5 py-3 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-bold flex items-center gap-2 shadow disabled:opacity-50"
        >
          {busy || st?.rodando ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Importando crediário...</>
          ) : (
            <><Play className="w-4 h-4" /> Importar crediário do Giga</>
          )}
        </button>
      </div>
      {err && <div className="mt-2 text-xs font-bold text-red-700">{err}</div>}
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
