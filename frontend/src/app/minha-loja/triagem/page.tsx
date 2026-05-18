'use client';

/**
 * /minha-loja/triagem — TRIAGEM DO PROVADOR.
 *
 * Caso de uso: vendedora tem um monte de peças no provador (ex: 2.000 peças
 * que vieram de SANTOS sem registro). Bipa cada uma → sistema diz onde mais
 * precisa dela. Vendedora joga a peça na caixa daquela cidade. No final
 * fecha tudo de uma vez (gera N remessas em trânsito).
 *
 * Layout:
 *   - Setup: select origem (default SANTOS) + multi-select destinos
 *   - Bipagem: input grande + último resultado destacado
 *   - Painel direito: caixas em formação (cidade · qtd) + botão Finalizar
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, Package, Box, CheckCircle2, X, Barcode, ArrowRight,
  RefreshCw, Send, AlertCircle, Settings, Filter, Trash2, Eraser,
} from 'lucide-react';
import { api } from '@/lib/api';

// ─── Tipos ─────────────────────────────────────────────────────────────
type Store = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  tipo?: string | null;
};

type Suggestion = {
  sku: string;
  ref: string;
  cor: string | null;
  tamanho: string | null;
  descricao: string | null;
  sugerido: {
    storeCode: string;
    storeName: string;
    reason: string;
    estrategia?: 'AGRUPAR_GRADE' | 'ESTOQUE_ZERO' | 'MENOR_ESTOQUE';
  };
  excluidos?: Array<{ storeCode: string; storeName: string; motivo: string }>;
  comparativo: Array<{
    storeCode: string;
    storeName: string;
    estoqueAtual: number;
    vendaRef30d: number;
    qtdMesmaRefNaCaixa?: number;
    temSkuExatoNaCaixa?: boolean;
  }>;
};

type OpenShipment = {
  id: string;
  code: string;
  fromStoreCode: string;
  fromStoreName: string;
  toStoreCode: string;
  toStoreName: string;
  status: string;
  totalItems: number;
  totalQty: number;
};

const SETUP_STORAGE_KEY = 'lurds_triagem_setup_v1';
const HISTORY_STORAGE_KEY = 'lurds_triagem_history_v1';

export default function TriagemPage() {
  // ── Setup ──
  const [stores, setStores] = useState<Store[]>([]);
  const [setupOpen, setSetupOpen] = useState(true);
  const [fromStoreCode, setFromStoreCode] = useState('');
  const [toStoreCodes, setToStoreCodes] = useState<string[]>([]);

  // ── Bipagem ──
  const [scanInput, setScanInput] = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const [lastSuggestion, setLastSuggestion] = useState<Suggestion | null>(null);
  const [confirmed, setConfirmed] = useState<Array<{ ts: number; sku: string; toStoreCode: string; toStoreName: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [errorSku, setErrorSku] = useState<string | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState<any | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Caixas em formação ──
  const [openShipments, setOpenShipments] = useState<OpenShipment[]>([]);
  const [shipmentsLoading, setShipmentsLoading] = useState(false);

  // ── Finalizar ──
  const [finalizing, setFinalizing] = useState(false);
  const [finalizingOne, setFinalizingOne] = useState<string | null>(null);
  const [finalizeResult, setFinalizeResult] = useState<{ fechadas: number; falhas: number; results: any[] } | null>(null);

  // ── Modal detalhe da caixa ──
  const [boxDetail, setBoxDetail] = useState<any | null>(null);
  const [boxLoading, setBoxLoading] = useState(false);

  // ── Wipe ──
  const [wiping, setWiping] = useState(false);

  // ── Load lojas + setup salvo + histórico ──
  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) => {
        setStores(arr.filter((s) => s.active).sort((a, b) => a.code.localeCompare(b.code)));
        // Restaura setup salvo
        try {
          const raw = typeof window !== 'undefined' ? localStorage.getItem(SETUP_STORAGE_KEY) : null;
          if (raw) {
            const saved = JSON.parse(raw);
            if (saved?.fromStoreCode) setFromStoreCode(saved.fromStoreCode);
            if (Array.isArray(saved?.toStoreCodes)) setToStoreCodes(saved.toStoreCodes);
            if (saved?.fromStoreCode && saved?.toStoreCodes?.length > 0) {
              setSetupOpen(false);
            }
          }
        } catch {
          /* noop */
        }
        // Restaura histórico de bipagens
        try {
          const rawH = typeof window !== 'undefined' ? localStorage.getItem(HISTORY_STORAGE_KEY) : null;
          if (rawH) {
            const arr = JSON.parse(rawH);
            if (Array.isArray(arr)) setConfirmed(arr.slice(0, 50));
          }
        } catch {
          /* noop */
        }
      })
      .catch(() => setError('Erro ao carregar lojas'));
  }, []);

  // ── Salva histórico no localStorage ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(confirmed.slice(0, 50)));
    } catch {
      /* noop */
    }
  }, [confirmed]);

  // ── Salva setup ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(
        SETUP_STORAGE_KEY,
        JSON.stringify({ fromStoreCode, toStoreCodes }),
      );
    } catch {
      /* noop */
    }
  }, [fromStoreCode, toStoreCodes]);

  // ── Carrega remessas open quando origem muda ──
  const loadOpenShipments = async () => {
    if (!fromStoreCode) {
      setOpenShipments([]);
      return;
    }
    setShipmentsLoading(true);
    try {
      const data = await api<OpenShipment[]>(`/realignment/triage/open?fromStoreCode=${fromStoreCode}`);
      setOpenShipments(data);
    } catch {
      setOpenShipments([]);
    } finally {
      setShipmentsLoading(false);
    }
  };

  useEffect(() => {
    loadOpenShipments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromStoreCode]);

  // ── Foca input quando setup fecha ──
  useEffect(() => {
    if (!setupOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [setupOpen]);

  // ── Listener global: qualquer tecla redireciona pro input se nada
  // estiver focado. Garante que mesmo se a vendedora clicar fora ou
  // perder o foco por qualquer motivo, a próxima bipada vai pro lugar certo.
  useEffect(() => {
    if (setupOpen) return;
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      // Se já está num input/textarea/botão, não interfere
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          (active as HTMLElement).isContentEditable)
      ) {
        return;
      }
      // Ignora teclas de modificação/navegação puras
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Aceita alfanumérico, números do scanner, hífen e Enter
      if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') {
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setupOpen]);

  // ── Helpers setup ──
  const togglePreset = (preset: 'rede' | 'todas') => {
    if (preset === 'rede') {
      setToStoreCodes(
        stores
          .filter((s) => (s.tipo || 'REDE') === 'REDE' && s.code !== fromStoreCode)
          .map((s) => s.code),
      );
    } else {
      setToStoreCodes(stores.filter((s) => s.code !== fromStoreCode).map((s) => s.code));
    }
  };

  const toggleDestino = (code: string) => {
    setToStoreCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const setupValid = useMemo(() => {
    return Boolean(fromStoreCode) && toStoreCodes.length > 0;
  }, [fromStoreCode, toStoreCodes]);

  const fromStore = useMemo(() => stores.find((s) => s.code === fromStoreCode), [stores, fromStoreCode]);

  // ── Bipagem ──
  const handleScan = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const sku = scanInput.trim();
    if (!sku) return;
    if (!setupValid) {
      setError('Configure origem e destinos primeiro');
      return;
    }
    setScanLoading(true);
    setError(null);
    setErrorSku(null);
    setDiagResult(null);
    setFinalizeResult(null);
    try {
      // 1. Pede sugestão
      const sug = await api<Suggestion>('/realignment/triage/suggest', {
        method: 'POST',
        body: JSON.stringify({
          sku,
          fromStoreCode,
          candidateStoreCodes: toStoreCodes,
        }),
      });
      // 2. Confirma direto no destino sugerido (auto-confirma)
      // Se vendedora quiser trocar, ela edita depois pelos botões "Outra cidade"
      await api('/realignment/triage/confirm', {
        method: 'POST',
        body: JSON.stringify({
          sku: sug.sku,
          fromStoreCode,
          toStoreCode: sug.sugerido.storeCode,
          qty: 1,
        }),
      });
      setLastSuggestion(sug);
      setConfirmed((prev) =>
        [
          { ts: Date.now(), sku: sug.sku, toStoreCode: sug.sugerido.storeCode, toStoreName: sug.sugerido.storeName },
          ...prev,
        ].slice(0, 30),
      );
      setScanInput('');
      // Recarrega caixas
      loadOpenShipments();
      // Re-foca input
      inputRef.current?.focus();
    } catch (e: any) {
      setError(e?.message || 'Erro ao bipar peça');
      setErrorSku(sku);
    } finally {
      setScanLoading(false);
      // Foco garantido: timeout pequeno pra deixar React aplicar o estado primeiro,
      // depois força foco + seleciona qualquer conteúdo restante (se a próxima
      // bipada vier antes do Enter, sobrescreve direto).
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
    }
  };

  // ── Diagnóstico ──
  const runDiagnose = async () => {
    if (!errorSku) return;
    setDiagLoading(true);
    try {
      const r = await api<any>(`/realignment/triage/diagnose?sku=${encodeURIComponent(errorSku)}`);
      setDiagResult(r);
    } catch (e: any) {
      alert(`Erro no diagnóstico: ${e?.message}`);
    } finally {
      setDiagLoading(false);
    }
  };

  // ── Trocar destino do último item bipado ──
  const trocarDestino = async (newToStoreCode: string) => {
    if (!lastSuggestion) return;
    setScanLoading(true);
    setError(null);
    try {
      // Cria novo registro pro destino escolhido manualmente
      await api('/realignment/triage/confirm', {
        method: 'POST',
        body: JSON.stringify({
          sku: lastSuggestion.sku,
          fromStoreCode,
          toStoreCode: newToStoreCode,
          qty: 1,
        }),
      });
      const newDest = lastSuggestion.comparativo.find((c) => c.storeCode === newToStoreCode);
      if (newDest) {
        setConfirmed((prev) =>
          [
            { ts: Date.now(), sku: lastSuggestion.sku, toStoreCode: newDest.storeCode, toStoreName: newDest.storeName },
            ...prev,
          ].slice(0, 30),
        );
        // Atualiza visualmente o destino "sugerido" pra mostrar que foi trocado
        setLastSuggestion({
          ...lastSuggestion,
          sugerido: {
            storeCode: newDest.storeCode,
            storeName: newDest.storeName,
            reason: 'Trocado manualmente pela vendedora',
          },
        });
      }
      loadOpenShipments();
    } catch (e: any) {
      setError(e?.message || 'Erro ao trocar destino');
    } finally {
      setScanLoading(false);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
    }
  };

  // ── Abrir caixa pra ver/remover items ──
  const openBox = async (shipmentId: string) => {
    setBoxDetail(null);
    setBoxLoading(true);
    try {
      const d = await api<any>(`/realignment/triage/shipment/${shipmentId}/items`);
      setBoxDetail(d);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setBoxLoading(false);
    }
  };

  const removeItem = async (transferOrderId: string) => {
    if (!fromStoreCode) return;
    if (!confirm('Remover esta peça da caixa? Vai voltar pro provador.')) return;
    try {
      const r = await api<{ ok: boolean; shipmentDeleted: boolean }>(
        `/realignment/triage/item/${transferOrderId}?fromStoreCode=${fromStoreCode}`,
        { method: 'DELETE' },
      );
      // Se a caixa esvaziou, fecha o modal
      if (r.shipmentDeleted) {
        setBoxDetail(null);
      } else if (boxDetail) {
        // Senão recarrega
        openBox(boxDetail.id);
      }
      loadOpenShipments();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // ── Limpar tudo ──
  const wipeAll = async () => {
    if (!fromStoreCode) return;
    if (openShipments.length === 0) {
      alert('Nenhuma caixa aberta pra limpar.');
      return;
    }
    const totalQty = openShipments.reduce((s, sh) => s + sh.totalQty, 0);
    if (
      !confirm(
        `LIMPAR TUDO?\n\nVai apagar ${openShipments.length} caixa(s) e ${totalQty} peça(s) bipada(s).\n\nAção destrutiva — sem rollback.`,
      )
    )
      return;
    if (!confirm('Confirma de verdade? Vai perder TODAS as bipagens da triagem.')) return;
    setWiping(true);
    try {
      await api('/realignment/triage/wipe-open', {
        method: 'POST',
        body: JSON.stringify({ fromStoreCode }),
      });
      setConfirmed([]);
      setLastSuggestion(null);
      try {
        localStorage.removeItem(HISTORY_STORAGE_KEY);
      } catch {
        /* noop */
      }
      loadOpenShipments();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setWiping(false);
    }
  };

  // ── Finalizar (todas) ──
  const finalizar = async () => {
    if (!fromStoreCode) return;
    if (openShipments.length === 0) {
      alert('Nenhuma caixa pra finalizar');
      return;
    }
    if (!confirm(`Fechar e enviar ${openShipments.length} caixa(s)? Vai baixar estoque do Giga origem.`)) return;
    setFinalizing(true);
    setError(null);
    try {
      const result = await api<{ fechadas: number; falhas: number; results: any[] }>(
        '/realignment/triage/finalize',
        {
          method: 'POST',
          body: JSON.stringify({ fromStoreCode }),
        },
      );
      setFinalizeResult(result);
      setConfirmed([]);
      setLastSuggestion(null);
      loadOpenShipments();
    } catch (e: any) {
      setError(e?.message || 'Erro ao finalizar');
    } finally {
      setFinalizing(false);
    }
  };

  // ── Finalizar UMA remessa específica ──
  const finalizarUma = async (shipmentId: string, code: string, toStoreName: string) => {
    if (!fromStoreCode) return;
    if (!confirm(`Fechar e enviar a caixa ${code} (${toStoreName})?\nVai baixar o estoque do Giga origem.`)) return;
    setFinalizingOne(shipmentId);
    setError(null);
    try {
      const result = await api<{ ok: boolean; code: string; toStoreCode: string; error?: string }>(
        '/realignment/triage/finalize-one',
        {
          method: 'POST',
          body: JSON.stringify({ shipmentId, fromStoreCode }),
        },
      );
      if (!result.ok) {
        setError(result.error || `Erro ao fechar caixa ${code}`);
      } else {
        setFinalizeResult({
          fechadas: 1,
          falhas: 0,
          results: [{ ok: true, code: result.code, toStoreCode: result.toStoreCode }],
        });
      }
      loadOpenShipments();
    } catch (e: any) {
      setError(e?.message || `Erro ao fechar caixa ${code}`);
    } finally {
      setFinalizingOne(null);
    }
  };

  // ── Total de peças nas caixas ──
  const totalNasCaixas = openShipments.reduce((s, sh) => s + sh.totalQty, 0);

  return (
    <div className="min-h-screen bg-[#f4f1ec]">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b shadow-sm">
        <div className="max-w-6xl mx-auto px-3 py-2 flex items-center gap-2">
          <Link href="/minha-loja" className="text-slate-500 hover:text-slate-700" aria-label="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1">
            <h1 className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <Package className="w-4 h-4 text-violet-600" />
              Triagem do Provador
            </h1>
            {fromStore && (
              <p className="text-xs text-slate-500">
                Origem: <b>{fromStore.code} {fromStore.name}</b> · {toStoreCodes.length} destino(s) elegível(is)
              </p>
            )}
          </div>
          <button
            onClick={() => setSetupOpen(true)}
            className="text-sm flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-slate-100"
            title="Configurar origem/destinos"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* COL 1+2: Bipagem */}
        <div className="lg:col-span-2 space-y-3">
          {/* Input de bipagem */}
          <form
            onSubmit={handleScan}
            className="bg-white rounded-lg border-2 border-violet-300 p-3 shadow-sm"
          >
            <label className="text-xs uppercase font-semibold text-violet-700 flex items-center gap-1 mb-2">
              <Barcode className="w-3.5 h-3.5" />
              Bipe a peça (SKU/EAN)
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="Foco aqui · scanner ou digite"
                disabled={!setupValid || scanLoading}
                className="flex-1 px-4 py-3 text-lg font-mono border rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:bg-slate-50"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                type="submit"
                disabled={!scanInput || !setupValid || scanLoading}
                className="px-4 py-3 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded-md flex items-center gap-2 disabled:opacity-40"
              >
                {scanLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
              </button>
            </div>
            {error && (
              <div className="mt-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded p-2 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span className="flex-1">{error}</span>
                  {errorSku && !diagResult && (
                    <button
                      onClick={runDiagnose}
                      disabled={diagLoading}
                      className="text-xs px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-bold disabled:opacity-50"
                    >
                      {diagLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Diagnosticar'}
                    </button>
                  )}
                </div>

                {diagResult && (
                  <div className="bg-white border border-amber-200 rounded p-2 text-[11px] font-mono text-slate-700 max-h-96 overflow-auto space-y-2">
                    <div>
                      <b>Variantes testadas:</b> {diagResult.variantsTried?.join(', ') || '—'}
                    </div>

                    {diagResult.matchesByCodigo?.length > 0 && (
                      <div>
                        <b className="text-emerald-700">Produtos com CODIGO contendo "{errorSku}":</b>
                        <div className="ml-3 mt-1">
                          {diagResult.matchesByCodigo.map((m: any, i: number) => (
                            <div key={i} className="truncate">
                              <span className="text-emerald-700">{m.codigo}</span>
                              {m.ref && <span className="text-slate-500"> · REF {m.ref}</span>}
                              {m.descricao && <span className="text-slate-400"> · {m.descricao}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {diagResult.matchesByEan?.length > 0 && (
                      <div>
                        <b className="text-violet-700">Encontrado em EAN/barcode:</b>
                        <div className="ml-3 mt-1">
                          {diagResult.matchesByEan.map((m: any, i: number) => (
                            <div key={i} className="truncate">
                              <span className="text-violet-700">[{m.matchedColumn}]</span>
                              {' '}{m.codigo}
                              {m.ref && <span className="text-slate-500"> · REF {m.ref}</span>}
                              {m.descricao && <span className="text-slate-400"> · {m.descricao}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {diagResult.matchesByRef?.length > 0 && (
                      <div>
                        <b className="text-sky-700">Produtos com REF contendo "{errorSku}":</b>
                        <div className="ml-3 mt-1">
                          {diagResult.matchesByRef.map((m: any, i: number) => (
                            <div key={i} className="truncate">
                              <span className="text-emerald-700">{m.codigo}</span>
                              {m.ref && <span className="text-sky-700"> · REF {m.ref}</span>}
                              {m.descricao && <span className="text-slate-400"> · {m.descricao}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {diagResult.matchesByDescricao?.length > 0 && (
                      <div>
                        <b className="text-amber-700">Produtos com "{errorSku}" na descrição:</b>
                        <div className="ml-3 mt-1">
                          {diagResult.matchesByDescricao.map((m: any, i: number) => (
                            <div key={i} className="truncate">
                              <span className="text-emerald-700">{m.codigo}</span>
                              {m.descricao && <span className="text-slate-400"> · {m.descricao}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {!diagResult.matchesByCodigo?.length &&
                      !diagResult.matchesByEan?.length &&
                      !diagResult.matchesByRef?.length &&
                      !diagResult.matchesByDescricao?.length && (
                        <div className="text-rose-700 font-bold">
                          Nada encontrado em nenhum lugar — esse SKU não existe no Giga.
                        </div>
                      )}
                  </div>
                )}
              </div>
            )}
            {!setupValid && (
              <div className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                Configure origem e pelo menos 1 destino antes de começar.
              </div>
            )}
          </form>

          {/* Última sugestão (card grande) */}
          {lastSuggestion && (
            <div className="bg-white rounded-lg border p-3 space-y-3">
              {/* Identificação peça */}
              <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-lg bg-violet-100 flex items-center justify-center shrink-0">
                  <Package className="w-6 h-6 text-violet-700" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-lg font-bold text-slate-800">
                    {lastSuggestion.ref}
                    {lastSuggestion.cor && <span className="ml-2 text-slate-500">{lastSuggestion.cor}</span>}
                    {lastSuggestion.tamanho && <span className="ml-1 text-slate-500">/{lastSuggestion.tamanho}</span>}
                  </div>
                  {lastSuggestion.descricao && (
                    <div className="text-xs text-slate-500 truncate">{lastSuggestion.descricao}</div>
                  )}
                  <div className="text-[10px] font-mono text-slate-400">SKU {lastSuggestion.sku}</div>
                </div>
                <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
              </div>

              {/* Sugestão grande — cor diferente conforme estratégia */}
              {(() => {
                const isGrade = lastSuggestion.sugerido.estrategia === 'AGRUPAR_GRADE';
                const bg = isGrade ? 'bg-fuchsia-50' : 'bg-emerald-50';
                const border = isGrade ? 'border-fuchsia-400' : 'border-emerald-300';
                const titleColor = isGrade ? 'text-fuchsia-700' : 'text-emerald-700';
                const nameColor = isGrade ? 'text-fuchsia-900' : 'text-emerald-900';
                const subColor = isGrade ? 'text-fuchsia-700' : 'text-emerald-700';
                const titulo = isGrade ? '🧩 Agrupa grade · Joga na caixa de' : 'Joga na caixa de';
                return (
                  <div className={`rounded-xl p-5 ${bg} border-4 ${border} shadow-lg`}>
                    <div className={`text-xs uppercase font-bold ${titleColor} tracking-wider`}>
                      {titulo}
                    </div>
                    <div
                      className={`text-5xl sm:text-6xl font-black mt-2 ${nameColor} tracking-tight uppercase leading-none`}
                      style={{ letterSpacing: '-0.02em' }}
                    >
                      {lastSuggestion.sugerido.storeName}
                    </div>
                    <div className={`text-sm mt-3 ${subColor} font-medium`}>
                      <span className="font-mono font-bold">{lastSuggestion.sugerido.storeCode}</span>
                      <span className="mx-1.5 opacity-60">·</span>
                      {lastSuggestion.sugerido.reason}
                    </div>
                  </div>
                );
              })()}

              {/* Lojas excluídas (já tem o SKU exato) */}
              {lastSuggestion.excluidos && lastSuggestion.excluidos.length > 0 && (
                <div className="bg-rose-50 border border-rose-200 rounded p-2 text-xs">
                  <div className="font-bold text-rose-800 mb-1">
                    🚫 Não pode jogar (SKU já está nessa caixa):
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {lastSuggestion.excluidos.map((e) => (
                      <span key={e.storeCode} className="bg-white border border-rose-300 rounded px-1.5 py-0.5 text-rose-700">
                        {e.storeName}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Comparativo */}
              <div>
                <div className="text-xs uppercase font-semibold text-slate-500 mb-1.5">
                  Destinos elegíveis (clique pra trocar):
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                  {lastSuggestion.comparativo.map((c) => {
                    const isSugerido = c.storeCode === lastSuggestion.sugerido.storeCode;
                    const isExcluido = c.temSkuExatoNaCaixa;
                    const temGrade = !isExcluido && (c.qtdMesmaRefNaCaixa || 0) > 0;
                    return (
                      <button
                        key={c.storeCode}
                        type="button"
                        onClick={() => !isSugerido && !isExcluido && trocarDestino(c.storeCode)}
                        disabled={isSugerido || isExcluido || scanLoading}
                        className={`text-left p-2 rounded border text-xs transition-colors ${
                          isExcluido
                            ? 'bg-rose-50 border-rose-200 cursor-not-allowed opacity-60'
                            : isSugerido
                            ? temGrade
                              ? 'bg-fuchsia-50 border-fuchsia-300 cursor-default'
                              : 'bg-emerald-50 border-emerald-300 cursor-default'
                            : temGrade
                            ? 'bg-white border-fuchsia-300 hover:border-fuchsia-500 hover:bg-fuchsia-50 cursor-pointer'
                            : 'bg-white border-slate-200 hover:border-violet-400 hover:bg-violet-50 cursor-pointer'
                        }`}
                        title={isExcluido ? 'SKU já está nessa caixa' : ''}
                      >
                        <div className="font-semibold text-slate-700 truncate flex items-center gap-1">
                          {temGrade && <span title="Já tem peças da REF">🧩</span>}
                          {isExcluido && <span title="Já tem o SKU exato">🚫</span>}
                          {c.storeName}
                        </div>
                        <div className="text-[10px] font-mono text-slate-400">{c.storeCode}</div>
                        <div className="flex justify-between mt-1">
                          <span className={c.estoqueAtual === 0 ? 'text-rose-600 font-bold' : 'text-slate-600'}>
                            Estq: {c.estoqueAtual}
                          </span>
                          <span className="text-slate-500">V30d: {c.vendaRef30d}</span>
                        </div>
                        {(c.qtdMesmaRefNaCaixa || 0) > 0 && (
                          <div className="mt-1 text-[10px] text-fuchsia-700 font-semibold">
                            Caixa: {c.qtdMesmaRefNaCaixa} pç da REF
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Histórico de bipagens recentes */}
          {confirmed.length > 0 && (
            <div className="bg-white rounded-lg border p-3">
              <div className="text-xs uppercase font-semibold text-slate-500 mb-2 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                Últimas bipagens ({confirmed.length})
              </div>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {confirmed.map((c, i) => (
                  <div key={i} className="text-xs flex items-center justify-between gap-2 py-1 border-b last:border-0">
                    <span className="font-mono text-slate-600">{c.sku}</span>
                    <span className="text-slate-500">→</span>
                    <span className="font-semibold text-emerald-700 truncate">{c.toStoreName}</span>
                    <span className="text-[10px] text-slate-400 shrink-0">
                      {new Date(c.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* COL 3: Caixas em formação */}
        <aside className="space-y-3">
          <div className="bg-white rounded-lg border overflow-hidden sticky top-16">
            <div className="px-3 py-2 bg-slate-50 border-b flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                <Box className="w-4 h-4 text-violet-600" />
                Caixas em formação
              </div>
              <button
                onClick={loadOpenShipments}
                className="text-slate-400 hover:text-slate-600"
                title="Recarregar"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${shipmentsLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <div className="p-2">
              {shipmentsLoading ? (
                <div className="text-center py-4 text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin inline-block" />
                </div>
              ) : openShipments.length === 0 ? (
                <div className="text-center py-6 text-slate-400 text-xs">
                  Nenhuma caixa aberta. Bipe uma peça pra começar.
                </div>
              ) : (
                <>
                  <div className="space-y-1 mb-2">
                    {openShipments
                      .slice()
                      .sort((a, b) => b.totalQty - a.totalQty)
                      .map((sh) => (
                        <div
                          key={sh.id}
                          className="flex items-stretch gap-1 rounded bg-violet-50 border border-violet-200 hover:border-violet-400 transition-colors overflow-hidden"
                        >
                          {/* Clique pra ver peças (área principal) */}
                          <button
                            type="button"
                            onClick={() => openBox(sh.id)}
                            className="flex-1 flex items-center justify-between p-2 hover:bg-violet-100 text-left min-w-0"
                            title="Clique pra ver as peças"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="font-semibold text-sm text-slate-800 truncate">
                                {sh.toStoreName}
                              </div>
                              <div className="text-[10px] font-mono text-slate-400">{sh.code}</div>
                            </div>
                            <div className="text-right pr-1">
                              <div className="text-xl font-bold text-violet-700 tabular-nums leading-none">
                                {sh.totalQty}
                              </div>
                              <div className="text-[10px] text-slate-500">peças</div>
                            </div>
                          </button>
                          {/* Botão Fechar SÓ essa remessa */}
                          <button
                            type="button"
                            onClick={() => finalizarUma(sh.id, sh.code, sh.toStoreName)}
                            disabled={finalizingOne === sh.id || finalizing}
                            className="px-2 bg-emerald-600 hover:bg-emerald-700 text-white flex flex-col items-center justify-center gap-0.5 disabled:opacity-50 transition-colors"
                            title={`Fechar e enviar só a caixa ${sh.code}`}
                          >
                            {finalizingOne === sh.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <>
                                <Send className="w-3.5 h-3.5" />
                                <span className="text-[9px] font-bold leading-none">FECHAR</span>
                              </>
                            )}
                          </button>
                        </div>
                      ))}
                  </div>
                  <div className="border-t pt-2 mt-2">
                    <div className="flex items-center justify-between text-xs mb-2">
                      <span className="text-slate-500">Total nas caixas</span>
                      <span className="font-bold text-slate-800 tabular-nums">{totalNasCaixas} peças</span>
                    </div>
                    <button
                      onClick={finalizar}
                      disabled={finalizing || openShipments.length === 0}
                      className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-md flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                      {finalizing ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Finalizando...
                        </>
                      ) : (
                        <>
                          <Send className="w-4 h-4" />
                          Finalizar e enviar tudo
                        </>
                      )}
                    </button>
                    <p className="text-[10px] text-slate-400 mt-1.5 text-center">
                      Vai baixar estoque do Giga origem e gerar {openShipments.length} remessa(s) em trânsito.
                    </p>

                    {/* Botão Limpar tudo (separado, vermelho discreto) */}
                    <button
                      onClick={wipeAll}
                      disabled={wiping || openShipments.length === 0}
                      className="w-full mt-2 px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 rounded-md flex items-center justify-center gap-1.5 disabled:opacity-50 border border-rose-200"
                    >
                      {wiping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eraser className="w-3 h-3" />}
                      Limpar tudo
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Resultado finalização */}
          {finalizeResult && (
            <div className="bg-emerald-50 border-2 border-emerald-300 rounded-lg p-3">
              <div className="text-sm font-bold text-emerald-900 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                Finalizado!
              </div>
              <div className="text-xs text-emerald-800 mt-1">
                {finalizeResult.fechadas} remessa(s) fechada(s) e enviada(s)
                {finalizeResult.falhas > 0 && ` · ${finalizeResult.falhas} falha(s)`}
              </div>
              {finalizeResult.results.some((r: any) => !r.ok) && (
                <div className="mt-2 text-[10px] text-rose-700">
                  {finalizeResult.results.filter((r: any) => !r.ok).map((r: any) => (
                    <div key={r.shipmentId}>{r.code}: {r.error}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      </main>

      {/* Modal detalhe da caixa */}
      {(boxLoading || boxDetail) && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setBoxDetail(null)}
        >
          <div
            className="bg-white rounded-lg max-w-2xl w-full my-8 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center justify-between bg-violet-50 sticky top-0">
              <div>
                <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Box className="w-4 h-4 text-violet-600" />
                  Caixa: {boxDetail?.toStoreName || '...'}
                </h2>
                {boxDetail && (
                  <div className="text-xs text-slate-500 font-mono">
                    {boxDetail.code} · {boxDetail.items?.length || 0} item(ns)
                  </div>
                )}
              </div>
              <button onClick={() => setBoxDetail(null)} className="p-1.5 hover:bg-slate-200 rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 max-h-[70vh] overflow-y-auto">
              {boxLoading ? (
                <div className="text-center py-8 text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin inline-block mb-2" />
                  <div className="text-sm">Carregando peças...</div>
                </div>
              ) : boxDetail?.items?.length === 0 ? (
                <div className="text-center py-6 text-slate-400 text-sm">Caixa vazia</div>
              ) : (
                <div className="space-y-1">
                  {boxDetail?.items?.map((it: any) => (
                    <div
                      key={it.id}
                      className="flex items-center gap-2 p-2 rounded border bg-slate-50 border-slate-200"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm font-semibold text-slate-700">
                          {it.refCode}
                          {it.cor && <span className="ml-2 text-slate-500">{it.cor}</span>}
                          {it.tamanho && <span className="ml-1 text-slate-500">/{it.tamanho}</span>}
                        </div>
                        {it.descricao && (
                          <div className="text-[10px] text-slate-500 truncate">{it.descricao}</div>
                        )}
                        {it.realignmentSentAt && (
                          <div className="text-[10px] text-slate-400">
                            Bipado às {new Date(it.realignmentSentAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeItem(it.id)}
                        className="p-1.5 rounded hover:bg-rose-100 text-rose-600 shrink-0"
                        title="Remover desta caixa"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Setup */}
      {setupOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg max-w-lg w-full max-h-[85vh] overflow-y-auto">
            <div className="px-4 py-3 border-b flex items-center justify-between bg-slate-50 sticky top-0">
              <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Configurar triagem
              </h2>
              {setupValid && (
                <button onClick={() => setSetupOpen(false)} className="p-1 hover:bg-slate-200 rounded">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="p-4 space-y-4">
              {/* Origem */}
              <div>
                <label className="text-xs uppercase font-semibold text-slate-500 mb-1 block">
                  Origem (de onde vieram as peças)
                </label>
                <select
                  value={fromStoreCode}
                  onChange={(e) => {
                    setFromStoreCode(e.target.value);
                    // Tira a nova origem dos destinos se estava lá
                    setToStoreCodes((prev) => prev.filter((c) => c !== e.target.value));
                  }}
                  className="w-full text-sm border rounded-md px-3 py-2"
                >
                  <option value="">Selecione...</option>
                  {stores.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.code} — {s.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Destinos */}
              <div>
                <label className="text-xs uppercase font-semibold text-slate-500 mb-1 block">
                  Destinos elegíveis (onde sistema pode mandar)
                </label>
                <div className="flex gap-1 mb-2">
                  <button
                    type="button"
                    onClick={() => togglePreset('rede')}
                    className="text-xs px-2 py-1 rounded bg-blue-100 hover:bg-blue-200 text-blue-700"
                  >
                    Só REDE
                  </button>
                  <button
                    type="button"
                    onClick={() => togglePreset('todas')}
                    className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
                  >
                    Todas (menos origem)
                  </button>
                  <button
                    type="button"
                    onClick={() => setToStoreCodes([])}
                    className="text-xs px-2 py-1 rounded bg-rose-50 hover:bg-rose-100 text-rose-700 ml-auto"
                  >
                    Limpar
                  </button>
                </div>
                <div className="border rounded-md max-h-64 overflow-y-auto">
                  {stores
                    .filter((s) => s.code !== fromStoreCode)
                    .map((s) => {
                      const checked = toStoreCodes.includes(s.code);
                      const isFranquia = (s.tipo || 'REDE') === 'FILIAL';
                      return (
                        <label
                          key={s.code}
                          className={`flex items-center gap-2 p-2 border-b last:border-0 cursor-pointer hover:bg-slate-50 ${checked ? 'bg-violet-50' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleDestino(s.code)}
                            className="rounded"
                          />
                          <span className="font-mono text-xs text-slate-500 w-8">{s.code}</span>
                          <span className="flex-1 text-sm">{s.name}</span>
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              isFranquia ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                            }`}
                          >
                            {isFranquia ? 'FRANQ' : 'REDE'}
                          </span>
                        </label>
                      );
                    })}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {toStoreCodes.length} loja(s) selecionada(s)
                </div>
              </div>

              <button
                onClick={() => setSetupOpen(false)}
                disabled={!setupValid}
                className="w-full px-3 py-2 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded-md disabled:opacity-50"
              >
                Começar triagem
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
