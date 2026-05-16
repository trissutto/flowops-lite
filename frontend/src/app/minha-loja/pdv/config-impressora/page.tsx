'use client';

/**
 * /minha-loja/pdv/config-impressora
 *
 * Interface pra escolher QUAIS impressoras o PDV usa pra cada tipo de impresso:
 *   - TÉRMICA 80mm → cupons venda, NFC-e DANFE, vale-troca, sangria, recibo PIX
 *   - A4 LASER    → carnê de crediário (folhas azul/branca)
 *
 * Config é POR PC (cada caixa tem suas impressoras). Salva em localStorage.
 *
 * Funciona em 2 modos:
 *   1. Electron desktop (recomendado) → lista impressoras instaladas, escolhe
 *      no select, imprime SILENCIOSAMENTE sem diálogo.
 *   2. Browser puro → mostra aviso "instalar app desktop pra silencioso". O
 *      Chrome usa o diálogo de impressão padrão (vendedora escolhe manual).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer, Check, AlertCircle, Loader2, RefreshCw, ExternalLink } from 'lucide-react';
import {
  loadPrinterConfig,
  savePrinterChoice,
  listAvailablePrinters,
  isElectron,
  KIND_LABELS,
  type PrinterKind,
  type PrinterConfig,
} from '@/lib/printer-router';

type PrinterInfo = { name: string; isDefault?: boolean; displayName?: string };

export default function ConfigImpressoraPage() {
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [config, setConfig] = useState<PrinterConfig>({ termica: null, a4: null });
  const [loading, setLoading] = useState(true);
  const [savedMsg, setSavedMsg] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const electronMode = isElectron();

  async function refresh() {
    setLoading(true);
    setConfig(loadPrinterConfig());
    const list = await listAvailablePrinters();
    setPrinters(list);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  function update(profile: 'termica' | 'a4', deviceName: string) {
    const value = deviceName === '__none__' ? null : deviceName;
    savePrinterChoice(profile, value);
    setConfig((c) => ({ ...c, [profile]: value }));
    setSavedMsg(`✓ ${profile === 'termica' ? 'Térmica' : 'A4'} salva`);
    setTimeout(() => setSavedMsg(''), 2000);
  }

  async function testarPrint(profile: 'termica' | 'a4') {
    const printerName = profile === 'termica' ? config.termica : config.a4;
    if (!printerName) {
      alert('Escolha uma impressora primeiro.');
      return;
    }
    setTesting(profile);
    try {
      // Página de teste — gera HTML simples e dispara silentPrintHTML
      const electron = (window as any).electronAPI;
      if (electron?.setConfig && electron?.silentPrintHTML) {
        await electron.setConfig({ printer: printerName });
        const html = `
          <!DOCTYPE html><html><head><meta charset="utf-8"><style>
            @page { size: ${profile === 'termica' ? '80mm auto' : 'A4'}; margin: ${profile === 'termica' ? '4mm 3mm' : '20mm'}; }
            body { font-family: 'Courier New', monospace; color: #000; }
            .center { text-align: center; }
            .big { font-size: 24px; font-weight: 900; }
            .sep { border-top: 2px dashed #000; margin: 8px 0; }
          </style></head><body>
            <div class="center big">TESTE DE IMPRESSÃO</div>
            <div class="sep"></div>
            <div class="center">${profile === 'termica' ? 'IMPRESSORA TÉRMICA 80mm' : 'IMPRESSORA A4'}</div>
            <div class="center">Lurd's Order One</div>
            <div class="sep"></div>
            <div>Impressora: ${printerName}</div>
            <div>Data: ${new Date().toLocaleString('pt-BR')}</div>
            <div class="sep"></div>
            <div class="center">Se você está lendo isso impresso,</div>
            <div class="center"><b>A IMPRESSORA TÁ CONFIGURADA OK ✓</b></div>
          </body></html>
        `;
        await electron.silentPrintHTML(html);
        setSavedMsg(`✓ Teste enviado pra ${printerName}`);
      } else {
        alert('Função de teste só funciona no app desktop. No navegador, faça uma venda real pra testar.');
      }
    } catch (e: any) {
      alert('Falha no teste: ' + (e?.message || String(e)));
    } finally {
      setTesting(null);
      setTimeout(() => setSavedMsg(''), 3000);
    }
  }

  // Lista os KINDs agrupados por profile pra UI ficar didática
  const termicaKinds = (Object.keys(KIND_LABELS) as PrinterKind[]).filter(
    (k) => KIND_LABELS[k] && k !== 'carne',
  );
  const a4Kinds: PrinterKind[] = ['carne'];

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/minha-loja/pdv" className="p-2 rounded-lg hover:bg-slate-200 text-slate-700">
            <ArrowLeft size={22} />
          </Link>
          <div>
            <h1 className="text-2xl font-black text-slate-900">Config Impressoras</h1>
            <p className="text-xs text-slate-500">
              Escolha qual impressora usar pra cada tipo de impresso (config por PC).
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="ml-auto px-3 py-2 rounded-lg bg-white border border-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Atualizar
          </button>
        </div>

        {/* Aviso modo browser */}
        {!electronMode && (
          <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 text-sm text-amber-900">
            <div className="flex items-start gap-2">
              <AlertCircle size={20} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-black mb-1">Modo navegador detectado</div>
                <div className="text-amber-800">
                  Pra impressão SILENCIOSA (sem diálogo do Chrome) e rotear automaticamente
                  cupom→térmica e carnê→A4, instale o <b>app desktop Lurd's</b>. Sem ele, o
                  Chrome usa o diálogo padrão e vendedora precisa escolher impressora a cada print.
                </div>
              </div>
            </div>
          </div>
        )}

        {savedMsg && (
          <div className="bg-emerald-50 border-2 border-emerald-300 rounded-xl p-3 text-sm font-bold text-emerald-800 flex items-center gap-2">
            <Check size={18} /> {savedMsg}
          </div>
        )}

        {/* IMPRESSORA TÉRMICA */}
        <div className="bg-white border-2 border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center">
              <Printer size={22} />
            </div>
            <div>
              <div className="text-lg font-black text-slate-900">Impressora TÉRMICA 80mm</div>
              <div className="text-xs text-slate-500">ELGIN i9, MP-4200, ou similar — papel 80mm</div>
            </div>
          </div>

          {/* Select de impressora térmica */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase text-slate-600">Impressora escolhida</label>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Carregando…</div>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  value={config.termica || '__none__'}
                  onChange={(e) => update('termica', e.target.value)}
                  className="flex-1 px-3 py-2.5 border-2 border-slate-300 rounded-lg text-sm font-bold"
                >
                  <option value="__none__">— Padrão do Windows —</option>
                  {printers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.displayName || p.name} {p.isDefault ? ' (padrão)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => testarPrint('termica')}
                  disabled={!config.termica || testing === 'termica'}
                  className="px-3 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-bold flex items-center gap-1.5"
                >
                  {testing === 'termica' ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                  Testar
                </button>
              </div>
            )}
            {!loading && printers.length === 0 && (
              <div className="text-xs text-slate-500 italic">
                Nenhuma impressora detectada. Instale o driver no Windows e clique em Atualizar.
              </div>
            )}
          </div>

          {/* Kinds que usam térmica */}
          <div className="mt-4 pt-3 border-t border-slate-200">
            <div className="text-xs font-bold uppercase text-slate-600 mb-2">Imprime aqui:</div>
            <div className="grid gap-1.5">
              {termicaKinds.map((k) => (
                <div key={k} className="text-sm flex items-baseline gap-2">
                  <Check size={14} className="text-teal-600 shrink-0" />
                  <div>
                    <span className="font-bold text-slate-800">{KIND_LABELS[k].label}</span>
                    <span className="text-slate-500"> — {KIND_LABELS[k].desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* IMPRESSORA A4 */}
        <div className="bg-white border-2 border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center">
              <Printer size={22} />
            </div>
            <div>
              <div className="text-lg font-black text-slate-900">Impressora A4 (Carnê)</div>
              <div className="text-xs text-slate-500">HP, Brother, ou laser comum — papel A4 (azul/branca)</div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold uppercase text-slate-600">Impressora escolhida</label>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 size={14} className="animate-spin" /> Carregando…</div>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  value={config.a4 || '__none__'}
                  onChange={(e) => update('a4', e.target.value)}
                  className="flex-1 px-3 py-2.5 border-2 border-slate-300 rounded-lg text-sm font-bold"
                >
                  <option value="__none__">— Padrão do Windows —</option>
                  {printers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.displayName || p.name} {p.isDefault ? ' (padrão)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => testarPrint('a4')}
                  disabled={!config.a4 || testing === 'a4'}
                  className="px-3 py-2.5 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-bold flex items-center gap-1.5"
                >
                  {testing === 'a4' ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                  Testar
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-slate-200">
            <div className="text-xs font-bold uppercase text-slate-600 mb-2">Imprime aqui:</div>
            <div className="grid gap-1.5">
              {a4Kinds.map((k) => (
                <div key={k} className="text-sm flex items-baseline gap-2">
                  <Check size={14} className="text-purple-600 shrink-0" />
                  <div>
                    <span className="font-bold text-slate-800">{KIND_LABELS[k].label}</span>
                    <span className="text-slate-500"> — {KIND_LABELS[k].desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Resumo / Status */}
        <div className="bg-slate-100 border-2 border-slate-300 rounded-xl p-4 text-sm">
          <div className="font-black text-slate-700 mb-2">Status atual</div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-xs text-slate-500 uppercase">Térmica</div>
              <div className="font-bold text-slate-800">{config.termica || 'Padrão Windows'}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase">A4</div>
              <div className="font-bold text-slate-800">{config.a4 || 'Padrão Windows'}</div>
            </div>
          </div>
          <div className="text-xs text-slate-500 mt-3 italic">
            Config salva no navegador deste PC. Cada caixa precisa configurar uma vez.
          </div>
        </div>

        {/* Ajuda */}
        <details className="bg-white border border-slate-200 rounded-xl p-4 text-sm">
          <summary className="font-bold text-slate-800 cursor-pointer">Como funciona?</summary>
          <div className="mt-3 space-y-2 text-slate-600">
            <p>
              <b>Modo Electron (app desktop):</b> ao escolher impressora aqui, o sistema imprime
              SILENCIOSAMENTE (sem diálogo) na impressora certa pra cada tipo de impresso.
            </p>
            <p>
              <b>Modo navegador:</b> sem app desktop, o Chrome abre o diálogo padrão e vendedora
              escolhe impressora a cada print. O Chrome lembra a última escolha por origem.
            </p>
            <p>
              <b>Por que duas?</b> Cupom térmico 80mm vai na ELGIN (rápida, papel barato).
              Carnê de crediário tem promissória + frente + verso → exige A4 colorido azul/branca.
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
