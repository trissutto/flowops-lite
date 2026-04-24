'use client';

/**
 * /retaguarda/realinhamento — Rebalanceia estoque entre lojas.
 *
 * Fluxo (3 etapas · pós-pivot #168..#172):
 *   1) CONFIG: usuário cola REFERÊNCIAS (1 por linha, ex: VMS-223), marca lojas origem
 *      (TODAS CEDEM) e destino (TODAS RECEBEM). Backend consulta Giga e expande cada REF
 *      em todas as suas variações (cor × tamanho).
 *   2) PREVIEW: POST /realignment/preview → plano completo em tabela com REF · COR · TAM
 *      + antes/depois por loja. Usuário pode editar qty ou remover linhas.
 *   3) CONFIRM: POST /realignment/confirm → cria N TransferOrder (tipo=REALINHAMENTO,
 *      realignmentStatus=pending) e o backend emite socket 'realignment:new' pra cada
 *      loja ORIGEM. O /minha-loja da filial mostra o card de alerta e a tela de
 *      separação onde eles confirmam 1 a 1.
 *
 * PDF e WhatsApp foram removidos — o alerta chega direto no app da loja.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Loader2, Shuffle, Send, ArrowRight, AlertTriangle, CheckCircle2, Trash2, ArrowUpFromLine, ArrowDownToLine, Search, Plus, X } from 'lucide-react';

interface Store {
  id: string;
  code: string;
  name: string;
  city?: string | null;
  state?: string | null;
  active: boolean;
}

interface PlanLine {
  sku: string;
  ref: string | null;
  cor: string | null;
  tamanho: string | null;
  desc: string;
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  qty: number;
  stockFromBefore: number;
  stockToBefore: number;
  stockFromAfter: number;
  stockToAfter: number;
}

interface PerSkuReport {
  sku: string;
  totalMoved: number;
  stillMissing: number;
  note?: string;
}

interface PerRefReport {
  ref: string;
  desc: string;
  variants: number;
  totalMoved: number;
  stillMissing: number;
}

interface PreviewResponse {
  input: {
    refs: string[];
    skus: string[];
    origins: string[];
    dests: string[];
    minPerDest: number;
    keepMinOrigin: number;
  };
  stores: Array<{ code: string; name: string; active: boolean; city?: string | null; state?: string | null }>;
  plan: PlanLine[];
  perSku: PerSkuReport[];
  perRef: PerRefReport[];
  notFoundRefs: string[];
  totals: {
    totalMoves: number;
    totalUnits: number;
    skusWithFullCoverage: number;
    skusPartial: number;
    skusUnchanged: number;
    refsScanned: number;
    skusScanned: number;
  };
}

export default function RealinhamentoPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [refsText, setRefsText] = useState('');
  const [originCodes, setOriginCodes] = useState<Set<string>>(new Set());
  const [destCodes, setDestCodes] = useState<Set<string>>(new Set());
  // Padrão 1/1 — config mais frouxa que maximiza oportunidades de
  // realinhamento. Com 2/2 muita peça ficava parada por "já está no alvo".
  const [minPerDest, setMinPerDest] = useState(1);
  const [keepMinOrigin, setKeepMinOrigin] = useState(1);
  const [note, setNote] = useState('');

  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [editedPlan, setEditedPlan] = useState<PlanLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Busca por descrição (pra quando o usuário não sabe a REF exata ou a
  // mesma REF existe em produtos diferentes — ex: BL-5512 blusa + BL-5512 calça)
  const [searchTerm, setSearchTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<
    Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number }>
  >([]);
  const [searchSelected, setSearchSelected] = useState<Set<string>>(new Set());
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmResult, setConfirmResult] = useState<{
    createdCount: number;
    alerts: {
      emitted: number;
      total: number;
      byStore: Array<{ storeCode: string; count: number; ok: boolean; error?: string }>;
    };
  } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) => {
        const sorted = [...arr].sort((a, b) => a.code.localeCompare(b.code));
        setStores(sorted);
      })
      .catch((e) => setError(`Erro carregando lojas: ${e?.message || e}`));
  }, []);

  useEffect(() => {
    setKeepMinOrigin(minPerDest);
  }, [minPerDest]);

  const activeStores = useMemo(() => stores.filter((s) => s.active), [stores]);

  function toggle(set: Set<string>, code: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setter(next);
  }

  function selectAllOrigins() {
    setOriginCodes(new Set(activeStores.map((s) => s.code)));
  }
  function selectAllDests() {
    setDestCodes(new Set(activeStores.map((s) => s.code)));
  }
  function clearOrigins() { setOriginCodes(new Set()); }
  function clearDests() { setDestCodes(new Set()); }

  /**
   * Busca REFs no Gigasistemas por termos da descrição.
   * Backend faz AND LIKE em DESCRICAOCOMPLETA pra cada palavra, agrupa por REF.
   */
  async function handleSearchRefs() {
    const term = searchTerm.trim();
    if (term.length < 2) {
      setSearchError('Digite pelo menos 2 caracteres');
      return;
    }
    setSearchError(null);
    setSearching(true);
    setSearchSelected(new Set());
    try {
      const rows = await api<
        Array<{ REF: string; DESCRICAOCOMPLETA: string; VARIANT_COUNT: number }>
      >(`/realignment/search-refs?term=${encodeURIComponent(term)}`);
      setSearchResults(rows || []);
      setSearchOpen(true);
      if (!rows?.length) setSearchError('Nada encontrado pra esse termo.');
    } catch (e: any) {
      setSearchError(`Erro: ${e?.message || e}`);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function toggleSearchRef(ref: string) {
    const next = new Set(searchSelected);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    setSearchSelected(next);
  }

  function selectAllSearchResults() {
    setSearchSelected(new Set(searchResults.map((r) => r.REF)));
  }
  function clearSearchSelection() {
    setSearchSelected(new Set());
  }

  /** Adiciona REFs selecionadas no textarea principal (sem duplicar). */
  function addSelectedRefsToInput() {
    if (!searchSelected.size) return;
    const existing = new Set(
      refsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const toAdd = [...searchSelected].filter((r) => !existing.has(r));
    if (!toAdd.length) {
      setSearchError('Essas REFs já estavam na lista.');
      return;
    }
    const next = [
      ...existing,
      ...toAdd,
    ].join('\n');
    setRefsText(next);
    setSearchError(null);
    // Limpa busca pra feedback visual
    setSearchSelected(new Set());
    setSearchOpen(false);
    setSearchResults([]);
    setSearchTerm('');
  }

  async function handlePreview() {
    setError(null);
    setPreview(null);
    setConfirmResult(null);

    const refs = refsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (refs.length === 0) {
      setError('Cole ao menos uma REFERÊNCIA (1 por linha).');
      return;
    }
    if (originCodes.size === 0) {
      setError('Selecione ao menos uma loja ORIGEM.');
      return;
    }
    if (destCodes.size === 0) {
      setError('Selecione ao menos uma loja DESTINO.');
      return;
    }

    setLoading(true);
    try {
      const data = await api<PreviewResponse>('/realignment/preview', {
        method: 'POST',
        body: JSON.stringify({
          refs,
          originStoreCodes: Array.from(originCodes),
          destStoreCodes: Array.from(destCodes),
          minPerDest,
          keepMinOrigin,
        }),
      });
      setPreview(data);
      setEditedPlan(data.plan.map((p) => ({ ...p })));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  function updateLineQty(idx: number, newQty: number) {
    setEditedPlan((prev) => {
      const next = [...prev];
      const line = next[idx];
      const maxByOrigin = line.stockFromBefore - Math.max(0, preview?.input.keepMinOrigin || 0);
      const clamped = Math.max(0, Math.min(newQty, Math.max(0, maxByOrigin)));
      next[idx] = {
        ...line,
        qty: clamped,
        stockFromAfter: line.stockFromBefore - clamped,
        stockToAfter: line.stockToBefore + clamped,
      };
      return next;
    });
  }

  function removeLine(idx: number) {
    setEditedPlan((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleConfirm() {
    setError(null);
    if (editedPlan.filter((l) => l.qty > 0).length === 0) {
      setError('Plano vazio (todas as linhas com qty=0).');
      return;
    }
    setConfirming(true);
    try {
      const res = await api<{
        createdCount: number;
        alerts: {
          emitted: number;
          total: number;
          byStore: Array<{ storeCode: string; count: number; ok: boolean; error?: string }>;
        };
      }>(
        '/realignment/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            plan: editedPlan.filter((l) => l.qty > 0).map((l) => ({
              sku: l.sku,
              ref: l.ref,
              cor: l.cor,
              tamanho: l.tamanho,
              desc: l.desc,
              fromCode: l.fromCode,
              toCode: l.toCode,
              qty: l.qty,
              stockFromBefore: l.stockFromBefore,
            })),
            note: note.trim() || undefined,
          }),
        },
      );
      setConfirmResult(res);
      setPreview(null);
      setEditedPlan([]);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setConfirming(false);
    }
  }

  const editedTotals = useMemo(() => {
    const totalUnits = editedPlan.reduce((a, l) => a + l.qty, 0);
    const totalMoves = editedPlan.filter((l) => l.qty > 0).length;
    return { totalUnits, totalMoves };
  }, [editedPlan]);

  // Agrupa plano por REF pra exibir visualmente em blocos
  const planByRef = useMemo(() => {
    const map = new Map<string, PlanLine[]>();
    for (const line of editedPlan) {
      const key = line.ref || line.sku;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(line);
    }
    return Array.from(map.entries());
  }, [editedPlan]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center shadow">
          <Shuffle className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Realinhamento de Estoque</h1>
          <p className="text-sm text-slate-500">
            Informe as referências, o sistema busca todas as variações no Gigasistemas e gera as ordens de transferência.
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
          <div className="text-sm">{error}</div>
        </div>
      )}

      {confirmResult && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg px-4 py-3 flex items-start gap-2">
          <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
          <div className="text-sm">
            <div className="font-semibold">
              {confirmResult.createdCount} ordens criadas · alerta enviado pra{' '}
              {confirmResult.alerts.emitted}/{confirmResult.alerts.total} loja(s) origem.
            </div>
            <div className="mt-0.5 text-xs text-emerald-800/80">
              As lojas vão receber o alerta no app <b>/minha-loja</b> em tempo real.
              Elas confirmam o envio uma a uma e você acompanha no histórico.
            </div>
            {confirmResult.alerts.byStore.some((s) => !s.ok) && (
              <ul className="list-disc ml-5 mt-1 text-xs text-red-700">
                {confirmResult.alerts.byStore
                  .filter((s) => !s.ok)
                  .map((f, i) => (
                    <li key={i}>
                      {f.storeCode}: {f.error || 'erro ao emitir alerta'}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ETAPA 1 — Config */}
      <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">1. Configuração</h2>
          <div className="text-xs text-slate-500">
            {stores.length} lojas cadastradas · {activeStores.length} ativas
          </div>
        </div>

        {/* Refs */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">
            Referências do Gigasistemas (1 por linha)
          </label>
          <textarea
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 min-h-[140px]"
            placeholder={`Ex:\nVMS-223\nVMS-224\nBL-5512`}
            value={refsText}
            onChange={(e) => setRefsText(e.target.value)}
          />
          <div className="text-xs text-slate-500 mt-1">
            {refsText.split('\n').filter((s) => s.trim()).length} referência(s). O sistema expande automaticamente em todas as cores e tamanhos.
          </div>

          {/* Busca por descrição — útil quando a mesma REF se repete em produtos diferentes */}
          <div className="mt-3 border border-indigo-200 bg-indigo-50/60 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <Search className="w-4 h-4 text-indigo-700" />
              <div className="text-sm font-semibold text-indigo-900">
                Não sabe a REF? Busque pela descrição
              </div>
            </div>
            <div className="text-xs text-indigo-900/70 mb-2">
              Digite palavras da descrição (ex: <i>blusa azul 48</i>, <i>vestido boho</i>) — o sistema lista as REFs correspondentes pra você marcar.
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                className="flex-1 border border-indigo-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white"
                placeholder="Ex: blusa manga longa preta"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSearchRefs(); } }}
              />
              <button
                type="button"
                onClick={handleSearchRefs}
                disabled={searching || searchTerm.trim().length < 2}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold rounded-lg px-4 py-2 text-sm transition-all"
              >
                {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Buscar
              </button>
            </div>
            {searchError && (
              <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                {searchError}
              </div>
            )}

            {searchOpen && searchResults.length > 0 && (
              <div className="mt-3 bg-white border border-indigo-200 rounded-lg">
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-slate-50 rounded-t-lg">
                  <div className="text-xs font-semibold text-slate-700">
                    {searchResults.length} REF(s) encontrada(s) ·{' '}
                    <span className="text-indigo-700">{searchSelected.size} selecionada(s)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={selectAllSearchResults}
                      className="text-xs text-indigo-700 hover:underline"
                    >
                      Marcar tudo
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      type="button"
                      onClick={clearSearchSelection}
                      className="text-xs text-slate-500 hover:underline"
                    >
                      Limpar
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      type="button"
                      onClick={() => { setSearchOpen(false); setSearchResults([]); setSearchSelected(new Set()); }}
                      className="text-slate-400 hover:text-slate-700"
                      title="Fechar"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="max-h-[340px] overflow-y-auto divide-y divide-slate-100">
                  {searchResults.map((r) => {
                    const checked = searchSelected.has(r.REF);
                    return (
                      <label
                        key={r.REF}
                        className={`flex items-start gap-3 px-3 py-2 cursor-pointer transition-colors ${
                          checked ? 'bg-indigo-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSearchRef(r.REF)}
                          className="mt-0.5 w-4 h-4 accent-indigo-600"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-indigo-800 bg-indigo-100 rounded px-1.5 py-0.5">
                              {r.REF}
                            </span>
                            <span className="text-xs text-slate-500">
                              {r.VARIANT_COUNT} variação(ões)
                            </span>
                          </div>
                          <div className="text-sm text-slate-700 truncate mt-0.5">
                            {r.DESCRICAOCOMPLETA}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between px-3 py-2 border-t border-slate-200 bg-slate-50 rounded-b-lg">
                  <div className="text-xs text-slate-500">
                    Marque as REFs corretas (útil quando a mesma REF se repete em produtos diferentes).
                  </div>
                  <button
                    type="button"
                    onClick={addSelectedRefsToInput}
                    disabled={!searchSelected.size}
                    className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-bold rounded-lg px-3 py-2 text-xs transition-all"
                  >
                    <Plus className="w-4 h-4" />
                    Adicionar selecionadas
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Ações em massa */}
        <div className="grid sm:grid-cols-2 gap-3">
          <button
            onClick={selectAllOrigins}
            className="group flex items-center justify-center gap-2 bg-indigo-50 hover:bg-indigo-600 hover:text-white border-2 border-indigo-200 hover:border-indigo-700 text-indigo-800 font-bold rounded-xl px-4 py-3 transition-all"
          >
            <ArrowUpFromLine className="w-5 h-5" />
            TODAS CEDEM
            <span className="ml-1 text-xs font-normal opacity-75">
              (marca {activeStores.length} como origem)
            </span>
          </button>
          <button
            onClick={selectAllDests}
            className="group flex items-center justify-center gap-2 bg-emerald-50 hover:bg-emerald-600 hover:text-white border-2 border-emerald-200 hover:border-emerald-700 text-emerald-800 font-bold rounded-xl px-4 py-3 transition-all"
          >
            <ArrowDownToLine className="w-5 h-5" />
            TODAS RECEBEM
            <span className="ml-1 text-xs font-normal opacity-75">
              (marca {activeStores.length} como destino)
            </span>
          </button>
        </div>

        {/* Lojas — pills ON/OFF */}
        <div className="grid md:grid-cols-2 gap-5">
          {/* ORIGEM */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-slate-700">
                Lojas ORIGEM <span className="text-slate-400 font-normal">({originCodes.size}/{activeStores.length})</span>
              </div>
              <button
                onClick={clearOrigins}
                className="text-xs text-slate-500 hover:text-slate-800 hover:underline"
              >
                Limpar
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-2 gap-1.5 border border-slate-200 rounded-lg p-2 max-h-[320px] overflow-y-auto bg-slate-50/40">
              {activeStores.map((s) => {
                const on = originCodes.has(s.code);
                return (
                  <button
                    key={'o' + s.code}
                    type="button"
                    onClick={() => toggle(originCodes, s.code, setOriginCodes)}
                    className={`relative flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-left font-medium border transition-all ${
                      on
                        ? 'bg-indigo-600 border-indigo-700 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:border-indigo-400 hover:bg-indigo-50'
                    }`}
                  >
                    <span className={`font-mono text-xs w-7 shrink-0 ${on ? 'text-indigo-100' : 'text-slate-400'}`}>
                      {s.code}
                    </span>
                    <span className="truncate">{s.name}</span>
                    {on && <span className="ml-auto text-xs font-bold opacity-90">ON</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* DESTINO */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-slate-700">
                Lojas DESTINO <span className="text-slate-400 font-normal">({destCodes.size}/{activeStores.length})</span>
              </div>
              <button
                onClick={clearDests}
                className="text-xs text-slate-500 hover:text-slate-800 hover:underline"
              >
                Limpar
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-2 gap-1.5 border border-slate-200 rounded-lg p-2 max-h-[320px] overflow-y-auto bg-slate-50/40">
              {activeStores.map((s) => {
                const on = destCodes.has(s.code);
                return (
                  <button
                    key={'d' + s.code}
                    type="button"
                    onClick={() => toggle(destCodes, s.code, setDestCodes)}
                    className={`relative flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-left font-medium border transition-all ${
                      on
                        ? 'bg-emerald-600 border-emerald-700 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:border-emerald-400 hover:bg-emerald-50'
                    }`}
                  >
                    <span className={`font-mono text-xs w-7 shrink-0 ${on ? 'text-emerald-100' : 'text-slate-400'}`}>
                      {s.code}
                    </span>
                    <span className="truncate">{s.name}</span>
                    {on && <span className="ml-auto text-xs font-bold opacity-90">ON</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-1 uppercase tracking-wide">
              Quantas peças nas lojas destino
            </label>
            <input
              type="number"
              min={0}
              value={minPerDest}
              onChange={(e) => setMinPerDest(Math.max(0, Number(e.target.value) || 0))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold tabular-nums"
            />
            <div className="text-xs text-slate-500 mt-1">Cada destino precisa ter ≥ este valor por variação.</div>
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-800 mb-1 uppercase tracking-wide">
              Quantas peças nas lojas origem
            </label>
            <input
              type="number"
              min={0}
              value={keepMinOrigin}
              onChange={(e) => setKeepMinOrigin(Math.max(0, Number(e.target.value) || 0))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold tabular-nums"
            />
            <div className="text-xs text-slate-500 mt-1">Origem nunca fica abaixo deste nº.</div>
          </div>
          <div className="flex items-end">
            <button
              onClick={handlePreview}
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-semibold rounded-lg px-4 py-2.5 flex items-center justify-center gap-2 transition"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
              {loading ? 'Calculando...' : 'Calcular plano'}
            </button>
          </div>
        </div>
      </section>

      {/* ETAPA 2 — Preview */}
      {preview && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-lg font-bold text-slate-800">2. Plano sugerido</h2>
            <div className="flex flex-wrap gap-3 text-xs">
              <span className="bg-indigo-50 text-indigo-800 px-2.5 py-1 rounded-full font-semibold">
                {editedTotals.totalMoves} movimentações
              </span>
              <span className="bg-indigo-50 text-indigo-800 px-2.5 py-1 rounded-full font-semibold">
                {editedTotals.totalUnits} unidades
              </span>
              <span className="bg-slate-100 text-slate-700 px-2.5 py-1 rounded-full">
                {preview.totals.refsScanned} REF(s) · {preview.totals.skusScanned} variações
              </span>
              {preview.notFoundRefs.length > 0 && (
                <span className="bg-amber-50 text-amber-800 px-2.5 py-1 rounded-full">
                  {preview.notFoundRefs.length} REF(s) não encontrada(s)
                </span>
              )}
            </div>
          </div>

          {preview.notFoundRefs.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2 text-xs">
              <b>Não encontradas no Giga:</b> {preview.notFoundRefs.join(', ')}
            </div>
          )}

          {/* Resumo por REF */}
          {preview.perRef.length > 0 && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {preview.perRef.map((r, i) => {
                const statusColor =
                  r.totalMoved === 0
                    ? 'bg-slate-100 text-slate-600 border-slate-200'
                    : r.stillMissing > 0
                    ? 'bg-amber-50 text-amber-900 border-amber-200'
                    : 'bg-emerald-50 text-emerald-900 border-emerald-200';
                return (
                  <div key={i} className={`border rounded-lg px-3 py-2 text-xs ${statusColor}`}>
                    <div className="font-mono font-bold text-sm">{r.ref}</div>
                    {r.desc && <div className="truncate">{r.desc}</div>}
                    <div className="mt-1 flex gap-2 tabular-nums">
                      <span>{r.variants} variação(ões)</span>
                      <span>·</span>
                      <span>movidas: {r.totalMoved}</span>
                      {r.stillMissing > 0 && <span>· faltam: {r.stillMissing}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {editedPlan.length === 0 ? (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center text-sm text-slate-600">
              Nenhuma movimentação necessária para as REFs/lojas selecionadas.
            </div>
          ) : (
            <div className="space-y-4">
              {planByRef.map(([refKey, lines]) => {
                const desc = lines[0]?.desc || '';
                const totalQty = lines.reduce((a, l) => a + l.qty, 0);
                return (
                  <div key={refKey} className="border border-slate-200 rounded-lg overflow-hidden">
                    <div className="bg-slate-50 px-3 py-2 flex items-center justify-between">
                      <div>
                        <span className="font-mono font-bold text-sm text-slate-800">{refKey}</span>
                        {desc && <span className="ml-2 text-xs text-slate-500">{desc}</span>}
                      </div>
                      <span className="text-xs bg-white border border-slate-200 rounded-full px-2 py-0.5 font-semibold text-slate-700">
                        {lines.length} linha(s) · {totalQty}un
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-slate-500 bg-white border-b border-slate-100">
                            <th className="px-2 py-1.5">Cor</th>
                            <th className="px-2 py-1.5">Tam</th>
                            <th className="px-2 py-1.5">Origem</th>
                            <th className="px-2 py-1.5 text-center">Estoque</th>
                            <th className="px-2 py-1.5 text-center">Qty</th>
                            <th className="px-2 py-1.5">Destino</th>
                            <th className="px-2 py-1.5 text-center">Estoque dest</th>
                            <th className="px-2 py-1.5"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {lines.map((line) => {
                            const idx = editedPlan.indexOf(line);
                            return (
                              <tr key={idx} className="hover:bg-slate-50 transition">
                                <td className="px-2 py-1.5 text-xs font-semibold text-slate-700">{line.cor || '—'}</td>
                                <td className="px-2 py-1.5 text-xs font-semibold text-slate-700">{line.tamanho || '—'}</td>
                                <td className="px-2 py-1.5">
                                  <span className="font-semibold">{line.fromCode}</span>
                                  <span className="text-xs text-slate-500 ml-1 hidden sm:inline">{line.fromName}</span>
                                </td>
                                <td className="px-2 py-1.5 text-center tabular-nums">
                                  <span className="text-slate-500">{line.stockFromBefore}</span>
                                  <ArrowRight className="inline w-3 h-3 mx-1 text-slate-400" />
                                  <span className={`font-semibold ${line.stockFromAfter < (preview.input.keepMinOrigin || 0) ? 'text-red-600' : 'text-slate-800'}`}>
                                    {line.stockFromAfter}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5 text-center">
                                  <input
                                    type="number"
                                    min={0}
                                    max={line.stockFromBefore - (preview.input.keepMinOrigin || 0)}
                                    value={line.qty}
                                    onChange={(e) => updateLineQty(idx, Number(e.target.value) || 0)}
                                    className="w-14 border border-slate-300 rounded px-2 py-0.5 text-center font-bold text-indigo-700"
                                  />
                                </td>
                                <td className="px-2 py-1.5">
                                  <span className="font-semibold">{line.toCode}</span>
                                  <span className="text-xs text-slate-500 ml-1 hidden sm:inline">{line.toName}</span>
                                </td>
                                <td className="px-2 py-1.5 text-center tabular-nums">
                                  <span className="text-slate-500">{line.stockToBefore}</span>
                                  <ArrowRight className="inline w-3 h-3 mx-1 text-slate-400" />
                                  <span className="font-semibold text-emerald-700">{line.stockToAfter}</span>
                                </td>
                                <td className="px-2 py-1.5 text-right">
                                  <button
                                    onClick={() => removeLine(idx)}
                                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                                    title="Remover"
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ETAPA 3 — Confirm (direto, sem PDF/WhatsApp) */}
      {preview && editedPlan.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow">
              <Send className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">3. Despachar pras lojas</h2>
              <p className="text-sm text-slate-500">
                Cada loja ORIGEM recebe um alerta em tempo real no app <b>/minha-loja</b>.
                Ela abre a tela de separação e marca cada peça como enviada. Você acompanha no histórico.
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Observação (opcional)
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex: pro lançamento do sábado"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <button
            onClick={handleConfirm}
            disabled={confirming || editedTotals.totalMoves === 0}
            className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-semibold rounded-lg px-5 py-2.5 flex items-center justify-center gap-2 transition"
          >
            {confirming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {confirming
              ? 'Enviando pras lojas...'
              : `Enviar ${editedTotals.totalMoves} ordem(ns) pras lojas`}
          </button>
        </section>
      )}
    </div>
  );
}
