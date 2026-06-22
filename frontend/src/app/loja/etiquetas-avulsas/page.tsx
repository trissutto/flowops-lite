'use client';

/**
 * /loja/etiquetas-avulsas — Imprimir etiquetas avulsas a partir de SKUs/REFs/EANs.
 *
 * Como funciona:
 *  1. Vendedora cola/digita lista de códigos (1 por linha) — pode ser EAN, REF ou SKU
 *  2. Sistema busca no Wincred (tabela produtos)
 *  3. Mostra preview das etiquetas que serão impressas
 *  4. Botão imprimir reusa o mesmo layout 50x30mm rolo 108mm
 *
 * Útil pra:
 *  - Etiquetar peças que vieram sem etiqueta
 *  - Reimprimir etiqueta danificada
 *  - Atualizar preço (gerar etiqueta nova com preço novo)
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer, Search, Loader2, AlertCircle, Tags, Plus, Trash2, Settings, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api';
import EtiquetaPrint from '@/components/EtiquetaPrint';

type Label = {
  ref: string;
  cor: string;
  tamanho: string;
  codigo: string;
  preco: number;
  marca: string | null;
  descricao: string;
};

type EtiquetaConfig = {
  pageWidthMm: number;
  cellWidthMm: number;
  cellHeightMm: number;
  gridColumnGapMm: number;
  paddingTopMm: number;
  paddingLeftMm: number;
  cellPadTopMm: number;
  cellPadRightMm: number;
  cellPadBottomMm: number;
  cellPadLeftMm: number;
  barcodeWidth: number;
  barcodeHeightPx: number;
  barcodeFontSize: number;
  refMaxFontPx: number;
  descMaxHeightMm: number;
};

const DEFAULT_ETIQUETA_CONFIG: EtiquetaConfig = {
  pageWidthMm: 108, cellWidthMm: 48, cellHeightMm: 30,
  gridColumnGapMm: 6, paddingTopMm: 21, paddingLeftMm: 3,
  cellPadTopMm: 1.2, cellPadRightMm: 1.5, cellPadBottomMm: 0.8, cellPadLeftMm: 1.5,
  barcodeWidth: 1.8, barcodeHeightPx: 32, barcodeFontSize: 18,
  refMaxFontPx: 12, descMaxHeightMm: 5.2,
};

export default function EtiquetasAvulsasPage() {
  const [input, setInput] = useState('');
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<string[]>([]);
  // Qty pra IMPRIMIR de cada SKU (key = codigo). Default 1.
  const [qty, setQty] = useState<Record<string, number>>({});
  // Config etiqueta (persiste no Postgres via /etiqueta-config)
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState<EtiquetaConfig>(DEFAULT_ETIQUETA_CONFIG);
  const [configForm, setConfigForm] = useState<EtiquetaConfig>(DEFAULT_ETIQUETA_CONFIG);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    api<EtiquetaConfig>('/etiqueta-config').then((c) => {
      const merged = { ...DEFAULT_ETIQUETA_CONFIG, ...c };
      setConfig(merged);
      setConfigForm(merged);
    }).catch(() => { /* mantem default */ });
  }, []);

  async function salvarConfig() {
    setConfigSaving(true);
    setConfigError(null);
    try {
      const saved = await api<EtiquetaConfig>('/etiqueta-config', { method: 'POST', body: JSON.stringify(configForm) });
      const merged = { ...DEFAULT_ETIQUETA_CONFIG, ...saved };
      setConfig(merged);
      setConfigForm(merged);
      setShowConfig(false);
    } catch (e: any) {
      setConfigError(e?.message || 'Erro ao salvar');
    } finally {
      setConfigSaving(false);
    }
  }

  async function resetarConfig() {
    if (!confirm('Voltar pros valores padrao? (vai sobrescrever a config salva)')) return;
    setConfigSaving(true);
    try {
      const saved = await api<EtiquetaConfig>('/etiqueta-config/reset', { method: 'POST' });
      const merged = { ...DEFAULT_ETIQUETA_CONFIG, ...saved };
      setConfig(merged);
      setConfigForm(merged);
    } catch (e: any) {
      setConfigError(e?.message || 'Erro');
    } finally {
      setConfigSaving(false);
    }
  }

  // Carrega JsBarcode via CDN
  useEffect(() => {
    if (labels.length === 0) return;
    const render = () => {
      // @ts-expect-error JsBarcode global
      if (!window.JsBarcode) return;
      document.querySelectorAll<HTMLElement>('.barcode-target').forEach((el) => {
        const code = el.dataset.code || '';
        if (!code) return;
        try {
          // @ts-expect-error
          window.JsBarcode(el, code, {
            format: 'EAN13',
            width: 2.2,
            height: 40,
            displayValue: true,
            fontSize: 22,
            fontOptions: 'bold',
            textMargin: 1,
            margin: 0,
            background: '#fff',
            lineColor: '#000',
          });
        } catch {
          try {
            // @ts-expect-error
            window.JsBarcode(el, code, {
              format: 'CODE128',
              width: 2.2,
              height: 40,
              displayValue: true,
              fontSize: 22,
              fontOptions: 'bold',
              textMargin: 1,
              margin: 0,
            });
          } catch { /* ignore */ }
        }
      });
    };
    // @ts-expect-error
    if (window.JsBarcode) {
      render();
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
    s.onload = render;
    document.head.appendChild(s);
  }, [labels]);

  const buscar = async () => {
    const codigos = input
      .split(/[\s,;\n]+/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (codigos.length === 0) {
      setError('Cole ou digite os códigos (1 por linha)');
      return;
    }
    setLoading(true);
    setError(null);
    setNotFound([]);
    try {
      const r = await api<{ labels: Label[]; notFound: string[] }>(
        `/purchase-orders/etiquetas-avulsas`,
        {
          method: 'POST',
          body: JSON.stringify({ codigos }),
        },
      );
      setLabels(r.labels || []);
      setNotFound(r.notFound || []);
      // Inicializa qty = 0 pra cada label — vendedora escolhe explicitamente
      // o que quer imprimir (botões 1/2/3/5/10 aplicam em todos, OU usa +/-
      // peça a peça). Evita imprimir etiqueta sem querer.
      const initialQty: Record<string, number> = {};
      for (const l of (r.labels || [])) initialQty[l.codigo] = 0;
      setQty(initialQty);
    } catch (e: any) {
      setError(e?.message || 'Erro ao buscar');
    } finally {
      setLoading(false);
    }
  };

  const imprimir = () => window.print();

  const limpar = () => {
    setInput('');
    setLabels([]);
    setNotFound([]);
    setError(null);
    setQty({});
  };

  /** Expande labels segundo qty escolhido — qty=0 = não imprime, qty=N = N cópias */
  const labelsExpandidos = labels.flatMap((l) => {
    const n = Math.max(0, Math.min(999, Number(qty[l.codigo] || 0)));
    return Array.from({ length: n }, () => l);
  });
  const totalEtiquetas = labelsExpandidos.length;

  /** Aplica MESMA qty em TODOS os produtos (botão rápido) */
  const aplicarQtyTodos = (n: number) => {
    const next: Record<string, number> = {};
    for (const l of labels) next[l.codigo] = Math.max(0, n);
    setQty(next);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 print:hidden">
        <div className="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/loja" className="p-2 rounded-lg hover:bg-slate-100">
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </Link>
          <div className="w-10 h-10 rounded-xl bg-amber-500 flex items-center justify-center">
            <Tags className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-black text-slate-800">Etiquetas Avulsas</h1>
            <p className="text-xs text-slate-500">Imprimir por REF, SKU ou EAN — útil pra reposição</p>
          </div>
          <button
            onClick={() => { setConfigForm(config); setShowConfig(true); }}
            className="flex items-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-800 text-white font-semibold text-sm rounded-lg print:hidden"
            title="Editar parametros visuais da etiqueta (salvos no banco)"
          >
            <Settings className="w-4 h-4" />
            <span className="hidden sm:inline">Configurar Etiqueta</span>
          </button>
          {labels.length > 0 && (
            <>
              <button
                onClick={limpar}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-sm rounded-lg"
              >
                <Trash2 className="w-4 h-4" />
                Limpar
              </button>
              <button
                onClick={imprimir}
                disabled={totalEtiquetas === 0}
                className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-bold text-sm rounded-lg shadow-md disabled:opacity-40"
              >
                <Printer className="w-4 h-4" />
                Imprimir {totalEtiquetas}
              </button>
            </>
          )}
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto p-4 print:p-0 print:max-w-full">
        {/* Input de códigos */}
        <section className="bg-white border border-slate-200 rounded-2xl p-4 mb-4 print:hidden">
          <label className="text-xs font-bold text-slate-600 uppercase mb-2 block">
            Cole ou digite os códigos (REF, SKU ou EAN — 1 por linha)
          </label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={'Ex:\n8000000000019\n7031\nBMM-006'}
            rows={6}
            className="w-full px-3 py-2 border rounded-lg text-sm font-mono"
          />
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={buscar}
              disabled={loading || !input.trim()}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-lg shadow-md disabled:opacity-40"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Buscar produtos
            </button>
            <div className="text-xs text-slate-500">
              {input.split(/[\s,;\n]+/).filter(Boolean).length} código(s)
            </div>
          </div>

          {error && (
            <div className="mt-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-2 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          {notFound.length > 0 && (
            <div className="mt-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-2 text-xs">
              <b>{notFound.length} código(s) não encontrado(s):</b> {notFound.join(', ')}
            </div>
          )}
        </section>

        {/* Tabela de QTY por produto — vendedora escolhe quantas etiquetas de CADA */}
        {labels.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-2xl p-4 mb-4 print:hidden">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
                <h2 className="text-sm font-black text-slate-800">
                  Quantidade a imprimir de cada peça
                </h2>
                <p className="text-xs text-slate-500">
                  Começa zerado. Use os botões em "Aplicar em todas" ou os ± de cada peça pra escolher qty.
                </p>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold mr-1">Aplicar em todas:</span>
                {[1, 2, 3, 5, 10].map((n) => (
                  <button
                    key={n}
                    onClick={() => aplicarQtyTodos(n)}
                    className="px-2 py-1 bg-slate-100 hover:bg-violet-100 hover:text-violet-700 text-slate-700 font-bold rounded text-xs"
                  >
                    {n}
                  </button>
                ))}
                <button
                  onClick={() => aplicarQtyTodos(0)}
                  className="px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded text-xs ml-1"
                  title="Zera tudo"
                >
                  zerar
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-[10px] uppercase text-slate-600">
                  <tr>
                    <th className="text-left px-2 py-1.5">REF</th>
                    <th className="text-left px-2 py-1.5">Cor</th>
                    <th className="text-center px-2 py-1.5">Tam</th>
                    <th className="text-left px-2 py-1.5">Descrição</th>
                    <th className="text-right px-2 py-1.5">Preço</th>
                    <th className="text-center px-2 py-1.5 w-32">Qty a imprimir</th>
                  </tr>
                </thead>
                <tbody>
                  {labels.map((l) => (
                    <tr key={l.codigo} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-2 py-1 font-mono font-bold text-violet-700">{l.ref}</td>
                      <td className="px-2 py-1 font-bold text-amber-700">{l.cor}</td>
                      <td className="px-2 py-1 text-center font-mono text-slate-700">{l.tamanho}</td>
                      <td className="px-2 py-1 text-xs text-slate-600 truncate max-w-[260px]" title={l.descricao}>
                        {l.descricao}
                      </td>
                      <td className="px-2 py-1 text-right font-bold text-emerald-700 tabular-nums">
                        R$ {Number(l.preco || 0).toFixed(2).replace('.', ',')}
                      </td>
                      <td className="px-2 py-1">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => setQty((prev) => ({
                              ...prev,
                              [l.codigo]: Math.max(0, (Number(prev[l.codigo]) || 0) - 1),
                            }))}
                            className="w-6 h-6 bg-slate-100 hover:bg-slate-200 rounded font-bold text-slate-700"
                          >
                            −
                          </button>
                          <input
                            value={qty[l.codigo] ?? 0}
                            onChange={(e) => {
                              const v = Math.max(0, Math.min(999, Number(e.target.value.replace(/\D/g, '')) || 0));
                              setQty((prev) => ({ ...prev, [l.codigo]: v }));
                            }}
                            inputMode="numeric"
                            className="w-14 px-1 py-1 border rounded text-center font-mono font-bold text-sm"
                          />
                          <button
                            onClick={() => setQty((prev) => ({
                              ...prev,
                              [l.codigo]: Math.min(999, (Number(prev[l.codigo]) || 0) + 1),
                            }))}
                            className="w-6 h-6 bg-slate-100 hover:bg-slate-200 rounded font-bold text-slate-700"
                          >
                            +
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-violet-50 font-bold">
                  <tr>
                    <td colSpan={5} className="px-2 py-2 text-right text-violet-900">
                      Total de etiquetas a imprimir:
                    </td>
                    <td className="px-2 py-2 text-center text-violet-900 tabular-nums text-base">
                      {totalEtiquetas}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        )}

        {/* Preview de impressão */}
        {labels.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center text-slate-500 print:hidden">
            <Tags className="w-12 h-12 text-slate-300 mx-auto mb-2" />
            <div className="text-sm">Os produtos encontrados aparecerão aqui</div>
          </div>
        ) : totalEtiquetas === 0 ? (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-6 text-center text-amber-900 print:hidden">
            <div className="font-bold">Defina a quantidade de pelo menos 1 peça acima pra imprimir</div>
          </div>
        ) : (
          <EtiquetaPrint labels={labelsExpandidos.map(l => ({ ...l, descricao: l.descricao || '' }))} config={config} />
        )}
      </main>


      {/* MODAL Configurar Etiqueta — parametros visuais persistidos */}
      {showConfig && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto print:hidden" onClick={() => setShowConfig(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl my-8 overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 bg-gradient-to-r from-slate-700 to-slate-900 text-white flex items-center justify-between">
              <div>
                <h2 className="font-black text-lg flex items-center gap-2"><Settings className="w-5 h-5" /> Configurar Etiqueta</h2>
                <p className="text-[11px] opacity-90">Os valores sao salvos no banco — nao somem em deploys.</p>
              </div>
              <button onClick={() => setShowConfig(false)} className="text-white hover:bg-white/20 rounded-lg w-8 h-8 flex items-center justify-center text-xl font-bold">x</button>
            </div>
            <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
              {configError && <div className="bg-rose-50 border border-rose-300 text-rose-800 text-sm p-2 rounded">{configError}</div>}

              <section>
                <h3 className="text-xs font-bold uppercase text-slate-500 mb-2">Pagina (rolo)</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <NumField label="Largura pagina (mm)" value={configForm.pageWidthMm} step={1} onChange={(v) => setConfigForm({ ...configForm, pageWidthMm: v })} />
                  <NumField label="Padding topo (mm)" value={configForm.paddingTopMm} step={0.5} onChange={(v) => setConfigForm({ ...configForm, paddingTopMm: v })} />
                  <NumField label="Padding esquerda (mm)" value={configForm.paddingLeftMm} step={0.5} onChange={(v) => setConfigForm({ ...configForm, paddingLeftMm: v })} />
                  <NumField label="Espaco entre colunas (mm)" value={configForm.gridColumnGapMm} step={0.5} onChange={(v) => setConfigForm({ ...configForm, gridColumnGapMm: v })} />
                </div>
              </section>

              <section>
                <h3 className="text-xs font-bold uppercase text-slate-500 mb-2">Etiqueta (celula)</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <NumField label="Largura etiqueta (mm)" value={configForm.cellWidthMm} step={0.5} onChange={(v) => setConfigForm({ ...configForm, cellWidthMm: v })} />
                  <NumField label="Altura etiqueta (mm)" value={configForm.cellHeightMm} step={0.5} onChange={(v) => setConfigForm({ ...configForm, cellHeightMm: v })} />
                  <NumField label="Pad interno cima (mm)" value={configForm.cellPadTopMm} step={0.1} onChange={(v) => setConfigForm({ ...configForm, cellPadTopMm: v })} />
                  <NumField label="Pad interno direita (mm)" value={configForm.cellPadRightMm} step={0.1} onChange={(v) => setConfigForm({ ...configForm, cellPadRightMm: v })} />
                  <NumField label="Pad interno baixo (mm)" value={configForm.cellPadBottomMm} step={0.1} onChange={(v) => setConfigForm({ ...configForm, cellPadBottomMm: v })} />
                  <NumField label="Pad interno esquerda (mm)" value={configForm.cellPadLeftMm} step={0.1} onChange={(v) => setConfigForm({ ...configForm, cellPadLeftMm: v })} />
                </div>
              </section>

              <section>
                <h3 className="text-xs font-bold uppercase text-slate-500 mb-2">Codigo de barras</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <NumField label="Largura linha" value={configForm.barcodeWidth} step={0.1} onChange={(v) => setConfigForm({ ...configForm, barcodeWidth: v })} />
                  <NumField label="Altura (px)" value={configForm.barcodeHeightPx} step={1} onChange={(v) => setConfigForm({ ...configForm, barcodeHeightPx: v })} />
                  <NumField label="Fonte numero (px)" value={configForm.barcodeFontSize} step={1} onChange={(v) => setConfigForm({ ...configForm, barcodeFontSize: v })} />
                </div>
              </section>

              <section>
                <h3 className="text-xs font-bold uppercase text-slate-500 mb-2">Textos</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                  <NumField label="Fonte REF max (px)" value={configForm.refMaxFontPx} step={1} onChange={(v) => setConfigForm({ ...configForm, refMaxFontPx: v })} />
                  <NumField label="Altura descricao max (mm)" value={configForm.descMaxHeightMm} step={0.2} onChange={(v) => setConfigForm({ ...configForm, descMaxHeightMm: v })} />
                </div>
              </section>
            </div>
            <div className="px-5 py-3 bg-slate-50 border-t flex flex-wrap gap-2 justify-end">
              <button onClick={resetarConfig} disabled={configSaving} className="px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-200 rounded-lg flex items-center gap-1 disabled:opacity-50">
                <RotateCcw className="w-4 h-4" /> Resetar
              </button>
              <button onClick={() => setShowConfig(false)} className="px-4 py-2 text-sm font-semibold border-2 border-slate-300 hover:bg-slate-100 rounded-lg">Cancelar</button>
              <button onClick={salvarConfig} disabled={configSaving} className="px-4 py-2 text-sm font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
                {configSaving && <Loader2 className="w-4 h-4 animate-spin" />} Salvar e fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NumField({ label, value, step, onChange }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-bold uppercase text-slate-500">{label}</span>
      <input
        type="number"
        value={value}
        step={step || 1}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="px-2 py-1.5 border-2 border-slate-200 rounded text-sm font-mono tabular-nums focus:border-blue-500 outline-none"
      /></label>
  );
}
