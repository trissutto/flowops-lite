'use client';

/**
 * /retaguarda/wincred-discovery
 *
 * Tela de auto-descoberta do schema Wincred. Lista todas as tabelas
 * do MySQL legado, mostra contagem, tempo de query, erros por tabela.
 * Botao 'Dump completo' carrega DDL + amostra de cada tabela (mais lento).
 *
 * Resultado e exibido em tela + JSON copiavel.
 *
 * SOMENTE LEITURA no Wincred.
 */

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import {
  ArrowLeft, Database, Loader2, RefreshCw, Copy, CheckCircle2, AlertTriangle,
  ChevronRight, Download,
} from 'lucide-react';

type TableSummary = {
  name: string;
  rowCount: number | null;
  error: string | null;
};

type TableFull = {
  name: string;
  ddl: string | null;
  rowCount: number | null;
  sample: any[];
  error: string | null;
};

type DumpResult<T> = {
  connectedTo: string | null;
  totalTables: number;
  durationMs: number;
  tables: T[];
};

export default function WincredDiscoveryPage() {
  const [summary, setSummary] = useState<DumpResult<TableSummary> | null>(null);
  const [full, setFull] = useState<DumpResult<TableFull> | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');

  const loadSummary = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<DumpResult<TableSummary>>('/admin/wincred-discovery/tables');
      setSummary(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar tabelas');
    } finally {
      setLoading(false);
    }
  };

  const loadFull = async () => {
    setLoadingFull(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        sampleRows: '3',
        skipCounts: 'false',
      });
      if (prefix.trim()) qs.set('onlyPrefix', prefix.trim());
      const r = await api<DumpResult<TableFull>>(`/admin/wincred-discovery/schema?${qs}`);
      setFull(r);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar dump completo');
    } finally {
      setLoadingFull(false);
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      alert('Falha ao copiar');
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/retaguarda" className="p-2 rounded-lg hover:bg-slate-100 text-slate-500">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow">
          <Database className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Wincred — Auto-descoberta de Schema</h1>
          <p className="text-sm text-slate-500">
            Lista todas as tabelas do MySQL Wincred + DDL + contagem. Usado pra gerar migrations Prisma. <b>Somente leitura</b> no Wincred.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm text-red-800">{error}</div>
        </div>
      )}

      {/* Botoes principais */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={loadSummary}
          disabled={loading}
          className="px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm flex items-center gap-2 disabled:opacity-50 shadow"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          1. Listar tabelas (rapido)
        </button>
        <button
          onClick={loadFull}
          disabled={loadingFull}
          className="px-4 py-2.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm flex items-center gap-2 disabled:opacity-50 shadow"
        >
          {loadingFull ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          2. Dump completo (DDL + amostra)
        </button>
        <input
          type="text"
          placeholder="Filtrar prefixo (ex: 'prod')"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          className="px-3 py-2 border border-slate-300 rounded-lg text-sm w-48"
        />
      </div>

      {/* Resumo da conexao */}
      {summary && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800 flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              Lista de tabelas
            </h2>
            <button
              onClick={() => copy('summary', JSON.stringify(summary, null, 2))}
              className="text-xs flex items-center gap-1 text-slate-500 hover:text-slate-800"
            >
              {copied === 'summary' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              {copied === 'summary' ? 'Copiado' : 'Copiar JSON'}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-3 text-xs mb-3">
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-slate-500">Banco</div>
              <div className="font-mono font-bold text-slate-800">{summary.connectedTo || '—'}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-slate-500">Total tabelas</div>
              <div className="font-bold text-slate-800">{summary.totalTables}</div>
            </div>
            <div className="bg-slate-50 rounded-lg p-3">
              <div className="text-slate-500">Tempo da query</div>
              <div className="font-bold text-slate-800">{summary.durationMs}ms</div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2 text-left text-[10px] uppercase font-bold text-slate-600">Tabela</th>
                  <th className="px-3 py-2 text-right text-[10px] uppercase font-bold text-slate-600">Linhas</th>
                  <th className="px-3 py-2 text-left text-[10px] uppercase font-bold text-slate-600">Erro</th>
                </tr>
              </thead>
              <tbody>
                {summary.tables.map((t) => (
                  <tr key={t.name} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-1.5 font-mono text-slate-800">{t.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {t.rowCount !== null ? t.rowCount.toLocaleString('pt-BR') : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-red-600">{t.error || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Dump completo */}
      {full && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800 flex items-center gap-2">
              <Database className="w-5 h-5 text-violet-600" />
              Dump completo ({full.tables.length} tabelas — {full.durationMs}ms)
            </h2>
            <button
              onClick={() => copy('full', JSON.stringify(full, null, 2))}
              className="text-xs flex items-center gap-1 text-slate-500 hover:text-slate-800"
            >
              {copied === 'full' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              {copied === 'full' ? 'Copiado' : 'Copiar JSON COMPLETO'}
            </button>
          </div>
          <div className="text-xs text-slate-500 mb-3">
            Clica em uma tabela pra ver DDL + amostra.
          </div>
          <div className="divide-y divide-slate-100">
            {full.tables.map((t) => {
              const open = expanded === t.name;
              return (
                <div key={t.name}>
                  <button
                    onClick={() => setExpanded(open ? null : t.name)}
                    className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 transition"
                  >
                    <ChevronRight className={`w-4 h-4 text-slate-400 transition ${open ? 'rotate-90' : ''}`} />
                    <span className="font-mono font-bold text-slate-800">{t.name}</span>
                    <span className="text-xs text-slate-500">
                      {t.rowCount !== null ? `${t.rowCount.toLocaleString('pt-BR')} linhas` : '—'}
                    </span>
                    {t.error && <span className="text-xs text-red-600 ml-2">{t.error}</span>}
                  </button>
                  {open && (
                    <div className="px-6 pb-4 space-y-3">
                      {t.ddl && (
                        <div>
                          <div className="text-xs uppercase font-bold text-slate-500 mb-1">CREATE TABLE</div>
                          <pre className="bg-slate-900 text-slate-100 p-3 rounded text-[11px] overflow-x-auto font-mono leading-tight">{t.ddl}</pre>
                        </div>
                      )}
                      {t.sample && t.sample.length > 0 && (
                        <div>
                          <div className="text-xs uppercase font-bold text-slate-500 mb-1">Amostra ({t.sample.length} linhas)</div>
                          <pre className="bg-slate-50 border border-slate-200 p-3 rounded text-[11px] overflow-x-auto font-mono leading-tight">{JSON.stringify(t.sample, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!summary && !loading && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 text-sm text-blue-900">
          <b>Como usar:</b><br/>
          1. Clica em <b>"Listar tabelas"</b> primeiro pra ver overview rapido (~5s).<br/>
          2. Depois clica em <b>"Dump completo"</b> pra trazer DDL + amostra de cada tabela (mais lento, ~30s).<br/>
          3. Copia o JSON COMPLETO e me passa — vou gerar as migrations Prisma equivalentes.
        </div>
      )}
    </div>
  );
}
