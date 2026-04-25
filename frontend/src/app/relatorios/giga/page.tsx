'use client';

/**
 * /relatorios/giga — Explorer SQL do MySQL Gigasistemas (read-only).
 *
 * Tela de matriz pra extrair dados em tempo real de qualquer tabela do ERP.
 * Backend protege com whitelist (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH), blacklist
 * (INSERT/UPDATE/DELETE/etc) e LIMIT automático. Frontend só monta a UI.
 *
 * Fluxo típico:
 *   1. Sidebar lista todas as tabelas com nome, linhas e tamanho em MB.
 *   2. Usuário clica numa tabela → pré-carrega `SELECT * FROM tbl LIMIT 100`
 *      no editor + mostra schema (colunas + amostra) num tab "Schema".
 *   3. Usuário roda no editor → resultado vira grid paginada com export CSV.
 *   4. Salvar query nomeada localmente (localStorage) pra reaproveitar.
 *
 * Acesso restrito a admin/operator (matriz) — backend bloqueia role='store'.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Database, Search, Play, Save, Download, Trash2, RefreshCw,
  Table as TableIcon, Loader2, AlertTriangle, Info, X, Copy, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import PastelShell from '@/components/PastelShell';

// ---------- types ----------
interface TableMeta { name: string; rows: number; sizeMb: number; engine: string | null }
interface ColumnMeta { field: string; type: string; null: string; key: string; default: any; extra?: string }
interface TableSchema { table: string; columns: ColumnMeta[]; sample: any[]; rowCount: number }
interface QueryResult {
  columns: string[];
  rows: any[];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
  appliedLimit: number;
}
interface SavedQuery { id: string; name: string; sql: string; createdAt: string }
interface HealthInfo {
  ok: boolean;
  error?: string;
  host?: string;
  port?: number;
  database?: string;
  hasUser: boolean;
  hasPassword: boolean;
  pingMs?: number;
}

const SAVED_KEY = 'flowops_giga_saved_queries';
const LAST_SQL_KEY = 'flowops_giga_last_sql';

export default function GigaExplorerPage() {
  const router = useRouter();

  // gate: só matriz
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
    if (!token) { router.push('/login'); return; }
    api<{ role: string }>('/auth/me')
      .then((me) => {
        if (me.role !== 'admin' && me.role !== 'operator') {
          router.push('/');
          return;
        }
        setAuthed(true);
      })
      .catch(() => router.push('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // tables sidebar
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [tableFilter, setTableFilter] = useState('');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);

  async function loadHealth() {
    setLoadingHealth(true);
    try {
      const h = await api<HealthInfo>('/erp-query/health');
      setHealth(h);
    } catch (e: any) {
      // 404 = backend velho sem o endpoint
      const m = String(e?.message || '');
      setHealth({
        ok: false,
        error: m.startsWith('404') ? 'Backend não tem o endpoint /erp-query/health (deploy pendente?)' : m,
        hasUser: false,
        hasPassword: false,
      });
    } finally {
      setLoadingHealth(false);
    }
  }

  async function loadTables() {
    setLoadingTables(true);
    try {
      const res = await api<{ count: number; tables: TableMeta[] }>('/erp-query/tables');
      setTables(res.tables);
      // Se veio vazio, dispara health pra mostrar motivo
      if (!res.tables.length) loadHealth();
    } catch (e: any) {
      alert('Erro ao carregar tabelas: ' + e.message);
      loadHealth();
    } finally {
      setLoadingTables(false);
    }
  }

  useEffect(() => { if (authed) loadTables(); }, [authed]);

  async function pickTable(name: string) {
    setSelectedTable(name);
    setSchema(null);
    setLoadingSchema(true);
    try {
      const res = await api<TableSchema>(`/erp-query/tables/${encodeURIComponent(name)}?sample=5`);
      setSchema(res);
      setSql(`SELECT * FROM ${name} LIMIT 100`);
    } catch (e: any) {
      alert('Erro ao carregar schema: ' + e.message);
    } finally {
      setLoadingSchema(false);
    }
  }

  // editor
  const [sql, setSql] = useState<string>('');
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const last = localStorage.getItem(LAST_SQL_KEY);
      if (last) setSql(last);
    }
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined' && sql) {
      localStorage.setItem(LAST_SQL_KEY, sql);
    }
  }, [sql]);

  // run
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [maxRows, setMaxRows] = useState(1000);

  async function runQuery() {
    if (!sql.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<QueryResult>('/erp-query/run', {
        method: 'POST',
        body: JSON.stringify({ sql, maxRows }),
      });
      setResult(res);
    } catch (e: any) {
      const msg = String(e?.message || 'erro');
      // tenta extrair JSON do BadRequest do nest
      const m = msg.match(/\{.*\}/s);
      if (m) {
        try {
          const j = JSON.parse(m[0]);
          setError(j.message || msg);
        } catch { setError(msg); }
      } else setError(msg);
    } finally {
      setRunning(false);
    }
  }

  // ctrl+enter pra rodar
  function onEditorKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
  }

  // saved queries
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(SAVED_KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch {}
  }, []);
  function persistSaved(next: SavedQuery[]) {
    setSaved(next);
    if (typeof window !== 'undefined') localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  }
  function saveCurrent() {
    if (!sql.trim()) return;
    const name = prompt('Nome da query (pra reaproveitar depois):');
    if (!name) return;
    const item: SavedQuery = {
      id: Math.random().toString(36).slice(2, 10),
      name,
      sql,
      createdAt: new Date().toISOString(),
    };
    persistSaved([item, ...saved]);
  }
  function deleteSaved(id: string) {
    if (!confirm('Apagar essa query salva?')) return;
    persistSaved(saved.filter((s) => s.id !== id));
  }

  // export csv
  function exportCsv() {
    if (!result) return;
    const esc = (v: any) => {
      if (v == null) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = [
      result.columns.join(','),
      ...result.rows.map((r) => result.columns.map((c) => esc(r[c])).join(',')),
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `giga-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // filtered tables
  const filteredTables = useMemo(() => {
    if (!tableFilter.trim()) return tables;
    const q = tableFilter.toLowerCase();
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableFilter]);

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Carregando…
      </div>
    );
  }

  return (
    <PastelShell
      title="Giga Explorer"
      subtitle="Conexão direta no MySQL Gigasistemas — read-only"
      icon={Database}
      tone="yellow"
      backHref="/loja"
    >
      <div className="grid grid-cols-12 gap-4">
        {/* Sidebar tabelas */}
        <aside className="col-span-12 lg:col-span-3 panel-pastel p-3 lg:max-h-[calc(100vh-200px)] lg:overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase tracking-widest font-semibold" style={{ color: '#6a5830' }}>
              Tabelas ({tables.length})
            </div>
            <button
              onClick={loadTables}
              className="p-1 rounded hover:bg-amber-50 transition"
              title="Recarregar tabelas"
              disabled={loadingTables}
            >
              <RefreshCw className={`w-3.5 h-3.5 text-amber-700 ${loadingTables ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="relative mb-2">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder="Filtrar tabelas…"
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-amber-200 bg-white/60 focus:outline-none focus:border-amber-400"
            />
          </div>

          {loadingTables ? (
            <div className="text-xs text-slate-400 py-4 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando…
            </div>
          ) : (
            <ul className="space-y-0.5 text-xs">
              {filteredTables.map((t) => (
                <li key={t.name}>
                  <button
                    onClick={() => pickTable(t.name)}
                    className={`w-full text-left px-2 py-1.5 rounded transition flex items-center gap-1.5 group ${
                      selectedTable === t.name ? 'bg-amber-100 text-amber-900' : 'hover:bg-amber-50 text-slate-700'
                    }`}
                  >
                    <TableIcon className="w-3 h-3 text-amber-600 shrink-0" />
                    <span className="font-mono truncate flex-1">{t.name}</span>
                    <span className="text-[10px] text-slate-400 shrink-0">{fmtRows(t.rows)}</span>
                  </button>
                </li>
              ))}
              {filteredTables.length === 0 && !loadingTables && (
                <li className="text-xs text-slate-400 px-2 py-2">Nenhuma tabela encontrada.</li>
              )}
            </ul>
          )}
        </aside>

        {/* Main: editor + resultado */}
        <main className="col-span-12 lg:col-span-9 space-y-3">
          {/* Banner de diagnóstico — aparece quando 0 tabelas */}
          {!loadingTables && tables.length === 0 && (
            <div className="panel-pastel p-4 border-l-4 border-amber-400">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="flex-1 text-sm">
                  <div className="font-semibold text-amber-900 mb-1">Sem tabelas — diagnóstico de conexão</div>
                  {loadingHealth ? (
                    <div className="text-amber-800 text-xs"><Loader2 className="w-3 h-3 animate-spin inline mr-1" /> Testando conexão MySQL Giga…</div>
                  ) : health ? (
                    <div className="text-xs space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold w-24">Status:</span>
                        {health.ok
                          ? <span className="text-emerald-700">✓ Pool conectado ({health.pingMs}ms)</span>
                          : <span className="text-rose-700 font-mono">✗ {health.error || 'falhou'}</span>}
                      </div>
                      <div><span className="font-semibold w-24 inline-block">Host:</span> <span className="font-mono text-slate-700">{health.host || '(vazio)'}</span> :{health.port}</div>
                      <div><span className="font-semibold w-24 inline-block">Database:</span> <span className="font-mono text-slate-700">{health.database || '(vazio)'}</span></div>
                      <div>
                        <span className="font-semibold w-24 inline-block">Credenciais:</span>{' '}
                        ERP_USER {health.hasUser ? '✓' : '✗'} · ERP_PASSWORD {health.hasPassword ? '✓' : '✗'}
                      </div>
                      {!health.ok && (
                        <div className="mt-2 pt-2 border-t border-amber-200 text-amber-800">
                          <div className="font-semibold mb-1">Causas mais comuns:</div>
                          <ul className="list-disc list-inside space-y-0.5">
                            {health.error?.includes('ETIMEDOUT') || health.error?.includes('ECONNREFUSED') ? (
                              <li>O servidor MySQL Giga só aceita conexão da rede da matriz — Railway não consegue alcançar. Solução: túnel reverso (Cloudflared/Ngrok) ou liberar IP do Railway no firewall.</li>
                            ) : null}
                            {!health.hasUser || !health.hasPassword ? (
                              <li>Variáveis ERP_USER/ERP_PASSWORD não setadas no Railway — vai em Settings → Variables e configura.</li>
                            ) : null}
                            {health.error?.includes('Access denied') ? (
                              <li>Usuário/senha do MySQL Giga estão errados — confere no Railway.</li>
                            ) : null}
                            {health.error?.includes('404') ? (
                              <li>Backend Railway ainda tá no build antigo. Precisa redeploy.</li>
                            ) : null}
                          </ul>
                        </div>
                      )}
                      <div className="pt-2">
                        <button onClick={loadHealth} className="text-xs underline text-amber-900 hover:text-amber-700">
                          Re-testar conexão
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={loadHealth} className="text-xs underline text-amber-900">
                      Testar conexão agora
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Schema preview do selecionado */}
          {selectedTable && (
            <div className="panel-pastel p-3 text-sm">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <TableIcon className="w-4 h-4" style={{ color: '#8a7340' }} />
                  <span className="font-mono font-semibold" style={{ color: '#6a5830' }}>{selectedTable}</span>
                  {schema && (
                    <span className="text-xs text-slate-500">
                      · {schema.columns.length} colunas · {fmtRows(schema.rowCount)} linhas
                    </span>
                  )}
                </div>
                <button onClick={() => { setSelectedTable(null); setSchema(null); }} className="p-1 hover:bg-slate-100 rounded">
                  <X className="w-3.5 h-3.5 text-slate-400" />
                </button>
              </div>
              {loadingSchema ? (
                <div className="text-xs text-slate-400 py-2"><Loader2 className="w-3 h-3 animate-spin inline mr-1" /> Carregando schema…</div>
              ) : schema ? (
                <details>
                  <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                    Ver colunas + amostra
                  </summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="text-xs w-full">
                      <thead>
                        <tr className="text-left text-slate-500 border-b border-slate-200">
                          <th className="px-2 py-1">Coluna</th>
                          <th className="px-2 py-1">Tipo</th>
                          <th className="px-2 py-1">Null</th>
                          <th className="px-2 py-1">Key</th>
                          <th className="px-2 py-1">Default</th>
                        </tr>
                      </thead>
                      <tbody>
                        {schema.columns.map((c) => (
                          <tr key={c.field} className="border-b border-slate-100">
                            <td className="px-2 py-1 font-mono">{c.field}</td>
                            <td className="px-2 py-1 text-slate-600">{c.type}</td>
                            <td className="px-2 py-1 text-slate-500">{c.null}</td>
                            <td className="px-2 py-1 text-slate-500">{c.key}</td>
                            <td className="px-2 py-1 text-slate-500">{String(c.default ?? '')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}
            </div>
          )}

          {/* SQL Editor */}
          <div className="panel-pastel p-3">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div className="text-xs uppercase tracking-widest font-semibold" style={{ color: '#6a5830' }}>
                SQL Editor
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500 flex items-center gap-1">
                  Max:
                  <select
                    value={maxRows}
                    onChange={(e) => setMaxRows(Number(e.target.value))}
                    className="text-xs rounded border border-amber-200 bg-white px-1 py-0.5"
                  >
                    <option value={100}>100</option>
                    <option value={500}>500</option>
                    <option value={1000}>1000</option>
                    <option value={5000}>5000</option>
                    <option value={10000}>10000</option>
                    <option value={50000}>50000</option>
                  </select>
                </label>
                <button
                  onClick={saveCurrent}
                  disabled={!sql.trim()}
                  className="px-2 py-1 text-xs rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1"
                  title="Salvar query"
                >
                  <Save className="w-3 h-3" /> Salvar
                </button>
                <button
                  onClick={runQuery}
                  disabled={running || !sql.trim()}
                  className="px-3 py-1 text-xs rounded-lg text-white disabled:opacity-50 flex items-center gap-1.5 shadow-sm"
                  style={{ background: '#8a7340' }}
                >
                  {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  Rodar (Ctrl+Enter)
                </button>
              </div>
            </div>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={onEditorKey}
              spellCheck={false}
              placeholder="-- só SELECT / SHOW / DESCRIBE / EXPLAIN / WITH&#10;SELECT * FROM produtos LIMIT 100"
              className="w-full h-32 px-3 py-2 text-sm font-mono rounded-lg border border-amber-200 bg-white/80 focus:outline-none focus:border-amber-400 resize-y"
            />
            <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
              <Info className="w-3 h-3" />
              Read-only. INSERT/UPDATE/DELETE/DROP são bloqueados no servidor. LIMIT é aplicado automaticamente em SELECT sem LIMIT.
            </div>
          </div>

          {/* Saved queries */}
          {saved.length > 0 && (
            <div className="panel-pastel p-3">
              <div className="text-xs uppercase tracking-widest font-semibold mb-2" style={{ color: '#6a5830' }}>
                Queries salvas ({saved.length})
              </div>
              <ul className="space-y-1 text-xs">
                {saved.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-amber-50">
                    <button
                      onClick={() => setSql(s.sql)}
                      className="flex-1 text-left flex items-center gap-1 text-slate-700 hover:text-slate-900"
                    >
                      <ChevronRight className="w-3 h-3 text-amber-600" />
                      <span className="font-medium">{s.name}</span>
                      <span className="text-slate-400 truncate ml-2 font-mono">{s.sql.slice(0, 60)}{s.sql.length > 60 ? '…' : ''}</span>
                    </button>
                    <button onClick={() => { navigator.clipboard.writeText(s.sql); }} className="p-1 hover:bg-white rounded" title="Copiar">
                      <Copy className="w-3 h-3 text-slate-500" />
                    </button>
                    <button onClick={() => deleteSaved(s.id)} className="p-1 hover:bg-white rounded" title="Apagar">
                      <Trash2 className="w-3 h-3 text-rose-500" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Resultado */}
          {error && (
            <div className="panel-pastel p-3 border-l-4 border-rose-400">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-rose-700">Erro ao executar</div>
                  <div className="text-rose-600 text-xs mt-1 font-mono whitespace-pre-wrap break-words">{error}</div>
                </div>
              </div>
            </div>
          )}

          {result && (
            <div className="panel-pastel p-3">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <div className="flex items-center gap-3 text-xs text-slate-600 flex-wrap">
                  <span><strong className="text-slate-800">{result.rowCount}</strong> linhas</span>
                  <span>· <strong>{result.executionMs}ms</strong></span>
                  <span>· LIMIT <strong>{result.appliedLimit}</strong></span>
                  {result.truncated && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] uppercase tracking-wider">
                      Truncado
                    </span>
                  )}
                </div>
                <button
                  onClick={exportCsv}
                  className="px-2 py-1 text-xs rounded-lg border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-1"
                >
                  <Download className="w-3 h-3" /> Exportar CSV
                </button>
              </div>

              {result.rows.length === 0 ? (
                <div className="text-sm text-slate-400 py-6 text-center">Sem linhas no resultado.</div>
              ) : (
                <div className="overflow-auto max-h-[60vh] border border-amber-100 rounded-lg">
                  <table className="text-xs w-full">
                    <thead className="sticky top-0 bg-amber-50 z-10">
                      <tr>
                        {result.columns.map((c) => (
                          <th key={c} className="px-2 py-1.5 text-left font-semibold text-amber-900 border-b border-amber-200 whitespace-nowrap">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} className={i % 2 ? 'bg-white' : 'bg-amber-50/30'}>
                          {result.columns.map((c) => (
                            <td key={c} className="px-2 py-1 border-b border-amber-50 align-top max-w-md truncate" title={fmtCell(row[c])}>
                              {fmtCell(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </PastelShell>
  );
}

// ---------- helpers ----------
function fmtRows(n: number) {
  if (n == null) return '-';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function fmtCell(v: any): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
