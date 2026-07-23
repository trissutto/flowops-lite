'use client';
import { overlayClose } from '@/lib/overlayClose';

/**
 * /retaguarda/remessas
 *
 * Visão admin de TODAS as remessas de realinhamento entre lojas.
 *
 * Por que existe: hoje a matriz só vê uma remessa depois que a loja destino
 * confirma o recebimento. Essa tela mostra a operação em tempo real:
 *   - Quantas remessas estão sendo montadas (open)
 *   - Quantas já saíram e estão na rua (in_transit) — com contador de horas
 *   - Quantas chegaram (received)
 *   - Quais estão paradas há mais de 48h (sinal de problema)
 *
 * Ações rápidas: clicar numa remessa abre o detalhe (modal) com a lista de
 * itens e o status de bipagem de cada um.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  RefreshCw,
  Package,
  Truck,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Search,
  X,
  Loader2,
  PackageCheck,
} from 'lucide-react';
import { api, API_URL, getAuthToken } from '@/lib/api';

type ShipmentRow = {
  id: string;
  code: string;
  fromStoreCode: string;
  fromStoreName: string;
  toStoreCode: string;
  toStoreName: string;
  status: 'open' | 'in_transit' | 'received' | 'cancelled' | string;
  openedAt: string;
  sentAt?: string | null;
  receivedAt?: string | null;
  totalItems?: number | null;
  totalQty?: number | null;
  receivedQty?: number | null;
  missingQty?: number | null;
  // calculados pelo backend (live)
  totalItemsLive: number;
  totalQtyLive: number;
  receivedCount: number;
  missingCount: number;
  pendingScanCount: number;
  hoursInTransit: number | null;
};

type ShipmentDetail = ShipmentRow & {
  items: Array<{
    id: string;
    refCode: string;
    cor: string | null;
    tamanho: string | null;
    qtyOrigem: number;
    descricao: string | null;
    realignmentStatus: string | null;
    realignmentReceivedAt: string | null;
    realignmentMissingAt: string | null;
    realignmentMissingNote: string | null;
  }>;
};

type KPIs = {
  open: number;
  inTransit: number;
  received: number;
  stuck: number;
  total90d: number;
};

const STATUS_LABEL: Record<string, string> = {
  open: 'Em montagem',
  in_transit: 'Em trânsito',
  received: 'Recebida',
  cancelled: 'Cancelada',
};

const STATUS_TONE: Record<string, { bg: string; text: string; border: string; icon: any }> = {
  open: { bg: '#fef3c7', text: '#854d0e', border: '#fbbf24', icon: Package },
  in_transit: { bg: '#dde7ea', text: '#2e4750', border: '#6b8a92', icon: Truck },
  received: { bg: '#e3ebd9', text: '#475636', border: '#9caf88', icon: CheckCircle2 },
  cancelled: { bg: '#f5e6e3', text: '#6e3a40', border: '#c08081', icon: X },
};

export default function RemessasAdminPage() {
  const [rows, setRows] = useState<ShipmentRow[]>([]);
  const [kpis, setKpis] = useState<KPIs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [statusFilter, setStatusFilter] = useState<string>(''); // '' = todos
  const [search, setSearch] = useState('');
  const [daysAgo, setDaysAgo] = useState(30);

  // Detalhe modal
  const [detail, setDetail] = useState<ShipmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (search.trim()) params.set('search', search.trim());
      params.set('daysAgo', String(daysAgo));

      const [list, k] = await Promise.all([
        api<ShipmentRow[]>(`/realignment/shipments/admin/all?${params.toString()}`),
        api<KPIs>('/realignment/shipments/admin/kpis'),
      ]);
      setRows(Array.isArray(list) ? list : []);
      setKpis(k);
    } catch (e: any) {
      setError(e?.message || 'Erro ao carregar remessas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, daysAgo]);

  // Filtro de busca client-side adicional (substring no código + lojas)
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      return (
        r.code.toLowerCase().includes(q) ||
        r.fromStoreCode.toLowerCase().includes(q) ||
        r.fromStoreName.toLowerCase().includes(q) ||
        r.toStoreCode.toLowerCase().includes(q) ||
        r.toStoreName.toLowerCase().includes(q)
      );
    });
  }, [rows, search]);

  const openDetail = async (id: string) => {
    setDetail(null);
    setDetailId(id);
    setNfeResult(null);
    setNfePreview(null);
    setDetailLoading(true);
    try {
      const d = await api<ShipmentDetail>(`/realignment/shipments/admin/${id}`);
      setDetail(d);
    } catch (e: any) {
      alert(e?.message || 'Erro ao carregar detalhe');
    } finally {
      setDetailLoading(false);
    }
  };

  // ── NF-e de transferência (Fase 3, 23/07): emite direto do detalhe ──
  const [detailId, setDetailId] = useState<string | null>(null);
  const [nfeEmitting, setNfeEmitting] = useState(false);
  const [nfeResult, setNfeResult] = useState<any | null>(null);
  const [nfePreview, setNfePreview] = useState<any | null>(null);
  const [nfePreviewLoading, setNfePreviewLoading] = useState(false);
  // Lista de NF-e emitidas ("será que foi?" — resposta definitiva num lugar só)
  const [nfeList, setNfeList] = useState<any[] | null>(null);
  const [nfeListOpen, setNfeListOpen] = useState(false);
  const abrirNfeList = async () => {
    setNfeListOpen(true);
    setNfeList(null);
    try {
      setNfeList(await api<any[]>('/nfe?limit=100'));
    } catch {
      setNfeList([]);
    }
  };

  // DANFE em PDF — fetch com bearer (rota autenticada) → abre em nova aba
  const abrirDanfe = async (docId: string, numero: any) => {
    try {
      const token = getAuthToken();
      const r = await fetch(`${API_URL}/api/nfe/${docId}/danfe`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || `HTTP ${r.status}`);
      const blobUrl = URL.createObjectURL(await r.blob());
      const w = window.open(blobUrl, '_blank');
      if (!w) {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `danfe-${numero}.pdf`;
        a.click();
      }
    } catch (e: any) {
      alert(`Erro ao gerar DANFE: ${e?.message || e}`);
    }
  };

  // Baixa o XML EXATO que foi à SEFAZ (diagnóstico de rejeição sem queimar número)
  const baixarXmlNfe = async (d: any) => {
    try {
      const doc = await api<any>(`/nfe/${d.id}`);
      const partes: Array<[string, string | null]> = [
        [`nfe-${d.numero}-enviado.xml`, doc?.xmlEnviado],
        [`nfe-${d.numero}-resposta.xml`, d.status !== 'authorized' ? doc?.xmlResposta : null],
      ];
      let baixou = false;
      for (const [nome, xml] of partes) {
        if (!xml) continue;
        const blob = new Blob([xml], { type: 'application/xml' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = nome;
        a.click();
        URL.revokeObjectURL(a.href);
        baixou = true;
      }
      if (!baixou) alert('Esta NF-e não tem XML gravado (falhou antes de assinar).');
    } catch (e: any) {
      alert(`Erro ao buscar XML: ${e?.message || e}`);
    }
  };

  const carregarPreview = async () => {
    if (!detailId || nfePreviewLoading) return;
    setNfePreviewLoading(true);
    try {
      setNfePreview(await api<any>(`/nfe/transfer/preview/${detailId}`));
    } catch (e: any) {
      setNfePreview({ erro: e?.message || 'Falha na prévia' });
    } finally {
      setNfePreviewLoading(false);
    }
  };
  const emitirNfe = async () => {
    if (!detailId || nfeEmitting) return;
    if (!confirm('Emitir NF-e de transferência desta remessa?\n\nO ambiente (homologação/produção) vem da config fiscal da loja de ORIGEM.')) return;
    setNfeEmitting(true);
    setNfeResult(null);
    try {
      const r = await api<any>(`/nfe/transfer/emit/${detailId}`, { method: 'POST', body: JSON.stringify({}) });
      // Backend devolve { ok, jaEmitida, doc: {...}, warnings } — desembrulha
      // o doc pro painel (bug 23/07: lia no nível de cima e mostrava vazio)
      const d = r?.doc || r || {};
      setNfeResult({ ...d, ok: r?.ok, jaEmitida: r?.jaEmitida, warnings: r?.warnings });
    } catch (e: any) {
      setNfeResult({ erro: e?.message || 'Falha na emissão' });
    } finally {
      setNfeEmitting(false);
    }
  };

  const fmtDate = (iso?: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/retaguarda"
            className="text-slate-500 hover:text-slate-700"
            aria-label="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
              <Truck className="w-5 h-5 text-slate-600" />
              Remessas em trânsito
            </h1>
            <p className="text-xs text-slate-500">
              Rastreio de todas as caixas de realinhamento entre lojas (últimos {daysAgo} dias)
            </p>
          </div>
          <button
            onClick={abrirNfeList}
            className="px-3 py-2 rounded-lg border-2 border-indigo-300 text-indigo-700 hover:bg-indigo-50 text-sm font-bold"
          >
            📄 NF-e emitidas
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="text-sm flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 space-y-4">
        {/* KPIs */}
        {kpis && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <KpiCard
              label="Em montagem"
              value={kpis.open}
              tone="amber"
              icon={Package}
              onClick={() => setStatusFilter('open')}
              active={statusFilter === 'open'}
            />
            <KpiCard
              label="Em trânsito"
              value={kpis.inTransit}
              tone="sky"
              icon={Truck}
              onClick={() => setStatusFilter('in_transit')}
              active={statusFilter === 'in_transit'}
            />
            <KpiCard
              label="Recebidas (90d)"
              value={kpis.received}
              tone="mint"
              icon={CheckCircle2}
              onClick={() => setStatusFilter('received')}
              active={statusFilter === 'received'}
            />
            <KpiCard
              label="Paradas +48h"
              value={kpis.stuck}
              tone="rose"
              icon={AlertTriangle}
            />
            <KpiCard
              label="Total (90d)"
              value={kpis.total90d}
              tone="slate"
              icon={PackageCheck}
              onClick={() => setStatusFilter('')}
              active={statusFilter === ''}
            />
          </div>
        )}

        {/* Filtros */}
        <div className="bg-white rounded-lg border p-3 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar código, loja origem ou destino..."
              className="w-full pl-9 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-sm border rounded-md px-3 py-2"
          >
            <option value="">Todos status</option>
            <option value="open">Em montagem</option>
            <option value="in_transit">Em trânsito</option>
            <option value="received">Recebidas</option>
          </select>
          <select
            value={daysAgo}
            onChange={(e) => setDaysAgo(Number(e.target.value))}
            className="text-sm border rounded-md px-3 py-2"
          >
            <option value={7}>Últimos 7 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
          </select>
        </div>

        {/* Lista */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-md text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-center py-10 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin inline-block mb-2" />
            <div className="text-sm">Carregando remessas...</div>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="text-center py-10 text-slate-400 bg-white rounded-lg border">
            <Package className="w-10 h-10 inline-block mb-2 opacity-50" />
            <div className="text-sm">Nenhuma remessa encontrada com esses filtros</div>
          </div>
        ) : (
          <div className="bg-white rounded-lg border overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b text-xs uppercase text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Código</th>
                  <th className="text-left px-3 py-2">Origem → Destino</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Itens</th>
                  <th className="text-right px-3 py-2">Peças</th>
                  <th className="text-left px-3 py-2">Aberta em</th>
                  <th className="text-left px-3 py-2">Enviada em</th>
                  <th className="text-left px-3 py-2">Tempo trânsito</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const tone = STATUS_TONE[r.status] || STATUS_TONE.open;
                  const StatusIcon = tone.icon;
                  const isStuck = r.hoursInTransit !== null && r.hoursInTransit > 48;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => openDetail(r.id)}
                      className="border-b last:border-0 hover:bg-slate-50 cursor-pointer transition-colors"
                    >
                      <td className="px-3 py-2 font-mono text-xs font-semibold text-slate-700">
                        {r.code}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-slate-700">
                          {r.fromStoreCode} <span className="text-slate-400">→</span>{' '}
                          {r.toStoreCode}
                        </div>
                        <div className="text-xs text-slate-500 truncate max-w-[260px]">
                          {r.fromStoreName} → {r.toStoreName}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border"
                          style={{ background: tone.bg, color: tone.text, borderColor: tone.border }}
                        >
                          <StatusIcon className="w-3 h-3" />
                          {STATUS_LABEL[r.status] || r.status}
                        </span>
                        {r.status === 'in_transit' && r.pendingScanCount === 0 && r.totalItemsLive > 0 && (
                          <div className="text-[10px] text-emerald-600 mt-0.5">
                            ✓ Tudo bipado
                          </div>
                        )}
                        {r.status === 'in_transit' && r.missingCount > 0 && (
                          <div className="text-[10px] text-rose-600 mt-0.5">
                            ⚠ {r.missingCount} faltante(s)
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {r.totalItemsLive}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {r.totalQtyLive}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">{fmtDate(r.openedAt)}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{fmtDate(r.sentAt)}</td>
                      <td className="px-3 py-2 text-xs">
                        {r.hoursInTransit !== null ? (
                          <span
                            className={`inline-flex items-center gap-1 ${
                              isStuck ? 'text-rose-700 font-semibold' : 'text-slate-600'
                            }`}
                          >
                            <Clock className="w-3 h-3" />
                            {r.hoursInTransit < 1
                              ? `${Math.round(r.hoursInTransit * 60)}min`
                              : `${Math.round(r.hoursInTransit)}h`}
                            {isStuck && <AlertTriangle className="w-3 h-3 ml-0.5" />}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </main>

      {/* Modal NF-e emitidas */}
      {nfeListOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          {...overlayClose(() => setNfeListOpen(false))}
        >
          <div
            className="bg-white rounded-lg max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center justify-between bg-indigo-50">
              <h2 className="font-semibold text-indigo-900">📄 NF-e de transferência emitidas</h2>
              <button onClick={() => setNfeListOpen(false)} className="p-1.5 hover:bg-white rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {nfeList === null ? (
                <div className="text-center py-8 text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin inline-block" />
                </div>
              ) : nfeList.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-sm">Nenhuma NF-e emitida ainda.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase text-slate-400 border-b">
                      <th className="text-left py-1.5 pr-2">Quando</th>
                      <th className="text-left py-1.5 pr-2">Rota</th>
                      <th className="text-left py-1.5 pr-2">Nº / Série</th>
                      <th className="text-left py-1.5 pr-2">Amb.</th>
                      <th className="text-left py-1.5 pr-2">Status</th>
                      <th className="text-right py-1.5 pr-2">Valor</th>
                      <th className="text-left py-1.5">Chave / Motivo</th>
                      <th className="text-left py-1.5 pl-2">XML</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nfeList.map((d) => (
                      <tr key={d.id} className="border-b last:border-0 align-top">
                        <td className="py-1.5 pr-2 whitespace-nowrap text-slate-500">{fmtDate(d.createdAt)}</td>
                        <td className="py-1.5 pr-2 whitespace-nowrap">{d.fromStoreCode} → {d.toStoreCode}</td>
                        <td className="py-1.5 pr-2 whitespace-nowrap font-mono font-bold">{d.numero}/{d.serie}</td>
                        <td className="py-1.5 pr-2">
                          <span className={`font-bold ${d.tpAmb === '1' ? 'text-rose-700' : 'text-emerald-700'}`}>
                            {d.tpAmb === '1' ? 'PROD' : 'HOMOL'}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2">
                          <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold border ${
                            d.status === 'authorized'
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                              : d.status === 'rejected'
                              ? 'bg-rose-50 border-rose-300 text-rose-700'
                              : 'bg-amber-50 border-amber-300 text-amber-700'
                          }`}>
                            {d.status === 'authorized' ? 'AUTORIZADA' : d.status === 'rejected' ? 'REJEITADA' : (d.status || '?').toUpperCase()}
                          </span>
                          {d.cStat && <div className="text-[10px] text-slate-400 mt-0.5">cStat {d.cStat}</div>}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">
                          R$ {(Number(d.valorTotalCents || 0) / 100).toFixed(2)}
                        </td>
                        <td className="py-1.5 font-mono text-[10px] break-all max-w-[260px]">
                          {d.status === 'authorized' ? d.chave : (d.xMotivo || d.chave || '—')}
                        </td>
                        <td className="py-1.5 pl-2 whitespace-nowrap">
                          <button
                            onClick={() => abrirDanfe(d.id, d.numero)}
                            className={`text-[10px] px-1.5 py-0.5 rounded border mr-1 ${
                              d.status === 'authorized'
                                ? 'border-emerald-300 hover:bg-emerald-50 text-emerald-700 font-bold'
                                : 'border-slate-300 hover:bg-slate-100 text-slate-500'
                            }`}
                            title={d.status === 'authorized' ? 'Abrir DANFE em PDF' : 'DANFE de conferência (sai com tarja SEM VALOR FISCAL)'}
                          >
                            📄 DANFE
                          </button>
                          <button
                            onClick={() => baixarXmlNfe(d)}
                            className="text-[10px] px-1.5 py-0.5 rounded border border-slate-300 hover:bg-slate-100 text-slate-600"
                            title="Baixar o XML enviado à SEFAZ (e a resposta, se rejeitada)"
                          >
                            ⬇ XML
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal detalhe */}
      {(detailLoading || detail) && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          {...overlayClose(() => setDetail(null))}
        >
          <div
            className="bg-white rounded-lg max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center justify-between bg-slate-50">
              <div>
                <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Package className="w-4 h-4" />
                  Remessa {detail?.code || '...'}
                </h2>
                {detail && (
                  <div className="text-xs text-slate-500">
                    {detail.fromStoreCode} ({detail.fromStoreName}) → {detail.toStoreCode} ({detail.toStoreName})
                  </div>
                )}
              </div>
              <button
                onClick={() => setDetail(null)}
                className="p-1.5 hover:bg-slate-200 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {detailLoading ? (
                <div className="text-center py-8 text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin inline-block mb-2" />
                  <div className="text-sm">Carregando...</div>
                </div>
              ) : detail ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 text-sm">
                    <div className="bg-slate-50 rounded p-2">
                      <div className="text-xs text-slate-500">Aberta</div>
                      <div className="font-medium">{fmtDate(detail.openedAt)}</div>
                    </div>
                    <div className="bg-slate-50 rounded p-2">
                      <div className="text-xs text-slate-500">Enviada</div>
                      <div className="font-medium">{fmtDate(detail.sentAt)}</div>
                    </div>
                    <div className="bg-slate-50 rounded p-2">
                      <div className="text-xs text-slate-500">Recebida</div>
                      <div className="font-medium">{fmtDate(detail.receivedAt)}</div>
                    </div>
                  </div>

                  {/* NF-e de transferência — emite pelo CNPJ da loja de origem */}
                  <div className="mb-4 rounded-lg border-2 border-indigo-200 bg-indigo-50/50 p-3">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="text-sm">
                        <div className="font-bold text-indigo-900">NF-e de transferência (mod. 55)</div>
                        <div className="text-xs text-indigo-700">
                          Emite pelo CNPJ da loja de origem ({detail.fromStoreCode}) · itens a preço de custo · CFOP 5152/6152
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={carregarPreview}
                          disabled={nfePreviewLoading}
                          className="px-4 py-2 rounded-lg border-2 border-indigo-400 text-indigo-700 hover:bg-indigo-100 text-sm font-bold disabled:opacity-50"
                        >
                          {nfePreviewLoading ? 'Carregando…' : '👁 Prévia'}
                        </button>
                        <button
                          onClick={emitirNfe}
                          disabled={nfeEmitting}
                          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold disabled:opacity-50"
                        >
                          {nfeEmitting ? 'Emitindo…' : '📄 Emitir NF-e'}
                        </button>
                      </div>
                    </div>
                    {nfePreview && (
                      nfePreview.erro ? (
                        <div className="mt-2 rounded px-3 py-2 text-xs bg-rose-50 border border-rose-200 text-rose-800">⚠️ {nfePreview.erro}</div>
                      ) : (
                        <div className="mt-2 rounded-lg bg-white border border-indigo-200 p-3 text-xs space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <div className="text-[10px] uppercase font-bold text-slate-400">Emitente</div>
                              <div className="font-semibold">{nfePreview.emitente.razaoSocial}</div>
                              <div className="font-mono">{nfePreview.emitente.cnpj} · IE {nfePreview.emitente.ie}</div>
                              <div>
                                nº <b>{nfePreview.proximoNumero}</b> série {nfePreview.serie} ·{' '}
                                <b className={nfePreview.emitente.ambiente === '1' ? 'text-rose-700' : 'text-emerald-700'}>
                                  {nfePreview.emitente.ambiente === '1' ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO'}
                                </b>
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase font-bold text-slate-400">Destinatário</div>
                              <div className="font-semibold">{nfePreview.destinatario.razaoSocial}</div>
                              <div className="font-mono">{nfePreview.destinatario.cnpj} · IE {nfePreview.destinatario.ie}</div>
                              <div>CFOP <b>{nfePreview.cfop}</b> · {nfePreview.icms?.descricao}</div>
                            </div>
                          </div>
                          {nfePreview.avisoInterEmpresa && (
                            <div className="rounded bg-amber-50 border border-amber-300 px-2 py-1.5 text-amber-800 font-semibold">
                              ⚠️ {nfePreview.avisoInterEmpresa}
                            </div>
                          )}
                          {nfePreview.jaEmitida && (
                            <div className="rounded bg-emerald-50 border border-emerald-300 px-2 py-1.5 text-emerald-800 font-semibold">
                              ✅ Essa remessa JÁ tem NF-e autorizada — Emitir devolve a existente.
                            </div>
                          )}
                          <div className="overflow-x-auto max-h-56 overflow-y-auto">
                            <table className="w-full">
                              <thead>
                                <tr className="text-[10px] uppercase text-slate-400 border-b">
                                  <th className="text-left py-1 pr-2">SKU</th>
                                  <th className="text-left py-1 pr-2">Produto</th>
                                  <th className="text-left py-1 pr-2">NCM</th>
                                  <th className="text-right py-1 pr-2">Qtd</th>
                                  <th className="text-right py-1 pr-2">Custo un.</th>
                                  <th className="text-right py-1">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {nfePreview.items.map((it: any) => (
                                  <tr key={it.sku} className="border-b last:border-0">
                                    <td className="py-1 pr-2 font-mono">{it.sku}</td>
                                    <td className="py-1 pr-2 truncate max-w-[220px]">{it.xProd}</td>
                                    <td className="py-1 pr-2 font-mono">{it.ncm}</td>
                                    <td className="py-1 pr-2 text-right">{it.qty}</td>
                                    <td className="py-1 pr-2 text-right tabular-nums">R$ {Number(it.vUn).toFixed(2)}</td>
                                    <td className="py-1 text-right tabular-nums font-semibold">R$ {Number(it.vProd).toFixed(2)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div className="flex justify-between font-bold text-sm border-t pt-1.5">
                            <span>TOTAL DA NOTA ({nfePreview.items.length} item(ns))</span>
                            <span>R$ {Number(nfePreview.valorTotal).toFixed(2)}</span>
                          </div>
                          {nfePreview.warnings?.length > 0 && (
                            <div className="rounded bg-amber-50 border border-amber-200 px-2 py-1.5 text-amber-800">
                              {nfePreview.warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}
                            </div>
                          )}
                        </div>
                      )
                    )}
                    {nfeResult && (
                      <div className={`mt-2 rounded px-3 py-2 text-xs ${nfeResult.erro || nfeResult.status === 'rejected' ? 'bg-rose-50 border border-rose-200 text-rose-800' : 'bg-emerald-50 border border-emerald-200 text-emerald-800'}`}>
                        {nfeResult.erro ? (
                          <>⚠️ {nfeResult.erro}</>
                        ) : (
                          <>
                            {nfeResult.status === 'authorized'
                              ? `✅ AUTORIZADA${nfeResult.jaEmitida ? ' (já existia — não reemitiu)' : ''}`
                              : nfeResult.status === 'rejected'
                              ? '❌ REJEITADA pela SEFAZ'
                              : `Status: ${nfeResult.status || '—'}`}
                            {nfeResult.numero != null && <> · nº <b>{nfeResult.numero}</b> série {nfeResult.serie || '1'}</>}
                            {nfeResult.tpAmb && <> · <b>{nfeResult.tpAmb === '1' ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO'}</b></>}
                            {nfeResult.cStat && <> · cStat {nfeResult.cStat}</>}
                            {nfeResult.xMotivo && <> · {nfeResult.xMotivo}</>}
                            {nfeResult.chave && <div className="font-mono mt-1 break-all">{nfeResult.chave}</div>}
                            {nfeResult.status === 'authorized' && nfeResult.id && (
                              <button
                                onClick={() => abrirDanfe(nfeResult.id, nfeResult.numero)}
                                className="mt-2 px-3 py-1.5 rounded border-2 border-emerald-400 bg-white hover:bg-emerald-50 text-emerald-700 font-bold"
                              >
                                📄 Abrir DANFE (PDF)
                              </button>
                            )}
                            {Array.isArray(nfeResult.warnings) && nfeResult.warnings.length > 0 && (
                              <div className="mt-1 text-amber-800">
                                {nfeResult.warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="text-xs uppercase text-slate-500 font-semibold mb-2">
                    Itens da remessa ({detail.items.length})
                  </div>
                  <div className="space-y-1">
                    {detail.items.map((it) => {
                      const itTone =
                        it.realignmentStatus === 'received'
                          ? 'bg-emerald-50 border-emerald-200'
                          : it.realignmentStatus === 'missing'
                          ? 'bg-rose-50 border-rose-200'
                          : 'bg-slate-50 border-slate-200';
                      return (
                        <div
                          key={it.id}
                          className={`flex items-center gap-3 p-2 rounded border ${itTone}`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm font-semibold">
                              {it.refCode}
                              {it.cor && <span className="ml-2 text-slate-500">{it.cor}</span>}
                              {it.tamanho && <span className="ml-1 text-slate-500">/{it.tamanho}</span>}
                            </div>
                            {it.descricao && (
                              <div className="text-xs text-slate-500 truncate">
                                {it.descricao}
                              </div>
                            )}
                          </div>
                          <div className="text-xs tabular-nums text-slate-600">
                            qty {it.qtyOrigem}
                          </div>
                          <div className="text-xs">
                            {it.realignmentStatus === 'received' && (
                              <span className="inline-flex items-center gap-1 text-emerald-700">
                                <CheckCircle2 className="w-3 h-3" />
                                Bipado
                              </span>
                            )}
                            {it.realignmentStatus === 'missing' && (
                              <span className="inline-flex items-center gap-1 text-rose-700">
                                <AlertTriangle className="w-3 h-3" />
                                Faltante
                              </span>
                            )}
                            {it.realignmentStatus === 'sent' && (
                              <span className="text-slate-500">Aguardando</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── KPI Card ────────────────────────────────────────────────────────────
function KpiCard({
  label,
  value,
  tone,
  icon: Icon,
  onClick,
  active,
}: {
  label: string;
  value: number;
  tone: 'amber' | 'sky' | 'mint' | 'rose' | 'slate';
  icon: any;
  onClick?: () => void;
  active?: boolean;
}) {
  const TONES: Record<string, { bg: string; text: string; ring: string }> = {
    amber: { bg: '#fef3c7', text: '#854d0e', ring: '#fbbf24' },
    sky: { bg: '#dde7ea', text: '#2e4750', ring: '#6b8a92' },
    mint: { bg: '#e3ebd9', text: '#475636', ring: '#9caf88' },
    rose: { bg: '#f5e6e3', text: '#6e3a40', ring: '#c08081' },
    slate: { bg: '#f1f5f9', text: '#334155', ring: '#94a3b8' },
  };
  const t = TONES[tone];
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`text-left p-3 rounded-lg border transition-all ${
        onClick ? 'hover:shadow-md cursor-pointer' : 'cursor-default'
      } ${active ? 'ring-2 shadow-md' : ''}`}
      style={{
        background: t.bg,
        borderColor: active ? t.ring : 'transparent',
        ['--tw-ring-color' as any]: t.ring,
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <Icon className="w-4 h-4" style={{ color: t.text }} />
      </div>
      <div className="text-2xl font-bold tabular-nums" style={{ color: t.text }}>
        {value}
      </div>
      <div className="text-xs" style={{ color: t.text, opacity: 0.7 }}>
        {label}
      </div>
    </button>
  );
}
