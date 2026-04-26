'use client';

/**
 * /retaguarda/financeiro/transferencias
 *
 * Painel financeiro mensal de transferências REDE↔FILIAL + royalties + marketing.
 *
 * 3 abas:
 *   - Obrigações: lista cobranças geradas por transferências (preço Giga ÷ 2.5),
 *     agrupadas por par de lojas. Botão "Marcar pago" individual ou em lote.
 *   - Royalties + Marketing: 8% + 4% sobre venda bruta de cada filial no mês.
 *   - Fechamento: histórico de meses fechados + botão pra fechar o mês atual.
 *
 * Acesso: somente admin.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, RefreshCw, Loader2, AlertTriangle, Check, DollarSign, FileText,
  Lock, Unlock, ChevronDown, ChevronRight, Download, Calendar, X,
} from 'lucide-react';
import { api } from '@/lib/api';

type Obligation = {
  id: string;
  fromStoreCode: string;
  fromStoreName: string;
  fromStoreTipo: string;
  toStoreCode: string;
  toStoreName: string;
  toStoreTipo: string;
  refCode: string;
  sku?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  descricao?: string | null;
  qty: number;
  precoUnitario: number;
  precoTotal: number;
  divisor: number;
  valorObrigacao: number;
  status: string;
  paidAt?: string | null;
  createdAt: string;
};

type GroupedObligations = {
  fromStoreCode: string;
  fromStoreName: string;
  fromStoreTipo: string;
  toStoreCode: string;
  toStoreName: string;
  toStoreTipo: string;
  totalQty: number;
  totalPrecoTotal: number;
  totalValorObrigacao: number;
  items: Obligation[];
};

type ObligationsView = {
  mesReferencia: string;
  totalObrigacoes: number;
  countObligations: number;
  grouped: GroupedObligations[];
};

type RoyaltiesView = {
  mesReferencia: string;
  royaltiesPct: number;
  marketingPct: number;
  totalRoyalties: number;
  totalMarketing: number;
  totalAPagar: number;
  porFilial: Array<{
    storeCode: string;
    storeName: string;
    vendaBruta: number;
    royaltiesValor: number;
    marketingValor: number;
    totalAPagar: number;
  }>;
};

type Closure = {
  id: string;
  mesReferencia: string;
  closedAt: string;
  totalObrigacoes: number;
  totalRoyalties: number;
  totalMarketing: number;
};

const TABS = [
  { id: 'obligations', label: 'Obrigações (transferências)', icon: DollarSign },
  { id: 'royalties', label: 'Royalties + Marketing', icon: FileText },
  { id: 'closures', label: 'Fechamento mensal', icon: Lock },
] as const;

type TabId = (typeof TABS)[number]['id'];

// Mês atual em formato YYYY-MM
function currentMonthYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Format BRL
const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function FinanceiroTransferenciasPage() {
  const [tab, setTab] = useState<TabId>('obligations');
  const [mes, setMes] = useState(currentMonthYM());

  // Obligations state
  const [obligations, setObligations] = useState<ObligationsView | null>(null);
  const [obligationsLoading, setObligationsLoading] = useState(false);
  const [obligationsErr, setObligationsErr] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Royalties state
  const [royalties, setRoyalties] = useState<RoyaltiesView | null>(null);
  const [royaltiesLoading, setRoyaltiesLoading] = useState(false);
  const [royaltiesErr, setRoyaltiesErr] = useState<string | null>(null);

  // Closures state
  const [closures, setClosures] = useState<Closure[]>([]);
  const [closuresLoading, setClosuresLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closureModal, setClosureModal] = useState<{ mes: string; force: boolean } | null>(null);

  // PDF modal state (lista filiais pra escolher e baixar)
  const [pdfModal, setPdfModal] = useState<{ mes: string } | null>(null);
  const [filiais, setFiliais] = useState<Array<{ code: string; name: string }>>([]);
  const [filiaisLoading, setFiliaisLoading] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);

  const loadFiliais = async () => {
    setFiliaisLoading(true);
    try {
      const stores = await api<Array<{ code: string; name: string; tipo?: string }>>('/stores');
      setFiliais(
        stores
          .filter((s) => (s.tipo || '').toUpperCase() === 'FILIAL')
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((s) => ({ code: s.code, name: s.name })),
      );
    } catch {
      setFiliais([]);
    } finally {
      setFiliaisLoading(false);
    }
  };

  // Baixa PDF: abre em nova aba (PDF inline) com Authorization via blob URL
  const downloadPdf = async (mes: string, filialCode: string) => {
    setDownloadingPdf(filialCode);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      const apiBase = (process.env.NEXT_PUBLIC_API_URL as string) || `${window.location.protocol}//${window.location.hostname}:3001`;
      const res = await fetch(
        `${apiBase}/financeiro/closures/${mes}/pdf?filial=${encodeURIComponent(filialCode)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`PDF falhou (${res.status}): ${txt || res.statusText}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      // Libera URL após delay (pra dar tempo do navegador abrir)
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e: any) {
      alert(`Erro: ${e?.message || 'falha ao gerar PDF'}`);
    } finally {
      setDownloadingPdf(null);
    }
  };

  // ── Loaders ──
  const loadObligations = async () => {
    setObligationsLoading(true);
    setObligationsErr(null);
    try {
      const data = await api<ObligationsView>(`/financeiro/obligations?mes=${mes}`);
      setObligations(data);
    } catch (e: any) {
      setObligationsErr(e?.message || 'Erro');
    } finally {
      setObligationsLoading(false);
    }
  };
  const loadRoyalties = async () => {
    setRoyaltiesLoading(true);
    setRoyaltiesErr(null);
    try {
      const data = await api<RoyaltiesView>(`/financeiro/royalties?mes=${mes}`);
      setRoyalties(data);
    } catch (e: any) {
      setRoyaltiesErr(e?.message || 'Erro');
    } finally {
      setRoyaltiesLoading(false);
    }
  };
  const loadClosures = async () => {
    setClosuresLoading(true);
    try {
      const data = await api<Closure[]>('/financeiro/closures');
      setClosures(data);
    } catch (e: any) {
      // silencioso
    } finally {
      setClosuresLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'obligations') loadObligations();
    if (tab === 'royalties') loadRoyalties();
    if (tab === 'closures') loadClosures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, mes]);

  // ── Actions ──
  const markPaid = async (id: string) => {
    if (!confirm('Marcar como paga?')) return;
    try {
      await api(`/financeiro/obligations/${id}/paid`, { method: 'PATCH', body: '{}' });
      loadObligations();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  const markGroupPaid = async (g: GroupedObligations) => {
    const ids = g.items.filter((i) => i.status !== 'paid' && i.status !== 'cancelled').map((i) => i.id);
    if (!ids.length) return;
    if (!confirm(`Marcar ${ids.length} obrigações de ${g.fromStoreCode}→${g.toStoreCode} como pagas? Total: ${brl(g.totalValorObrigacao)}`)) return;
    try {
      await api('/financeiro/obligations/paid-bulk', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      });
      loadObligations();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  const exportXlsx = () => {
    if (!obligations) return;
    // CSV simples (XLSX requer lib externa). Excel abre CSV nativamente.
    const lines: string[] = [];
    lines.push('De,De Tipo,Para,Para Tipo,REF,Cor,Tamanho,Qty,Preco Unit,Preco Total,Valor Obrig,Status');
    for (const g of obligations.grouped) {
      for (const o of g.items) {
        lines.push(
          [
            `${o.fromStoreCode} ${o.fromStoreName}`,
            o.fromStoreTipo,
            `${o.toStoreCode} ${o.toStoreName}`,
            o.toStoreTipo,
            o.refCode,
            o.cor || '',
            o.tamanho || '',
            o.qty,
            o.precoUnitario.toFixed(2),
            o.precoTotal.toFixed(2),
            o.valorObrigacao.toFixed(2),
            o.status,
          ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','),
        );
      }
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `obrigacoes-${mes}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const closeMonth = async (force = false) => {
    setClosing(true);
    try {
      await api(`/financeiro/closures/${mes}/close`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      setClosureModal(null);
      loadClosures();
      loadObligations();
      alert(`Mês ${mes} fechado com sucesso.`);
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('já foi fechado') && !force) {
        if (confirm(`${msg}\n\nReabrir e refazer?`)) {
          await closeMonth(true);
        }
      } else {
        alert(`Erro: ${msg}`);
      }
    } finally {
      setClosing(false);
    }
  };

  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/retaguarda"
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-500"
          title="Voltar"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow">
          <DollarSign className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Financeiro intercompany</h1>
          <p className="text-sm text-slate-500">
            Obrigações REDE↔FILIAL + royalties (8%) + marketing (4%) + fechamento mensal.
          </p>
        </div>
        {/* Mês selector */}
        <div className="flex items-center gap-2 bg-white border border-slate-300 rounded-lg px-3 py-1.5">
          <Calendar className="w-4 h-4 text-slate-400" />
          <input
            type="month"
            value={mes}
            onChange={(e) => setMes(e.target.value)}
            className="text-sm bg-transparent outline-none font-mono"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-1 flex">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold transition ${
                active
                  ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ── ABA: Obrigações ── */}
      {tab === 'obligations' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-600">
              {obligations ? (
                <>
                  <b>{obligations.countObligations}</b> obrigações ·{' '}
                  <b className="text-emerald-700">{brl(obligations.totalObrigacoes)}</b>
                </>
              ) : (
                'Carregando...'
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={exportXlsx}
                disabled={!obligations || obligations.countObligations === 0}
                className="text-sm px-3 py-1.5 border border-slate-300 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                Exportar CSV
              </button>
              <button
                onClick={loadObligations}
                disabled={obligationsLoading}
                className="text-sm px-3 py-1.5 border border-slate-300 rounded-lg hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${obligationsLoading ? 'animate-spin' : ''}`} />
                Recarregar
              </button>
            </div>
          </div>

          {obligationsErr && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
              <div className="text-sm">{obligationsErr}</div>
            </div>
          )}

          {obligationsLoading ? (
            <Skeleton />
          ) : obligations && obligations.grouped.length === 0 ? (
            <EmptyBox text={`Nenhuma obrigação no mês ${mes}.`} />
          ) : obligations ? (
            <div className="space-y-3">
              {obligations.grouped.map((g) => {
                const key = `${g.fromStoreCode}-${g.toStoreCode}`;
                const expanded = expandedGroups.has(key);
                return (
                  <div key={key} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                    <div
                      className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50"
                      onClick={() => toggleGroup(key)}
                    >
                      {expanded ? (
                        <ChevronDown className="w-4 h-4 text-slate-400" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-400" />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center gap-2 text-sm">
                          <Pill tipo={g.fromStoreTipo} />
                          <span className="font-semibold">{g.fromStoreName}</span>
                          <span className="text-slate-400">→</span>
                          <Pill tipo={g.toStoreTipo} />
                          <span className="font-semibold">{g.toStoreName}</span>
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          {g.items.length} item(s) · {g.totalQty} peças · preço total {brl(g.totalPrecoTotal)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-bold text-emerald-700 tabular-nums">
                          {brl(g.totalValorObrigacao)}
                        </div>
                        <div className="text-xs text-slate-400">a pagar (÷2,5)</div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          markGroupPaid(g);
                        }}
                        className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold flex items-center gap-1"
                      >
                        <Check className="w-3 h-3" />
                        Pagar tudo
                      </button>
                    </div>
                    {expanded && (
                      <div className="border-t border-slate-100 px-4 py-3 bg-slate-50/50">
                        <div className="overflow-x-auto">
                          <table className="text-xs w-full">
                            <thead>
                              <tr className="text-left text-slate-600 border-b border-slate-200">
                                <th className="px-2 py-1">REF</th>
                                <th className="px-2 py-1">Cor</th>
                                <th className="px-2 py-1">Tam</th>
                                <th className="px-2 py-1 text-right">Qty</th>
                                <th className="px-2 py-1 text-right">Preço un.</th>
                                <th className="px-2 py-1 text-right">Total</th>
                                <th className="px-2 py-1 text-right">Obrigação</th>
                                <th className="px-2 py-1 text-center">Status</th>
                                <th className="px-2 py-1"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.items.map((o) => (
                                <tr key={o.id} className="border-b border-slate-100 last:border-0">
                                  <td className="px-2 py-1.5 font-mono">{o.refCode}</td>
                                  <td className="px-2 py-1.5">{o.cor || '-'}</td>
                                  <td className="px-2 py-1.5">{o.tamanho || '-'}</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums">{o.qty}</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums">{brl(o.precoUnitario)}</td>
                                  <td className="px-2 py-1.5 text-right tabular-nums">{brl(o.precoTotal)}</td>
                                  <td className="px-2 py-1.5 text-right font-semibold text-emerald-700 tabular-nums">
                                    {brl(o.valorObrigacao)}
                                  </td>
                                  <td className="px-2 py-1.5 text-center">
                                    <StatusBadge status={o.status} />
                                  </td>
                                  <td className="px-2 py-1.5 text-right">
                                    {o.status !== 'paid' && o.status !== 'cancelled' && (
                                      <button
                                        onClick={() => markPaid(o.id)}
                                        className="text-xs px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded"
                                      >
                                        Pagar
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      )}

      {/* ── ABA: Royalties + Marketing ── */}
      {tab === 'royalties' && (
        <div className="space-y-4">
          {royaltiesErr && (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
              <div className="text-sm">{royaltiesErr}</div>
            </div>
          )}
          {royaltiesLoading ? (
            <Skeleton />
          ) : royalties ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <KpiBox label={`Royalties (${(royalties.royaltiesPct * 100).toFixed(0)}%)`} value={brl(royalties.totalRoyalties)} color="amber" />
                <KpiBox label={`Marketing (${(royalties.marketingPct * 100).toFixed(0)}%)`} value={brl(royalties.totalMarketing)} color="blue" />
                <KpiBox label="TOTAL" value={brl(royalties.totalAPagar)} color="emerald" />
              </div>
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <table className="text-sm w-full">
                  <thead>
                    <tr className="text-left text-slate-700 border-b border-slate-200 bg-slate-50">
                      <th className="px-4 py-2">Filial</th>
                      <th className="px-4 py-2 text-right">Venda bruta</th>
                      <th className="px-4 py-2 text-right">Royalties (8%)</th>
                      <th className="px-4 py-2 text-right">Marketing (4%)</th>
                      <th className="px-4 py-2 text-right">Total a pagar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {royalties.porFilial.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                          Nenhuma filial cadastrada. Vá em <Link href="/retaguarda/lojas" className="text-blue-600 underline">Lojas</Link> e marque pelo menos uma como FILIAL.
                        </td>
                      </tr>
                    ) : (
                      royalties.porFilial.map((f) => (
                        <tr key={f.storeCode} className="border-b border-slate-100">
                          <td className="px-4 py-2.5">
                            <span className="font-mono text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded mr-2">{f.storeCode}</span>
                            <span className="font-semibold">{f.storeName}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{brl(f.vendaBruta)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">{brl(f.royaltiesValor)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-blue-700">{brl(f.marketingValor)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums font-bold text-emerald-700">{brl(f.totalAPagar)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* ── ABA: Fechamento ── */}
      {tab === 'closures' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex items-center gap-4">
            <Lock className="w-8 h-8 text-emerald-600" />
            <div className="flex-1">
              <h3 className="font-bold text-slate-900">Fechar mês {mes}</h3>
              <p className="text-sm text-slate-500 mt-0.5">
                Cria snapshot imutável de todas as obrigações + royalties + marketing.
                Obrigações pendentes viram <code className="bg-slate-100 px-1 rounded">closed</code>.
              </p>
            </div>
            <button
              onClick={() => setClosureModal({ mes, force: false })}
              disabled={closing}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg flex items-center gap-2 disabled:opacity-50"
            >
              {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
              Fechar {mes}
            </button>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Histórico (últimos 24 meses)</h3>
            {closuresLoading ? (
              <Skeleton />
            ) : closures.length === 0 ? (
              <EmptyBox text="Nenhum mês fechado ainda." />
            ) : (
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <table className="text-sm w-full">
                  <thead>
                    <tr className="text-left text-slate-700 border-b border-slate-200 bg-slate-50">
                      <th className="px-4 py-2">Mês</th>
                      <th className="px-4 py-2">Fechado em</th>
                      <th className="px-4 py-2 text-right">Obrigações</th>
                      <th className="px-4 py-2 text-right">Royalties</th>
                      <th className="px-4 py-2 text-right">Marketing</th>
                      <th className="px-4 py-2 text-right">Total geral</th>
                      <th className="px-4 py-2 text-center">Comprovantes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closures.map((c) => (
                      <tr key={c.id} className="border-b border-slate-100">
                        <td className="px-4 py-2.5 font-mono font-semibold">{c.mesReferencia}</td>
                        <td className="px-4 py-2.5 text-slate-500">
                          {new Date(c.closedAt).toLocaleString('pt-BR')}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{brl(c.totalObrigacoes)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">{brl(c.totalRoyalties)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-blue-700">{brl(c.totalMarketing)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-bold text-emerald-700">
                          {brl(c.totalObrigacoes + c.totalRoyalties + c.totalMarketing)}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <button
                            onClick={() => {
                              setPdfModal({ mes: c.mesReferencia });
                              if (filiais.length === 0) loadFiliais();
                            }}
                            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200"
                            title="Gerar PDF por filial"
                          >
                            <FileText className="w-3 h-3" />
                            PDFs
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal confirmação fechamento */}
      {closureModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">Confirmar fechamento</h3>
              <button onClick={() => setClosureModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-slate-700">
              Vai fechar o mês <b>{closureModal.mes}</b> e gerar snapshot imutável.
              Obrigações pendentes serão marcadas como <code className="bg-slate-100 px-1 rounded">closed</code>.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setClosureModal(null)}
                className="px-4 py-2 text-sm rounded-lg border border-slate-300 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={() => closeMonth(closureModal.force)}
                disabled={closing}
                className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg flex items-center gap-1.5 disabled:opacity-50"
              >
                {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal PDFs por filial */}
      {pdfModal && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          onClick={() => setPdfModal(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-md w-full p-5 space-y-4 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <FileText className="w-5 h-5 text-rose-600" />
                Comprovantes — {pdfModal.mes}
              </h3>
              <button onClick={() => setPdfModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Clique numa filial pra abrir o PDF do comprovante mensal. Cada PDF tem
              venda bruta, royalties, marketing, obrigações e o detalhe das transferências.
            </p>

            {filiaisLoading ? (
              <div className="text-center py-6 text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin inline-block mb-1" />
                <div className="text-xs">Carregando filiais...</div>
              </div>
            ) : filiais.length === 0 ? (
              <div className="text-center py-6 text-slate-400 text-sm">
                Nenhuma filial cadastrada. Vá em <Link href="/retaguarda/lojas" className="text-rose-600 underline">Lojas</Link> pra classificar.
              </div>
            ) : (
              <div className="space-y-1">
                {filiais.map((f) => (
                  <button
                    key={f.code}
                    onClick={() => downloadPdf(pdfModal.mes, f.code)}
                    disabled={downloadingPdf === f.code}
                    className="w-full text-left flex items-center gap-3 p-2.5 rounded-lg border border-slate-200 hover:bg-rose-50 hover:border-rose-300 transition-colors disabled:opacity-50"
                  >
                    <div className="font-mono text-sm font-semibold text-slate-700 w-12 shrink-0">
                      {f.code}
                    </div>
                    <div className="flex-1 text-sm text-slate-700 truncate">{f.name}</div>
                    {downloadingPdf === f.code ? (
                      <Loader2 className="w-4 h-4 animate-spin text-rose-600" />
                    ) : (
                      <Download className="w-4 h-4 text-rose-600" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Pill({ tipo }: { tipo: string }) {
  const isFilial = tipo === 'FILIAL';
  return (
    <span
      className={`text-[10px] font-bold px-2 py-0.5 rounded ${
        isFilial ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
      }`}
    >
      {tipo}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-800',
    closed: 'bg-blue-100 text-blue-800',
    paid: 'bg-emerald-100 text-emerald-800',
    cancelled: 'bg-slate-100 text-slate-500',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${colors[status] || 'bg-slate-100'}`}>
      {status}
    </span>
  );
}

function KpiBox({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: 'amber' | 'blue' | 'emerald';
}) {
  const palette: Record<string, string> = {
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  };
  return (
    <div className={`rounded-lg border p-4 ${palette[color]}`}>
      <div className="text-xs uppercase font-semibold opacity-80">{label}</div>
      <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400">
      <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
      Carregando...
    </div>
  );
}

function EmptyBox({ text }: { text: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400">
      {text}
    </div>
  );
}
