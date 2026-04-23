'use client';

/**
 * /retaguarda/realinhamento — Rebalanceia estoque entre lojas.
 *
 * Fluxo (3 etapas):
 *   1) CONFIG: usuário cola SKUs (1 por linha), marca lojas origem, lojas destino,
 *      define "alvo mínimo por destino" e "manter mínimo na origem".
 *   2) PREVIEW: chama POST /realignment/preview → mostra plano completo em tabela
 *      com antes/depois por loja, total de movimentações, SKUs sem cobertura total.
 *      Usuário pode editar quantidades linha a linha (ex: reduzir qty=5 pra 3).
 *   3) CONFIRM: chama POST /realignment/confirm → cria TransferOrder tipo=REALINHAMENTO
 *      e opcionalmente dispara WhatsApp consolidado por loja origem.
 *
 * Racional de UX:
 *   - "Alvo mínimo" é o conceito chave (cada destino precisa ter X peças de cada SKU).
 *   - "Manter mínimo na origem" evita desabastecer quem manda (default = alvo mínimo).
 *   - Checkbox "Toggle All" em origem e destino pra casos "todas pra todas".
 *   - Preview mostra linha vermelha se ficar parcial (não cobriu o mínimo por falta
 *     de excedente total).
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Loader2, Shuffle, Send, ArrowRight, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react';

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

interface PreviewResponse {
  input: {
    skus: string[];
    origins: string[];
    dests: string[];
    minPerDest: number;
    keepMinOrigin: number;
  };
  stores: Array<{ code: string; name: string; active: boolean; city?: string | null; state?: string | null }>;
  plan: PlanLine[];
  perSku: PerSkuReport[];
  totals: {
    totalMoves: number;
    totalUnits: number;
    skusWithFullCoverage: number;
    skusPartial: number;
    skusUnchanged: number;
  };
}

export default function RealinhamentoPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [skusText, setSkusText] = useState('');
  const [originCodes, setOriginCodes] = useState<Set<string>>(new Set());
  const [destCodes, setDestCodes] = useState<Set<string>>(new Set());
  const [minPerDest, setMinPerDest] = useState(2);
  const [keepMinOrigin, setKeepMinOrigin] = useState(2);
  const [note, setNote] = useState('');
  const [sendWhatsapp, setSendWhatsapp] = useState(true);

  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [editedPlan, setEditedPlan] = useState<PlanLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmResult, setConfirmResult] = useState<{ createdCount: number; whatsapp: { sent: number; attempted: number; failures: Array<{ storeCode: string; error?: string }> } } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) => {
        const sorted = [...arr].sort((a, b) => a.code.localeCompare(b.code));
        setStores(sorted);
      })
      .catch((e) => setError(`Erro carregando lojas: ${e?.message || e}`));
  }, []);

  // Sync keepMinOrigin com minPerDest quando usuário só mexe no alvo
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

  function selectAll(scope: 'origin' | 'dest') {
    const all = new Set(activeStores.map((s) => s.code));
    if (scope === 'origin') setOriginCodes(all);
    else setDestCodes(all);
  }

  function clearAll(scope: 'origin' | 'dest') {
    if (scope === 'origin') setOriginCodes(new Set());
    else setDestCodes(new Set());
  }

  async function handlePreview() {
    setError(null);
    setPreview(null);
    setConfirmResult(null);

    const skus = skusText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (skus.length === 0) {
      setError('Cole ao menos um SKU (1 por linha).');
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
          skus,
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
      const res = await api<{ createdCount: number; whatsapp: { sent: number; attempted: number; failures: Array<{ storeCode: string; error?: string }> } }>(
        '/realignment/confirm',
        {
          method: 'POST',
          body: JSON.stringify({
            plan: editedPlan.filter((l) => l.qty > 0).map((l) => ({
              sku: l.sku,
              fromCode: l.fromCode,
              toCode: l.toCode,
              qty: l.qty,
              stockFromBefore: l.stockFromBefore,
            })),
            sendWhatsapp,
            note: note.trim() || undefined,
          }),
        },
      );
      setConfirmResult(res);
      // Limpa pra próximo uso
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
            Gera ordens de transferência entre lojas pra rebalancear estoque. Consulta ao vivo o Gigasistemas.
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
              {confirmResult.createdCount} transferências criadas com sucesso.
            </div>
            {confirmResult.whatsapp.attempted > 0 && (
              <div className="mt-1">
                WhatsApp: {confirmResult.whatsapp.sent}/{confirmResult.whatsapp.attempted} disparados.
                {confirmResult.whatsapp.failures.length > 0 && (
                  <ul className="list-disc ml-5 mt-1 text-xs text-red-700">
                    {confirmResult.whatsapp.failures.map((f, i) => (
                      <li key={i}>
                        {f.storeCode}: {f.error || 'erro'}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
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

        {/* SKUs */}
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">
            SKUs do Gigasistemas (1 por linha)
          </label>
          <textarea
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 min-h-[140px]"
            placeholder={`Ex:\nVMS-223-PRETO-M\nVMS-223-PRETO-G\nVMS-224-AZUL-UN`}
            value={skusText}
            onChange={(e) => setSkusText(e.target.value)}
          />
          <div className="text-xs text-slate-500 mt-1">
            {skusText.split('\n').filter((s) => s.trim()).length} SKU(s) na lista.
          </div>
        </div>

        {/* Lojas */}
        <div className="grid md:grid-cols-2 gap-5">
          {/* Origem */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-slate-700">
                Lojas ORIGEM <span className="text-slate-400 font-normal">({originCodes.size})</span>
              </div>
              <div className="flex gap-2 text-xs">
                <button onClick={() => selectAll('origin')} className="text-indigo-600 hover:underline">
                  Todas
                </button>
                <span className="text-slate-300">|</span>
                <button onClick={() => clearAll('origin')} className="text-slate-600 hover:underline">
                  Limpar
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1 border border-slate-200 rounded-lg p-2 max-h-[260px] overflow-y-auto">
              {activeStores.map((s) => (
                <label
                  key={'o' + s.code}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm transition ${
                    originCodes.has(s.code)
                      ? 'bg-indigo-50 border border-indigo-200'
                      : 'hover:bg-slate-50 border border-transparent'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={originCodes.has(s.code)}
                    onChange={() => toggle(originCodes, s.code, setOriginCodes)}
                    className="accent-indigo-600"
                  />
                  <span className="font-mono text-xs text-slate-500 w-10">{s.code}</span>
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Destino */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-slate-700">
                Lojas DESTINO <span className="text-slate-400 font-normal">({destCodes.size})</span>
              </div>
              <div className="flex gap-2 text-xs">
                <button onClick={() => selectAll('dest')} className="text-indigo-600 hover:underline">
                  Todas
                </button>
                <span className="text-slate-300">|</span>
                <button onClick={() => clearAll('dest')} className="text-slate-600 hover:underline">
                  Limpar
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1 border border-slate-200 rounded-lg p-2 max-h-[260px] overflow-y-auto">
              {activeStores.map((s) => (
                <label
                  key={'d' + s.code}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm transition ${
                    destCodes.has(s.code)
                      ? 'bg-emerald-50 border border-emerald-200'
                      : 'hover:bg-slate-50 border border-transparent'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={destCodes.has(s.code)}
                    onChange={() => toggle(destCodes, s.code, setDestCodes)}
                    className="accent-emerald-600"
                  />
                  <span className="font-mono text-xs text-slate-500 w-10">{s.code}</span>
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Parâmetros numéricos */}
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Alvo mínimo por destino
            </label>
            <input
              type="number"
              min={0}
              value={minPerDest}
              onChange={(e) => setMinPerDest(Math.max(0, Number(e.target.value) || 0))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
            <div className="text-xs text-slate-500 mt-1">Cada destino precisa ter ≥ este valor por SKU.</div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Manter mínimo na origem
            </label>
            <input
              type="number"
              min={0}
              value={keepMinOrigin}
              onChange={(e) => setKeepMinOrigin(Math.max(0, Number(e.target.value) || 0))}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
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
              <span className="bg-emerald-50 text-emerald-800 px-2.5 py-1 rounded-full">
                {preview.totals.skusWithFullCoverage} SKU(s) totalmente cobertos
              </span>
              {preview.totals.skusPartial > 0 && (
                <span className="bg-amber-50 text-amber-800 px-2.5 py-1 rounded-full">
                  {preview.totals.skusPartial} SKU(s) parciais
                </span>
              )}
              {preview.totals.skusUnchanged > 0 && (
                <span className="bg-slate-100 text-slate-700 px-2.5 py-1 rounded-full">
                  {preview.totals.skusUnchanged} SKU(s) sem movimentação
                </span>
              )}
            </div>
          </div>

          {/* Tabela de movimentações */}
          {editedPlan.length === 0 ? (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center text-sm text-slate-600">
              Nenhuma movimentação necessária para os SKUs/lojas selecionados.
            </div>
          ) : (
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-sm border-separate border-spacing-y-1">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wide">
                    <th className="px-2 py-1.5">SKU</th>
                    <th className="px-2 py-1.5">Origem</th>
                    <th className="px-2 py-1.5 text-center">Estoque</th>
                    <th className="px-2 py-1.5 text-center">Qty</th>
                    <th className="px-2 py-1.5 text-center">Destino</th>
                    <th className="px-2 py-1.5 text-center">Estoque dest</th>
                    <th className="px-2 py-1.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {editedPlan.map((line, idx) => (
                    <tr key={idx} className="bg-slate-50 hover:bg-slate-100 transition">
                      <td className="px-2 py-2 font-mono text-xs font-semibold rounded-l-lg">
                        {line.sku}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-col">
                          <span className="font-semibold">{line.fromCode}</span>
                          <span className="text-xs text-slate-500">{line.fromName}</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center tabular-nums">
                        <span className="text-slate-500">{line.stockFromBefore}</span>
                        <ArrowRight className="inline w-3 h-3 mx-1 text-slate-400" />
                        <span className={`font-semibold ${line.stockFromAfter < (preview.input.keepMinOrigin || 0) ? 'text-red-600' : 'text-slate-800'}`}>
                          {line.stockFromAfter}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <input
                          type="number"
                          min={0}
                          max={line.stockFromBefore - (preview.input.keepMinOrigin || 0)}
                          value={line.qty}
                          onChange={(e) => updateLineQty(idx, Number(e.target.value) || 0)}
                          className="w-16 border border-slate-300 rounded px-2 py-1 text-center font-bold text-indigo-700"
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <div className="flex flex-col items-center">
                          <span className="font-semibold">{line.toCode}</span>
                          <span className="text-xs text-slate-500">{line.toName}</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center tabular-nums">
                        <span className="text-slate-500">{line.stockToBefore}</span>
                        <ArrowRight className="inline w-3 h-3 mx-1 text-slate-400" />
                        <span className="font-semibold text-emerald-700">{line.stockToAfter}</span>
                      </td>
                      <td className="px-2 py-2 text-right rounded-r-lg">
                        <button
                          onClick={() => removeLine(idx)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                          title="Remover linha"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Relatório por SKU */}
          {preview.perSku.some((p) => p.stillMissing > 0 || p.note) && (
            <details className="border border-slate-200 rounded-lg">
              <summary className="px-3 py-2 text-sm font-semibold text-slate-700 cursor-pointer hover:bg-slate-50">
                Detalhamento por SKU ({preview.perSku.length})
              </summary>
              <div className="border-t border-slate-200 divide-y divide-slate-100">
                {preview.perSku.map((p, i) => (
                  <div key={i} className="px-3 py-2 text-sm flex items-center justify-between gap-2">
                    <span className="font-mono font-semibold">{p.sku}</span>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-slate-600">movidas: {p.totalMoved}</span>
                      {p.stillMissing > 0 && (
                        <span className="text-amber-700 font-semibold">
                          faltaram: {p.stillMissing}
                        </span>
                      )}
                      {p.note && <span className="text-slate-500 italic">· {p.note}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {/* ETAPA 3 — Confirm */}
      {preview && editedPlan.length > 0 && (
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
          <h2 className="text-lg font-bold text-slate-800">3. Confirmar e enviar</h2>

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

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={sendWhatsapp}
              onChange={(e) => setSendWhatsapp(e.target.checked)}
              className="accent-indigo-600"
            />
            Disparar WhatsApp consolidado pra cada loja origem
          </label>

          <button
            onClick={handleConfirm}
            disabled={confirming || editedTotals.totalMoves === 0}
            className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-semibold rounded-lg px-5 py-2.5 flex items-center justify-center gap-2 transition"
          >
            {confirming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {confirming
              ? 'Criando ordens...'
              : `Gerar ${editedTotals.totalMoves} transferência(s)`}
          </button>
        </section>
      )}
    </div>
  );
}
