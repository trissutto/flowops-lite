'use client';

/**
 * /retaguarda/auditoria-ncm — Auditoria de NCMs no ERP Gigasistemas
 *
 * Audita NCMs do catálogo e corrige em batch:
 *  • Lista produtos com NCM vazio / formato inválido / categoria errada
 *  • Sugere NCM correto baseado em palavras-chave (vestido → 62044200, etc)
 *  • Permite selecionar e aplicar fixes via UPDATE no ERP
 *  • Exporta CSV pra revisão fiscal
 *
 * Requer ERP_WRITE_ENABLED=true no Railway pra aplicar.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  FileSearch,
  AlertTriangle,
  CheckCircle2,
  Download,
  Filter,
  Search,
  Sparkles,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import { api } from '@/lib/api';

interface AuditItem {
  ref: string;
  sampleCodigo: string;
  descricao: string;
  grupo: string;
  subgrupo: string;
  currentNcm: string | null;
  currentNcmCleaned: string;
  issue: 'empty' | 'invalid_format' | 'wrong_category' | 'ok';
  suggestedNcm: string;
  suggestedRule: string;
  skuCount: number;
}

interface AuditSummary {
  total: number;
  ok: number;
  empty: number;
  invalid_format: number;
  wrong_category: number;
}

interface AuditResult {
  items: AuditItem[];
  summary: AuditSummary;
  schema: { ncmCol: string | null; hasGrupo: boolean; hasSubgrupo: boolean };
}

const ISSUE_LABELS: Record<AuditItem['issue'], { label: string; color: string }> = {
  empty: { label: 'Vazio', color: 'bg-red-100 text-red-800' },
  invalid_format: { label: 'Formato', color: 'bg-amber-100 text-amber-800' },
  wrong_category: { label: 'Categoria', color: 'bg-orange-100 text-orange-800' },
  ok: { label: 'OK', color: 'bg-emerald-100 text-emerald-800' },
};

export default function AuditoriaNcmPage() {
  const [data, setData] = useState<AuditResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'empty' | 'invalid_format' | 'wrong_category'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{
    applied: number;
    skipped: number;
    errors: Array<{ ref: string; error: string }>;
    message?: string;
  } | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmScope, setConfirmScope] = useState<'selected' | 'all'>('selected');

  const loadAudit = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<AuditResult>('/admin/ncm-audit?limit=200000');
      setData(res);
      setSelected(new Set());
    } catch (e: any) {
      setError(e.message || 'Falha ao carregar auditoria');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAudit();
  }, []);

  const filtered = (data?.items || []).filter((it) => {
    if (filter !== 'all' && it.issue !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        it.ref.toLowerCase().includes(q) ||
        it.descricao.toLowerCase().includes(q) ||
        it.grupo.toLowerCase().includes(q) ||
        (it.currentNcm || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((it) => it.ref)));
    }
  };

  const toggleOne = (ref: string) => {
    const next = new Set(selected);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    setSelected(next);
  };

  const askConfirm = (scope: 'selected' | 'all') => {
    setConfirmScope(scope);
    setShowConfirm(true);
  };

  const handleApply = async () => {
    if (!data) return;
    setApplying(true);
    setShowConfirm(false);
    try {
      const items =
        confirmScope === 'all'
          ? filtered.map((it) => ({ ref: it.ref, ncm: it.suggestedNcm }))
          : filtered
              .filter((it) => selected.has(it.ref))
              .map((it) => ({ ref: it.ref, ncm: it.suggestedNcm }));
      const result = await api<typeof applyResult>('/admin/ncm-audit/apply', {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      setApplyResult(result);
      await loadAudit();
    } catch (e: any) {
      setApplyResult({
        applied: 0,
        skipped: 0,
        errors: [{ ref: '*', error: e.message }],
      });
    } finally {
      setApplying(false);
    }
  };

  const handleExportCsv = () => {
    if (!data) return;
    const headers = [
      'REF',
      'Descrição',
      'Grupo',
      'Subgrupo',
      'NCM atual',
      'Problema',
      'NCM sugerido',
      'Regra',
      'SKUs',
    ];
    const csvRows = [
      headers.join(';'),
      ...filtered.map((it) =>
        [
          it.ref,
          `"${(it.descricao || '').replace(/"/g, '""')}"`,
          `"${(it.grupo || '').replace(/"/g, '""')}"`,
          `"${(it.subgrupo || '').replace(/"/g, '""')}"`,
          it.currentNcm || '',
          ISSUE_LABELS[it.issue].label,
          it.suggestedNcm,
          `"${(it.suggestedRule || '').replace(/"/g, '""')}"`,
          it.skuCount,
        ].join(';'),
      ),
    ];
    const blob = new Blob(['﻿' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ncm-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-stone-100">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link
            href="/retaguarda"
            className="p-2 rounded-lg hover:bg-stone-100 text-stone-600"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div>
            <div className="text-xs text-stone-500">FlowOps · Retaguarda</div>
            <h1 className="text-lg font-bold text-stone-900 flex items-center gap-2">
              <FileSearch className="w-5 h-5 text-rose-600" />
              Auditoria de NCM (Catálogo Giga)
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadAudit}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-sm font-medium disabled:opacity-50"
          >
            {loading ? '⟳ Carregando…' : '⟳ Atualizar'}
          </button>
          <button
            onClick={handleExportCsv}
            disabled={!data}
            className="px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-sm font-medium flex items-center gap-1 disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            CSV
          </button>
        </div>
      </header>

      <div className="max-w-screen-2xl mx-auto p-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-2xl p-4">
            <div className="font-bold">Erro ao carregar</div>
            <div className="text-sm">{error}</div>
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-20 text-stone-500">
            <Loader2 className="w-6 h-6 animate-spin mr-2" />
            Lendo catálogo do Giga…
          </div>
        )}

        {data && (
          <>
            {/* Resumo */}
            <section className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <SummaryCard
                label="Total auditado"
                value={data.summary.total}
                tone="stone"
                icon={FileSearch}
              />
              <SummaryCard
                label="OK"
                value={data.summary.ok}
                tone="emerald"
                icon={CheckCircle2}
              />
              <SummaryCard
                label="Vazios"
                value={data.summary.empty}
                tone="red"
                icon={AlertTriangle}
              />
              <SummaryCard
                label="Formato inválido"
                value={data.summary.invalid_format}
                tone="amber"
                icon={AlertTriangle}
              />
              <SummaryCard
                label="Categoria errada"
                value={data.summary.wrong_category}
                tone="orange"
                icon={AlertTriangle}
              />
            </section>

            {/* Filtros + Ações */}
            <section className="bg-white rounded-2xl shadow p-4 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1 bg-stone-100 rounded-lg p-1">
                {(['all', 'empty', 'invalid_format', 'wrong_category'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium ${
                      filter === f ? 'bg-white shadow text-stone-900' : 'text-stone-600 hover:text-stone-900'
                    }`}
                  >
                    {f === 'all'
                      ? 'Todos'
                      : f === 'empty'
                      ? 'Vazios'
                      : f === 'invalid_format'
                      ? 'Formato'
                      : 'Categoria'}
                  </button>
                ))}
              </div>
              <div className="relative flex-1 min-w-[260px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar REF, descrição, grupo ou NCM…"
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-stone-100 text-sm focus:outline-none focus:ring-2 focus:ring-rose-500"
                />
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-sm text-stone-600">
                  {selected.size}/{filtered.length} selecionado{selected.size !== 1 ? 's' : ''}
                </span>
                <button
                  onClick={() => askConfirm('selected')}
                  disabled={selected.size === 0 || applying}
                  className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 disabled:bg-stone-300 text-white text-sm font-bold flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  Aplicar selecionados ({selected.size})
                </button>
                <button
                  onClick={() => askConfirm('all')}
                  disabled={filtered.length === 0 || applying}
                  className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 disabled:bg-stone-300 text-white text-sm font-bold"
                >
                  Aplicar TODOS ({filtered.length})
                </button>
              </div>
            </section>

            {/* Tabela */}
            <section className="bg-white rounded-2xl shadow overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 border-b border-stone-200 text-stone-600 uppercase text-[10px] font-bold tracking-wider">
                    <tr>
                      <th className="p-3 text-left">
                        <input
                          type="checkbox"
                          checked={filtered.length > 0 && selected.size === filtered.length}
                          onChange={toggleAll}
                          className="rounded"
                        />
                      </th>
                      <th className="p-3 text-left">REF</th>
                      <th className="p-3 text-left">Descrição</th>
                      <th className="p-3 text-left">Grupo / Subgrupo</th>
                      <th className="p-3 text-left">NCM atual</th>
                      <th className="p-3 text-left">Problema</th>
                      <th className="p-3 text-left">→ NCM sugerido</th>
                      <th className="p-3 text-left">Regra</th>
                      <th className="p-3 text-right">SKUs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr>
                        <td colSpan={9} className="p-12 text-center text-stone-400">
                          Nenhum produto encontrado com esse filtro
                        </td>
                      </tr>
                    )}
                    {filtered.slice(0, 500).map((it) => (
                      <tr
                        key={it.ref}
                        className={`border-b border-stone-100 hover:bg-stone-50 ${
                          selected.has(it.ref) ? 'bg-rose-50/30' : ''
                        }`}
                      >
                        <td className="p-3">
                          <input
                            type="checkbox"
                            checked={selected.has(it.ref)}
                            onChange={() => toggleOne(it.ref)}
                            className="rounded"
                          />
                        </td>
                        <td className="p-3 font-mono font-bold text-rose-600">{it.ref}</td>
                        <td className="p-3 max-w-[280px] truncate" title={it.descricao}>
                          {it.descricao}
                        </td>
                        <td className="p-3 text-xs text-stone-600">
                          <div>{it.grupo || '—'}</div>
                          {it.subgrupo && <div className="text-stone-400">{it.subgrupo}</div>}
                        </td>
                        <td className="p-3 font-mono">
                          {it.currentNcm || (
                            <span className="text-red-500 italic">vazio</span>
                          )}
                        </td>
                        <td className="p-3">
                          <span
                            className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                              ISSUE_LABELS[it.issue].color
                            }`}
                          >
                            {ISSUE_LABELS[it.issue].label}
                          </span>
                        </td>
                        <td className="p-3 font-mono font-bold text-emerald-700">
                          {it.suggestedNcm}
                        </td>
                        <td className="p-3 text-xs text-stone-500">{it.suggestedRule}</td>
                        <td className="p-3 text-right text-stone-600">{it.skuCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filtered.length > 500 && (
                <div className="p-3 bg-amber-50 text-amber-800 text-xs text-center">
                  Mostrando 500 de {filtered.length} resultados. Use filtros pra refinar
                  ou exporte CSV pra ver tudo.
                </div>
              )}
            </section>

            {/* Resultado de aplicação */}
            {applyResult && (
              <section
                className={`rounded-2xl shadow p-4 border ${
                  applyResult.errors.length > 0
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-emerald-50 border-emerald-200'
                }`}
              >
                <div className="font-bold mb-2 flex items-center gap-2">
                  {applyResult.errors.length === 0 ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-amber-600" />
                  )}
                  Resultado da aplicação
                </div>
                <div className="text-sm space-y-1">
                  <div>✓ {applyResult.applied} NCMs atualizados no ERP</div>
                  {applyResult.skipped > 0 && (
                    <div>⏭ {applyResult.skipped} ignorados</div>
                  )}
                  {applyResult.message && (
                    <div className="text-xs text-stone-600 italic">{applyResult.message}</div>
                  )}
                  {applyResult.errors.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-red-700 font-medium">
                        {applyResult.errors.length} erro(s) — clique pra ver
                      </summary>
                      <div className="mt-2 space-y-1 max-h-40 overflow-y-auto text-xs">
                        {applyResult.errors.map((e, i) => (
                          <div key={i}>
                            <code className="bg-white px-1">{e.ref}</code>: {e.error}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </section>
            )}

            {/* Schema info */}
            <section className="bg-stone-900 text-stone-300 rounded-2xl p-4 text-xs font-mono">
              <div className="text-stone-400 mb-1">// Conexão ERP detectada</div>
              <div>
                <span className="text-rose-400">Tabela:</span> produtos
              </div>
              <div>
                <span className="text-rose-400">Coluna NCM:</span> {data.schema.ncmCol}
              </div>
              <div>
                <span className="text-rose-400">Grupo:</span>{' '}
                {data.schema.hasGrupo ? '✓ detectado' : '✗ não detectado'}
              </div>
              <div>
                <span className="text-rose-400">Subgrupo:</span>{' '}
                {data.schema.hasSubgrupo ? '✓ detectado' : '✗ não detectado'}
              </div>
              <div className="mt-2 text-amber-400">
                ⚠ Aplicação requer ERP_WRITE_ENABLED=true no Railway
              </div>
            </section>
          </>
        )}
      </div>

      {/* Modal Confirmação */}
      {showConfirm && data && (
        <ConfirmModal
          scope={confirmScope}
          count={
            confirmScope === 'all'
              ? filtered.length
              : selected.size
          }
          onCancel={() => setShowConfirm(false)}
          onConfirm={handleApply}
        />
      )}
    </main>
  );
}

/* ─── Sub-components ─── */

function SummaryCard({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: 'stone' | 'emerald' | 'red' | 'amber' | 'orange';
  icon: any;
}) {
  const tones = {
    stone: 'bg-stone-50 text-stone-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
    orange: 'bg-orange-50 text-orange-700',
  };
  return (
    <div className="bg-white rounded-2xl shadow p-4">
      <div className="flex items-center justify-between mb-2">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${tones[tone]}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
      <div className="text-3xl font-bold text-stone-900">{value.toLocaleString('pt-BR')}</div>
      <div className="text-xs uppercase font-bold text-stone-500 tracking-wider mt-1">
        {label}
      </div>
    </div>
  );
}

function ConfirmModal({
  scope,
  count,
  onCancel,
  onConfirm,
}: {
  scope: 'selected' | 'all';
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6 text-amber-700" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-stone-900">Confirmar correção</h2>
            <p className="text-sm text-stone-500">Ação irreversível no ERP</p>
          </div>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900 mb-4">
          Vou aplicar <strong>{count}</strong> atualização(ões) de NCM na tabela{' '}
          <code className="font-mono">produtos</code> do Gigasistemas via UPDATE em batch.
          {scope === 'all' && (
            <div className="mt-1 text-xs">
              Escopo: <strong>TODOS</strong> os produtos visíveis no filtro atual.
            </div>
          )}
        </div>

        <div className="text-xs text-stone-600 mb-4 space-y-1">
          <div>• Cada REF terá seu NCM substituído pelo sugerido pela IA de mapeamento</div>
          <div>• Operação acontece em transação ACID (rollback se algo falhar)</div>
          <div>• Backup recomendado antes de confirmar (mas Giga grava log de auditoria)</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg bg-stone-100 hover:bg-stone-200 font-medium"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold"
          >
            Sim, aplicar
          </button>
        </div>
      </div>
    </div>
  );
}
