'use client';

/**
 * /retaguarda/diagnostico-erp
 *
 * Tela utilitária pra inspecionar o schema de tabelas do Gigasistemas.
 * Usado pra descobrir estrutura antes de escrever queries definitivas.
 *
 * Hoje expõe: tabela PRODVENDIDOS (pra auto-match de VENDA CERTA).
 * Fácil expandir pra outras tabelas depois.
 */

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Database, Copy, Check, Play } from 'lucide-react';
import { api } from '@/lib/api';

type SchemaResult = {
  columns: Array<{ field: string; type: string }>;
  sample: any[];
};

export default function DiagnosticoErpPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SchemaResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadProdutosVendidos() {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await api<SchemaResult>('/products/erp-schema/produtos-vendidos');
      setData(res);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }

  const jsonText = data ? JSON.stringify(data, null, 2) : '';

  async function copyJson() {
    if (!jsonText) return;
    try {
      await navigator.clipboard.writeText(jsonText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      alert('Não foi possível copiar. Selecione manualmente e Ctrl+C.');
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-brand text-white shadow">
        <div className="px-4 py-3 flex items-center gap-3 max-w-5xl mx-auto">
          <Link href="/" className="p-2 hover:bg-white/10 rounded" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-2 font-bold">
              <Database className="w-5 h-5" />
              Diagnóstico ERP (Gigasistemas)
            </div>
            <div className="text-xs opacity-80">
              Inspeciona schema de tabelas pra desenvolvimento
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="font-bold text-slate-800 mb-1">Tabela PRODVENDIDOS</div>
          <div className="text-sm text-slate-600 mb-3">
            Usado pra montar o auto-match de VENDA CERTA.
            Clique em &quot;Executar&quot; pra ver as colunas e 3 linhas de amostra.
          </div>
          <button
            onClick={loadProdutosVendidos}
            disabled={loading}
            className="px-4 py-2 bg-brand text-white font-bold rounded-lg hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
          >
            <Play className="w-4 h-4" />
            {loading ? 'Consultando ERP…' : 'Executar consulta'}
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <div className="font-bold text-red-800 text-sm mb-1">Erro</div>
            <pre className="text-xs text-red-700 whitespace-pre-wrap font-mono">{error}</pre>
          </div>
        )}

        {data && (
          <>
            {/* Tabela de colunas */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <div className="font-bold text-slate-800 text-sm">
                  Colunas ({data.columns.length})
                </div>
              </div>
              <div className="overflow-x-auto max-h-[400px]">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-600 uppercase sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-2">Campo</th>
                      <th className="text-left px-4 py-2">Tipo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.columns.map((c) => (
                      <tr key={c.field} className="border-t border-slate-100 hover:bg-slate-50">
                        <td className="px-4 py-1.5 font-mono font-semibold text-slate-800">{c.field}</td>
                        <td className="px-4 py-1.5 font-mono text-slate-600">{c.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Amostra (3 linhas) */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-200">
                <div className="font-bold text-slate-800 text-sm">
                  Amostra ({data.sample.length} linha{data.sample.length === 1 ? '' : 's'})
                </div>
              </div>
              <div className="p-3 overflow-auto max-h-[400px]">
                <pre className="text-xs font-mono text-slate-800 whitespace-pre">
                  {JSON.stringify(data.sample, null, 2)}
                </pre>
              </div>
            </div>

            {/* JSON completo pra colar pro Claude */}
            <div className="bg-slate-900 rounded-xl overflow-hidden">
              <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
                <div className="font-bold text-slate-100 text-sm">
                  📋 JSON completo — copie e cole aqui
                </div>
                <button
                  onClick={copyJson}
                  className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-white rounded inline-flex items-center gap-1.5"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3" /> Copiado!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copiar JSON
                    </>
                  )}
                </button>
              </div>
              <pre className="p-4 text-xs font-mono text-slate-100 overflow-auto max-h-[500px]">
                {jsonText}
              </pre>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
