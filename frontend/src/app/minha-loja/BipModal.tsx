'use client';

/**
 * BipModal — tela de bipagem por código de barras (EAN13) pra finalizar separação.
 *
 * FLUXO:
 *  1. Abre quando separadora clica "Iniciar Bipagem" no card do pedido.
 *  2. Faz GET /pick-orders/:id/scan-data → recebe itens + EAN de cada um.
 *  3. Input fica auto-focado pro leitor USB (scanner emula teclado + Enter).
 *  4. Cada bip:
 *     - Bate com EAN esperado E qty restante > 0 → verde, soma no contador
 *     - Bate com EAN mas qty estourou → vermelho "Já bipou X de Y"
 *     - Não bate com nenhum EAN → vermelho "EAN não pertence a esse pedido"
 *  5. Quando 100% bipado → habilita "Finalizar separação" → POST /pick-orders/:id/finish-separation
 *  6. Status do pick-order vira `separated` → matriz recebe na retaguarda
 *
 * PERSISTÊNCIA: bips ficam em localStorage (chave por pick-order-id).
 * Se operadora fechar o browser e reabrir, continua de onde parou.
 * Key é limpa quando finaliza.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { X, Check, AlertTriangle, Barcode, Send } from 'lucide-react';

interface ScanItem {
  id: string;
  sku: string;
  productName: string | null;
  quantity: number;
  ean: string | null; // null = não achou EAN no ERP
}

interface ScanData {
  pickOrderId: string;
  status: string;
  items: ScanItem[];
}

interface Scan {
  sku: string;
  ean: string;
  timestamp: string;
}

interface BipModalProps {
  pickOrderId: string;
  wcOrderNumber: string | null;
  customerName: string | null;
  onClose: () => void;
  onFinished: () => void; // chamado após POST finalizar com sucesso
}

export default function BipModal({
  pickOrderId,
  wcOrderNumber,
  customerName,
  onClose,
  onFinished,
}: BipModalProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ScanData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scans, setScans] = useState<Scan[]>([]);
  const [bipInput, setBipInput] = useState('');
  const [feedback, setFeedback] = useState<{
    type: 'ok' | 'warn' | 'err';
    msg: string;
    ts: number;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const storageKey = `flowops_scan_${pickOrderId}`;

  // Carrega scan-data + restaura bips do localStorage
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api<ScanData>(`/pick-orders/${pickOrderId}/scan-data`);
        if (!alive) return;
        setData(res);
        // Restaura bips salvos
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw) {
            const saved = JSON.parse(raw) as Scan[];
            if (Array.isArray(saved)) setScans(saved);
          }
        } catch {}
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message ?? 'Erro ao carregar itens');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [pickOrderId, storageKey]);

  // Mantém o input focado (se operadora clicar fora, volta o foco)
  useEffect(() => {
    const refocus = () => {
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus();
      }
    };
    const timer = setInterval(refocus, 500);
    return () => clearInterval(timer);
  }, []);

  // Auto-limpa feedback depois de 2.5s
  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), 2500);
    return () => clearTimeout(t);
  }, [feedback?.ts]); // eslint-disable-line

  // Mapas derivados
  const eanToSku = useMemo(() => {
    const m = new Map<string, string>();
    if (data) {
      for (const it of data.items) {
        if (it.ean) m.set(it.ean, it.sku);
      }
    }
    return m;
  }, [data]);

  const expectedBySku = useMemo(() => {
    const m = new Map<string, number>();
    if (data) {
      for (const it of data.items) {
        m.set(it.sku, (m.get(it.sku) ?? 0) + it.quantity);
      }
    }
    return m;
  }, [data]);

  const scannedBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of scans) {
      m.set(s.sku, (m.get(s.sku) ?? 0) + 1);
    }
    return m;
  }, [scans]);

  const totalExpected = useMemo(
    () => Array.from(expectedBySku.values()).reduce((a, b) => a + b, 0),
    [expectedBySku],
  );
  const totalScanned = scans.length;
  const allDone = totalExpected > 0 && totalScanned >= totalExpected;

  const persistScans = useCallback(
    (next: Scan[]) => {
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
    },
    [storageKey],
  );

  const beep = useCallback((type: 'ok' | 'err') => {
    // Som curto via Web Audio — não depende de arquivo
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = type === 'ok' ? 880 : 220;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (type === 'ok' ? 0.08 : 0.25));
    } catch {}
  }, []);

  const handleBip = useCallback(
    (rawEan: string) => {
      const ean = rawEan.trim();
      if (!ean || !data) return;
      const sku = eanToSku.get(ean);
      if (!sku) {
        setFeedback({ type: 'err', msg: `EAN ${ean} não pertence a esse pedido`, ts: Date.now() });
        beep('err');
        return;
      }
      const expected = expectedBySku.get(sku) ?? 0;
      const got = scannedBySku.get(sku) ?? 0;
      if (got >= expected) {
        setFeedback({
          type: 'warn',
          msg: `Já bipou ${got} de ${expected} dessa peça`,
          ts: Date.now(),
        });
        beep('err');
        return;
      }
      const newScan: Scan = { sku, ean, timestamp: new Date().toISOString() };
      const next = [...scans, newScan];
      setScans(next);
      persistScans(next);
      setFeedback({
        type: 'ok',
        msg: `✓ ${sku} (${got + 1}/${expected})`,
        ts: Date.now(),
      });
      beep('ok');
    },
    [data, eanToSku, expectedBySku, scannedBySku, scans, persistScans, beep],
  );

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (bipInput.trim()) {
        handleBip(bipInput);
        setBipInput('');
      }
    }
  };

  const removeLast = () => {
    if (!scans.length) return;
    const next = scans.slice(0, -1);
    setScans(next);
    persistScans(next);
  };

  const submit = async () => {
    if (!allDone || submitting) return;
    setSubmitting(true);
    try {
      await api(`/pick-orders/${pickOrderId}/finish-separation`, {
        method: 'POST',
        body: JSON.stringify({ scans }),
      });
      // Limpa storage do pick-order (já foi finalizado)
      try { localStorage.removeItem(storageKey); } catch {}
      onFinished();
    } catch (e: any) {
      setErr(e?.message ?? 'Erro ao finalizar. Tenta de novo.');
    } finally {
      setSubmitting(false);
    }
  };

  // Render
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-2">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[95vh] flex flex-col">
        {/* Header */}
        <header className="p-4 border-b flex items-center justify-between bg-slate-50">
          <div>
            <div className="flex items-center gap-2">
              <Barcode className="w-6 h-6 text-brand" />
              <h2 className="text-xl font-bold">Bipagem — Pedido #{wcOrderNumber ?? '—'}</h2>
            </div>
            {customerName && (
              <div className="text-sm text-slate-600 mt-1">Cliente: {customerName}</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded"
            title="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <div className="text-center py-12 text-slate-500">Carregando itens…</div>}

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-800 px-3 py-2 rounded mb-3 flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div>{err}</div>
            </div>
          )}

          {data && !loading && (
            <>
              {/* Input do scanner — focado automaticamente */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-slate-500 uppercase mb-1">
                  Bipe o código de barras
                </label>
                <input
                  ref={inputRef}
                  type="text"
                  value={bipInput}
                  onChange={(e) => setBipInput(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  placeholder="Foque aqui e bipe a peça…"
                  autoFocus
                  className="w-full text-lg font-mono px-4 py-3 border-2 border-brand rounded focus:outline-none focus:ring-2 focus:ring-brand-light"
                />
              </div>

              {/* Feedback visual */}
              {feedback && (
                <div
                  className={`px-3 py-3 rounded text-center font-semibold mb-4 text-lg ${
                    feedback.type === 'ok'
                      ? 'bg-emerald-100 text-emerald-800 border-2 border-emerald-400'
                      : feedback.type === 'warn'
                      ? 'bg-amber-100 text-amber-800 border-2 border-amber-400'
                      : 'bg-red-100 text-red-800 border-2 border-red-400'
                  }`}
                >
                  {feedback.msg}
                </div>
              )}

              {/* Progress */}
              <div className="mb-4">
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="font-medium text-slate-700">
                    Progresso: {totalScanned} / {totalExpected}
                  </span>
                  <button
                    onClick={removeLast}
                    disabled={!scans.length}
                    className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-30"
                  >
                    ← Desfazer último bip
                  </button>
                </div>
                <div className="w-full h-3 bg-slate-200 rounded overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      allDone ? 'bg-emerald-500' : 'bg-brand'
                    }`}
                    style={{
                      width: totalExpected
                        ? `${Math.min(100, (totalScanned / totalExpected) * 100)}%`
                        : '0%',
                    }}
                  />
                </div>
              </div>

              {/* Lista de itens */}
              <div className="space-y-2">
                {data.items.map((it) => {
                  const expected = it.quantity;
                  const got = scannedBySku.get(it.sku) ?? 0;
                  const done = got >= expected;
                  return (
                    <div
                      key={it.id}
                      className={`border rounded p-3 flex items-center justify-between ${
                        done ? 'bg-emerald-50 border-emerald-300' : 'bg-white'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs text-slate-500">{it.sku}</div>
                        <div className="font-medium text-slate-900 truncate">
                          {it.productName ?? '(sem descrição)'}
                        </div>
                        {!it.ean && (
                          <div className="text-xs text-red-600 mt-1">
                            ⚠ Sem EAN cadastrado no ERP — avisa o admin
                          </div>
                        )}
                      </div>
                      <div className="ml-3 text-right flex-shrink-0">
                        <div className={`text-2xl font-bold ${done ? 'text-emerald-600' : 'text-slate-700'}`}>
                          {got}/{expected}
                        </div>
                        {done && (
                          <div className="text-xs text-emerald-600 flex items-center gap-1 justify-end">
                            <Check className="w-3 h-3" /> pronto
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <footer className="p-4 border-t bg-slate-50 flex gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 py-3 bg-slate-200 hover:bg-slate-300 text-slate-800 font-medium rounded disabled:opacity-50"
          >
            Pausar (manter bips)
          </button>
          <button
            onClick={submit}
            disabled={!allDone || submitting}
            className={`flex-1 py-3 font-semibold rounded flex items-center justify-center gap-2 ${
              allDone
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                : 'bg-slate-300 text-slate-500 cursor-not-allowed'
            }`}
          >
            <Send className="w-5 h-5" />
            {submitting ? 'Enviando...' : 'Finalizar separação'}
          </button>
        </footer>
      </div>
    </div>
  );
}
