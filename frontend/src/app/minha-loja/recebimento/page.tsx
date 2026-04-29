'use client';

/**
 * /minha-loja/recebimento — tela de recebimento de remessa de realinhamento.
 *
 * Fluxo:
 *   1. Lista as remessas in_transit chegando pra essa loja (toStoreCode).
 *   2. Vendedora clica em uma → abre tela de bipagem.
 *   3. Bipa cada peça com leitor de código de barras (ou digita SKU).
 *   4. Sistema marca cada item como "received" à medida que casa.
 *   5. Se alguma peça não chegou, marca como "missing" (cancela cobrança).
 *   6. Quando 100% conferido (received OU missing), botão "Dar Entrada"
 *      libera. Click → +1 estoque Giga loja destino.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Loader2, RefreshCw, Package, AlertCircle, CheckCircle2,
  Inbox, Scan, X, Send,
} from 'lucide-react';
import { api } from '@/lib/api';

type Shipment = {
  id: string;
  code: string;
  fromStoreCode: string;
  fromStoreName: string;
  toStoreCode: string;
  toStoreName: string;
  status: string;
  sentAt: string | null;
  totalItems: number;
  totalQty: number;
};

type ShipmentItem = {
  id: string;
  refCode: string;
  cor: string | null;
  tamanho: string | null;
  qtyOrigem: number;
  descricao: string | null;
  realignmentStatus: string;
  realignmentReceivedAt: string | null;
  realignmentMissingAt: string | null;
  realignmentMissingNote: string | null;
};

type ShipmentDetail = Shipment & { items: ShipmentItem[] };

type MeProfile = { storeId: string; storeName: string; role: string };

export default function RecebimentoPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ShipmentDetail | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // ── Loaders ──
  const loadShipments = useCallback(async () => {
    try {
      const data = await api<Shipment[]>('/realignment/shipments/incoming');
      setShipments(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Erro carregando remessas');
    }
  }, []);

  const loadShipmentDetail = useCallback(async (shipmentId: string) => {
    try {
      const data = await api<ShipmentDetail>(`/realignment/shipments/${shipmentId}`);
      setSelected(data);
    } catch (e: any) {
      setError(e?.message || 'Erro carregando detalhe da remessa');
    }
  }, []);

  // ── Boot ──
  useEffect(() => {
    (async () => {
      try {
        const profile = await api<MeProfile>('/auth/me');
        if (profile.role !== 'store') {
          router.push('/');
          return;
        }
        setMe(profile);
        await loadShipments();
      } catch (e: any) {
        setError(e?.message || 'Erro');
        if (String(e?.message || '').startsWith('401')) router.push('/login');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Foca o input de scanner sempre que abre detalhe
  useEffect(() => {
    if (selected && inputRef.current) inputRef.current.focus();
  }, [selected]);

  // Auto-some o feedback após 2.5s
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 2500);
    return () => clearTimeout(t);
  }, [feedback]);

  // ── Actions ──
  const handleScan = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!selected) return;
      const sku = scanInput.trim();
      if (!sku) return;
      setScanning(true);
      // Limpa input ANTES da resposta — vendedora pode bipar próximo já
      setScanInput('');
      try {
        const res = await api<{ ok: boolean; transferOrderId: string; refCode: string }>(
          `/realignment/shipments/${selected.id}/scan`,
          { method: 'POST', body: JSON.stringify({ sku }) },
        );
        setFeedback({ type: 'ok', msg: `✅ ${res.refCode} conferida` });
        // ─── Atualização OTIMISTA local — sem refetch ───
        // Atualiza só o item bipado pra status='received'. Evita chamada
        // de rede pesada que carrega 61 itens a cada bipagem (gargalo
        // principal de UX antes desta otimização).
        setSelected((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items.map((it) =>
              it.id === res.transferOrderId
                ? {
                    ...it,
                    realignmentStatus: 'received',
                    realignmentReceivedAt: new Date().toISOString(),
                  }
                : it,
            ),
          };
        });
      } catch (e: any) {
        const msg = String(e?.message || '').replace(/^\d+:\s*/, '');
        setFeedback({ type: 'err', msg: `❌ ${msg}` });
      } finally {
        setScanning(false);
        inputRef.current?.focus();
      }
    },
    [selected, scanInput],
  );

  const handleMarkMissing = useCallback(
    async (item: ShipmentItem) => {
      if (!selected) return;
      const note = prompt(
        `Marcar ${item.refCode} ${item.cor || ''}/${item.tamanho || ''} como FALTANTE?\n\n` +
          `Não vai dar entrada Giga e a cobrança financeira dela será cancelada.\n\n` +
          `Motivo (opcional):`,
      );
      if (note === null) return; // cancelou
      try {
        await api(`/realignment/shipments/${selected.id}/missing`, {
          method: 'POST',
          body: JSON.stringify({ transferOrderId: item.id, note }),
        });
        setFeedback({ type: 'ok', msg: `Item marcado como faltante` });
        // Atualização otimista local (mesma estratégia do handleScan)
        setSelected((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id
                ? {
                    ...it,
                    realignmentStatus: 'missing',
                    realignmentMissingAt: new Date().toISOString(),
                    realignmentMissingNote: note,
                  }
                : it,
            ),
          };
        });
      } catch (e: any) {
        setFeedback({ type: 'err', msg: e?.message || 'Erro' });
      }
    },
    [selected],
  );

  const handleConfirmReceived = useCallback(async () => {
    if (!selected) return;
    const pendingCount = selected.items.filter(
      (i) => i.realignmentStatus !== 'received' && i.realignmentStatus !== 'missing',
    ).length;
    if (pendingCount > 0) {
      alert(`Ainda há ${pendingCount} item(ns) sem conferir. Bipe ou marque como faltante antes.`);
      return;
    }
    if (!confirm(
      `Confirmar recebimento de ${selected.code}?\n\n` +
      `Vai dar entrada (+estoque Giga) nos itens conferidos. Não pode desfazer.`
    )) return;
    setConfirming(true);
    try {
      const res = await api<{ ok: boolean; receivedItems: number; missingItems: number }>(
        `/realignment/shipments/${selected.id}/confirm-received`,
        { method: 'POST', body: '{}' },
      );
      alert(
        `✅ Remessa ${selected.code} recebida!\n\n` +
          `${res.receivedItems} itens entraram no estoque.\n` +
          (res.missingItems > 0 ? `${res.missingItems} marcados como faltante.` : ''),
      );
      setSelected(null);
      await loadShipments();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setConfirming(false);
    }
  }, [selected, loadShipments]);

  // ── Render ──
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
      </div>
    );
  }

  // Tela de detalhe (uma remessa selecionada)
  if (selected) {
    const receivedCount = selected.items.filter((i) => i.realignmentStatus === 'received').length;
    const missingCount = selected.items.filter((i) => i.realignmentStatus === 'missing').length;
    const pendingCount = selected.items.length - receivedCount - missingCount;
    const allDone = pendingCount === 0;

    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-emerald-50/40 to-teal-50/30 pb-16">
        {/* Header */}
        <header className="bg-gradient-to-r from-emerald-700 via-teal-700 to-cyan-700 text-white sticky top-0 z-30 shadow-2xl">
          <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
            <button
              onClick={() => setSelected(null)}
              className="p-2 hover:bg-white/15 rounded-lg transition"
              title="Voltar"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="w-11 h-11 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
              <Package className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-black text-xl truncate">{selected.code}</div>
              <div className="text-xs opacity-85">
                De <b>{selected.fromStoreName}</b> · {selected.totalItems} item(s) · {selected.totalQty} peça(s)
              </div>
            </div>
            <button
              onClick={() => loadShipmentDetail(selected.id)}
              className="p-2 hover:bg-white/15 rounded-lg"
              title="Recarregar"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
          {/* Progress bar */}
          <div className="max-w-6xl mx-auto px-4 pb-3">
            <div className="bg-white/20 rounded-full overflow-hidden h-3">
              <div
                className="h-full bg-emerald-300 transition-all"
                style={{ width: `${selected.items.length === 0 ? 0 : ((receivedCount + missingCount) / selected.items.length) * 100}%` }}
              />
            </div>
            <div className="text-xs mt-1 flex gap-3 font-semibold">
              <span>✅ {receivedCount} conferida(s)</span>
              {missingCount > 0 && <span>⚠️ {missingCount} faltante(s)</span>}
              {pendingCount > 0 && <span>⏳ {pendingCount} pendente(s)</span>}
            </div>
          </div>
        </header>

        <main className="max-w-6xl mx-auto p-4 space-y-4">
          {/* Scanner */}
          <form
            onSubmit={handleScan}
            className="bg-white rounded-2xl border-2 border-emerald-300 shadow-lg p-4"
          >
            <label className="text-sm font-bold text-emerald-900 mb-2 flex items-center gap-2">
              <Scan className="w-4 h-4" />
              Bipe ou digite o código da peça (SKU)
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="Ex: 1234567890"
                disabled={scanning}
                autoFocus
                className="flex-1 border-2 border-emerald-300 rounded-xl px-4 py-3 text-lg font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={scanning || !scanInput.trim()}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black px-6 rounded-xl shadow-md flex items-center gap-2"
              >
                {scanning ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scan className="w-5 h-5" />}
                Bipar
              </button>
            </div>
            {feedback && (
              <div
                className={`mt-3 text-sm font-bold rounded-lg px-3 py-2 ${
                  feedback.type === 'ok'
                    ? 'bg-emerald-100 text-emerald-900'
                    : 'bg-red-100 text-red-900'
                }`}
              >
                {feedback.msg}
              </div>
            )}
          </form>

          {/* Lista de itens */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 font-bold text-slate-700">
              Itens da remessa ({selected.items.length})
            </div>
            <div className="divide-y divide-slate-100">
              {selected.items.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  onMarkMissing={() => handleMarkMissing(it)}
                />
              ))}
            </div>
          </div>

          {/* Confirmar */}
          <button
            type="button"
            onClick={handleConfirmReceived}
            disabled={!allDone || confirming}
            className={`w-full py-5 rounded-2xl text-lg font-black shadow-lg flex items-center justify-center gap-3 transition ${
              allDone
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            {confirming ? <Loader2 className="w-6 h-6 animate-spin" /> : <CheckCircle2 className="w-6 h-6" />}
            {confirming
              ? 'Dando entrada...'
              : allDone
                ? `Dar Entrada (${receivedCount} pç → estoque)`
                : `Bipe ou marque os ${pendingCount} pendentes pra liberar`}
          </button>
        </main>
      </div>
    );
  }

  // Lista de remessas (default)
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-emerald-50/40 to-teal-50/30 pb-16">
      <header className="bg-gradient-to-r from-emerald-700 via-teal-700 to-cyan-700 text-white sticky top-0 z-30 shadow-2xl">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/minha-loja" className="p-2 hover:bg-white/15 rounded-lg" title="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="w-11 h-11 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
            <Inbox className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-black text-xl">Recebimento</div>
            <div className="text-xs opacity-85">
              {me?.storeName ?? ''} · remessas chegando
            </div>
          </div>
          <button
            onClick={loadShipments}
            className="p-2 hover:bg-white/15 rounded-lg"
            title="Recarregar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-2">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
            <div className="text-sm">{error}</div>
          </div>
        )}

        {shipments.length === 0 ? (
          <div className="bg-white rounded-2xl border-2 border-dashed border-slate-300 p-12 text-center">
            <div className="w-20 h-20 mx-auto rounded-full bg-emerald-50 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-500" />
            </div>
            <div className="text-xl font-black text-slate-800">Nenhuma remessa chegando</div>
            <div className="text-sm text-slate-500 mt-1">
              Quando outra loja enviar peças pra cá, vai aparecer aqui.
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm font-bold text-slate-700">
              {shipments.length} remessa(s) em trânsito
            </div>
            {shipments.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => loadShipmentDetail(s.id)}
                className="w-full bg-white border-2 border-emerald-300 hover:border-emerald-500 hover:shadow-lg rounded-2xl p-4 flex items-center gap-3 text-left transition"
              >
                <div className="w-14 h-14 rounded-2xl bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow-md">
                  <Package className="w-7 h-7" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-black text-emerald-900">{s.code}</span>
                    <span className="text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded font-bold">
                      EM TRÂNSITO
                    </span>
                  </div>
                  <div className="text-sm text-slate-700 font-semibold mt-1">
                    De {s.fromStoreName} ({s.fromStoreCode})
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {s.totalItems} item(s) · {s.totalQty} peça(s)
                    {s.sentAt && ` · enviada ${new Date(s.sentAt).toLocaleString('pt-BR')}`}
                  </div>
                </div>
                <Send className="w-5 h-5 text-emerald-600 shrink-0" />
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ItemRow({
  item,
  onMarkMissing,
}: {
  item: ShipmentItem;
  onMarkMissing: () => void;
}) {
  const status = item.realignmentStatus;
  const isReceived = status === 'received';
  const isMissing = status === 'missing';
  const isPending = !isReceived && !isMissing;

  return (
    <div
      className={`px-4 py-3 flex items-center gap-3 ${
        isReceived ? 'bg-emerald-50/60' : isMissing ? 'bg-red-50/60' : ''
      }`}
    >
      {isReceived ? (
        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
      ) : isMissing ? (
        <X className="w-5 h-5 text-red-600 shrink-0" />
      ) : (
        <div className="w-5 h-5 rounded-full border-2 border-slate-300 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-mono font-bold text-slate-800">
          {item.refCode}
          <span className="text-xs text-slate-500 ml-2">
            {item.cor || ''} {item.tamanho ? `· ${item.tamanho}` : ''}
            {item.qtyOrigem > 1 ? ` · ${item.qtyOrigem}un` : ''}
          </span>
        </div>
        {item.descricao && (
          <div className="text-xs text-slate-500 truncate mt-0.5">{item.descricao}</div>
        )}
        {isMissing && item.realignmentMissingNote && (
          <div className="text-xs text-red-700 mt-0.5">
            Motivo: {item.realignmentMissingNote}
          </div>
        )}
      </div>
      {isPending && (
        <button
          type="button"
          onClick={onMarkMissing}
          className="text-xs bg-red-100 hover:bg-red-200 text-red-800 px-2 py-1 rounded font-bold"
          title="Marcar como faltante (não chegou)"
        >
          Faltante
        </button>
      )}
    </div>
  );
}
