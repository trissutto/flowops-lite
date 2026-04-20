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
  eanVariants?: string[]; // variantes tolerando zeros à esquerda/padding
}

interface ResolveDebugRow {
  sku: string;
  columnsChecked?: string[];
  row?: Record<string, any> | null;
  error?: string;
}

interface ResolveResponse {
  found: boolean;
  sku?: string;
  ean: string;
  source?: string;
  erpHit?: string | null;
  debug?: ResolveDebugRow[];
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
  const [resolving, setResolving] = useState(false);
  const [debug, setDebug] = useState<ResolveResponse | null>(null);
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

  // Mapas derivados: cada EAN e TODAS suas variantes (zeros à esquerda/padding)
  // apontam pro mesmo SKU — tolera divergência entre scanner e cadastro do ERP.
  const eanToSku = useMemo(() => {
    const m = new Map<string, string>();
    if (data) {
      for (const it of data.items) {
        const variants = it.eanVariants && it.eanVariants.length ? it.eanVariants : it.ean ? [it.ean] : [];
        for (const v of variants) {
          if (v) m.set(v, it.sku);
        }
        // Como fallback extra, indexa também sem zeros à esquerda e com padding
        if (it.ean) {
          const stripped = it.ean.replace(/^0+/, '');
          if (stripped) m.set(stripped, it.sku);
          if (/^\d+$/.test(it.ean)) {
            m.set(it.ean.padStart(13, '0'), it.sku);
            m.set(it.ean.padStart(14, '0'), it.sku);
          }
        }
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

  // Aceita o bip pro SKU resolvido (de qualquer fonte — mapa local ou fallback).
  const acceptScanForSku = useCallback(
    (sku: string, ean: string) => {
      const expected = expectedBySku.get(sku) ?? 0;
      const got = scannedBySku.get(sku) ?? 0;
      if (expected === 0) {
        setFeedback({ type: 'err', msg: `SKU ${sku} não está na lista do pedido`, ts: Date.now() });
        beep('err');
        return;
      }
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
    [expectedBySku, scannedBySku, scans, persistScans, beep],
  );

  const handleBip = useCallback(
    async (rawEan: string) => {
      const ean = rawEan.trim();
      if (!ean || !data) return;

      // 1) Match direto no mapa local (inclui variantes de zeros à esquerda)
      let sku = eanToSku.get(ean);

      // 2) Match normalizado: sem zeros à esquerda e com padding 13/14
      if (!sku) {
        const stripped = ean.replace(/^0+/, '');
        sku = eanToSku.get(stripped);
        if (!sku && /^\d+$/.test(ean)) {
          sku = eanToSku.get(ean.padStart(13, '0')) || eanToSku.get(ean.padStart(14, '0'));
        }
      }

      if (sku) {
        acceptScanForSku(sku, ean);
        return;
      }

      // 3) Fallback: pergunta pro backend se esse EAN bate com algum SKU do pedido
      //    no ERP (busca em TODAS as colunas + variantes). Se não bater, mostra debug.
      setResolving(true);
      try {
        const res = await api<ResolveResponse>(`/pick-orders/${pickOrderId}/scan-resolve`, {
          method: 'POST',
          body: JSON.stringify({ ean }),
        });
        if (res.found && res.sku) {
          acceptScanForSku(res.sku, ean);
        } else {
          setFeedback({ type: 'err', msg: `EAN ${ean} não pertence a esse pedido`, ts: Date.now() });
          beep('err');
          setDebug(res);
        }
      } catch (e: any) {
        setFeedback({ type: 'err', msg: `Erro ao validar: ${e?.message ?? 'rede'}`, ts: Date.now() });
        beep('err');
      } finally {
        setResolving(false);
      }
    },
    [data, eanToSku, pickOrderId, acceptScanForSku, beep],
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
                <div className="relative">
                  <input
                    ref={inputRef}
                    type="text"
                    value={bipInput}
                    onChange={(e) => setBipInput(e.target.value)}
                    onKeyDown={handleInputKeyDown}
                    placeholder="Foque aqui e bipe a peça…"
                    autoFocus
                    disabled={resolving}
                    className="w-full text-lg font-mono px-4 py-3 border-2 border-brand rounded focus:outline-none focus:ring-2 focus:ring-brand-light disabled:opacity-50"
                  />
                  {resolving && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 animate-pulse">
                      validando…
                    </span>
                  )}
                </div>
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

      {/* Modal de debug — só aparece quando o EAN bipado não bateu em nada */}
      {debug && !debug.found && (
        <div
          className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-3"
          onClick={() => setDebug(null)}
        >
          <div
            className="bg-white rounded-lg shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="p-4 border-b flex items-center justify-between bg-red-50">
              <div>
                <div className="flex items-center gap-2 text-red-700">
                  <AlertTriangle className="w-5 h-5" />
                  <h3 className="font-bold">EAN {debug.ean} não casa com o pedido</h3>
                </div>
                <div className="text-xs text-slate-600 mt-1">
                  {debug.erpHit ? (
                    <>Esse EAN existe no Gigasistemas (SKU <strong>{debug.erpHit}</strong>) mas esse SKU NÃO está nesse pedido.</>
                  ) : (
                    <>Esse EAN não foi encontrado em nenhuma coluna da tabela produtos do Gigasistemas.</>
                  )}
                </div>
              </div>
              <button
                onClick={() => setDebug(null)}
                className="p-2 hover:bg-red-100 rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto p-4 text-sm">
              <div className="text-xs font-medium uppercase text-slate-500 mb-2">
                Cadastro dos SKUs desse pedido no ERP
              </div>
              <div className="space-y-3">
                {(debug.debug ?? []).map((d, idx) => (
                  <div key={idx} className="border rounded p-2 bg-slate-50">
                    <div className="font-mono text-xs text-slate-700 mb-1">SKU: {d.sku}</div>
                    {d.row ? (
                      <table className="w-full text-xs">
                        <tbody>
                          {Object.entries(d.row).map(([k, v]) => (
                            <tr key={k} className="border-t border-slate-200">
                              <td className="py-1 pr-2 text-slate-500 font-medium">{k}</td>
                              <td className="py-1 font-mono">{v === null || v === '' ? <em className="text-slate-400">(vazio)</em> : String(v)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-xs text-red-600">SKU não encontrado na tabela produtos do Gigasistemas</div>
                    )}
                  </div>
                ))}
                {(!debug.debug || debug.debug.length === 0) && (
                  <div className="text-slate-500 text-xs">Sem SKUs pra comparar.</div>
                )}
              </div>
              <div className="mt-4 text-xs text-slate-600 bg-amber-50 border border-amber-200 rounded p-2">
                <strong>O que fazer:</strong> conferir se o EAN impresso na etiqueta é o mesmo
                que o Gigasistemas tem cadastrado pro SKU dessa peça. Se o cadastro estiver
                errado, corrigir no ERP. Se a etiqueta está com EAN de outro produto, separar
                a peça certa.
              </div>
            </div>
            <footer className="p-3 border-t bg-slate-50">
              <button
                onClick={() => setDebug(null)}
                className="w-full py-2 bg-slate-700 hover:bg-slate-800 text-white font-medium rounded"
              >
                Fechar e continuar
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
