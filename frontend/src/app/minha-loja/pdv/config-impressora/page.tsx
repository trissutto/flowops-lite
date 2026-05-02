'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Loader2, Printer, RefreshCw, X } from 'lucide-react';
import {
  qzClearPrinter,
  qzConnect,
  qzGetPrinter,
  qzListPrinters,
  qzPrintHtml,
  qzSetPrinter,
} from '@/lib/qz-print';

/**
 * Configuração da impressora ELGIN via QZ Tray.
 *
 * Fluxo (uma vez por PC):
 *   1. Vendedora abre essa tela
 *   2. Click "Conectar no QZ Tray" → carrega lista de impressoras do PC
 *   3. Escolhe ELGIN da lista
 *   4. Click "Testar impressão" pra confirmar
 *   5. Click "Salvar" — fica gravado no localStorage do navegador
 *   6. Pronto: cupom NFC-e imprime auto na ELGIN dali em diante
 *
 * Sem QZ Tray instalado, a tela orienta o download.
 */
export default function ConfigImpressoraPage() {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [printers, setPrinters] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [savedName, setSavedName] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  useEffect(() => {
    setSavedName(qzGetPrinter());
    const sel = qzGetPrinter();
    if (sel) setSelected(sel);
  }, []);

  async function conectar() {
    setStatus('connecting');
    setError(null);
    try {
      await qzConnect();
      const list = await qzListPrinters();
      setPrinters(list);
      setStatus('connected');
      // Auto-seleciona a primeira ELGIN se não tiver nada salvo
      if (!selected) {
        const elgin = list.find((n) => /elgin/i.test(n));
        if (elgin) setSelected(elgin);
      }
    } catch (e: any) {
      setStatus('error');
      setError(e?.message || String(e));
    }
  }

  function salvar() {
    if (!selected) return;
    qzSetPrinter(selected);
    setSavedName(selected);
    setTestMsg('✓ Impressora salva: ' + selected);
    setTimeout(() => setTestMsg(null), 3000);
  }

  function limpar() {
    if (!confirm('Limpar configuração? Cupons vão voltar a abrir o diálogo de impressão.')) return;
    qzClearPrinter();
    setSavedName(null);
    setSelected('');
  }

  async function testarImpressao() {
    if (!selected) {
      setTestMsg('Selecione uma impressora primeiro');
      return;
    }
    setTesting(true);
    setTestMsg(null);
    try {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  @page { size: 80mm auto; margin: 0; }
  body { font-family: 'Courier New', monospace; font-size: 11px; width: 78mm; margin: 0; padding: 4mm; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .lg { font-size: 14px; }
  .sep { border-top: 1px dashed #000; margin: 4px 0; }
</style></head><body>
  <div class="center bold lg">TESTE DE IMPRESSÃO</div>
  <div class="center">LURD'S PLUS SIZE</div>
  <div class="sep"></div>
  <div>Impressora: ${selected}</div>
  <div>Data/hora: ${new Date().toLocaleString('pt-BR')}</div>
  <div class="sep"></div>
  <div class="center bold">SE VOCÊ ESTÁ LENDO ISSO,</div>
  <div class="center bold">A IMPRESSÃO TÁ FUNCIONANDO!</div>
  <div class="sep"></div>
  <div class="center">Voltar pro PDV e finalizar uma venda</div>
  <div class="center">pra testar o cupom NFC-e real.</div>
</body></html>`;
      const ok = await qzPrintHtml(html, { printer: selected });
      if (ok) setTestMsg('✓ Enviado pra impressora! Confira a saída.');
      else setTestMsg('✗ Falhou — cheque se QZ Tray está rodando e confira o nome da impressora.');
    } catch (e: any) {
      setTestMsg('✗ ' + (e?.message || String(e)));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href="/minha-loja/pdv"
          className="text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <Printer className="w-5 h-5" /> Configurar Impressora ELGIN
        </h1>
      </div>

      {/* Status do QZ Tray */}
      <div className="bg-white border rounded-lg p-4 space-y-3">
        <div className="text-sm text-slate-700">
          <strong>QZ Tray</strong> é um software gratuito que permite imprimir
          direto na ELGIN sem mudar a impressora padrão do Windows.
        </div>
        {savedName ? (
          <div className="bg-emerald-50 border border-emerald-300 rounded p-3">
            <div className="flex items-center gap-2 text-emerald-900 font-bold text-sm">
              <Check className="w-4 h-4" /> Impressora configurada
            </div>
            <div className="text-xs text-emerald-800 mt-1 font-mono">{savedName}</div>
            <button
              onClick={limpar}
              className="mt-2 text-xs text-rose-700 hover:underline flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Limpar configuração
            </button>
          </div>
        ) : (
          <div className="bg-amber-50 border border-amber-300 rounded p-3 text-sm text-amber-900">
            ⚠ Nenhuma impressora configurada. Cupons NFC-e vão abrir o diálogo de impressão.
          </div>
        )}
      </div>

      {/* Passo 1: Instalação */}
      <div className="bg-white border rounded-lg p-4 space-y-2">
        <div className="font-bold text-slate-800">1. QZ Tray instalado?</div>
        <div className="text-xs text-slate-600">
          Se ainda não instalou, baixa em{' '}
          <a
            href="https://qz.io/download/"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline"
          >
            qz.io/download
          </a>
          . Instalação next-next-finish, vira ícone perto do relógio.
        </div>
      </div>

      {/* Passo 2: Conectar */}
      <div className="bg-white border rounded-lg p-4 space-y-3">
        <div className="font-bold text-slate-800">2. Conectar e listar impressoras</div>
        <button
          onClick={conectar}
          disabled={status === 'connecting'}
          className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold rounded flex items-center justify-center gap-2"
        >
          {status === 'connecting' ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Conectando...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4" /> Conectar no QZ Tray
            </>
          )}
        </button>
        {status === 'error' && error && (
          <div className="bg-rose-50 border border-rose-300 rounded p-3 text-xs text-rose-800 whitespace-pre-line">
            {error}
          </div>
        )}
        {status === 'connected' && (
          <div className="text-xs text-emerald-700 flex items-center gap-1">
            <Check className="w-3 h-3" /> Conectado. {printers.length} impressora(s) encontrada(s).
          </div>
        )}
      </div>

      {/* Passo 3: Escolher impressora */}
      {printers.length > 0 && (
        <div className="bg-white border rounded-lg p-4 space-y-3">
          <div className="font-bold text-slate-800">3. Escolher a ELGIN</div>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {printers.map((p) => {
              const isElgin = /elgin/i.test(p);
              return (
                <label
                  key={p}
                  className={`flex items-center gap-3 p-2 rounded border-2 cursor-pointer ${
                    selected === p
                      ? 'border-emerald-500 bg-emerald-50'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="printer"
                    value={p}
                    checked={selected === p}
                    onChange={(e) => setSelected(e.target.value)}
                  />
                  <span className="font-mono text-sm flex-1">{p}</span>
                  {isElgin && (
                    <span className="text-[10px] px-2 py-0.5 bg-orange-100 text-orange-800 rounded font-bold">
                      ELGIN
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Passo 4: Testar + Salvar */}
      {selected && (
        <div className="bg-white border rounded-lg p-4 space-y-3">
          <div className="font-bold text-slate-800">4. Testar e salvar</div>
          <div className="text-xs text-slate-600">
            Selecionada: <span className="font-mono font-bold">{selected}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={testarImpressao}
              disabled={testing}
              className="px-3 py-2 bg-slate-200 hover:bg-slate-300 disabled:opacity-50 text-slate-800 font-bold rounded flex items-center justify-center gap-2 text-sm"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
              Testar impressão
            </button>
            <button
              onClick={salvar}
              className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded flex items-center justify-center gap-2 text-sm"
            >
              <Check className="w-4 h-4" /> Salvar
            </button>
          </div>
          {testMsg && (
            <div className="text-xs bg-slate-50 border rounded p-2 whitespace-pre-line">
              {testMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
