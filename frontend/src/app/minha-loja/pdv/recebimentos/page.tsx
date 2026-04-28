'use client';

/**
 * /minha-loja/pdv/recebimentos — RECEBIMENTOS de crediário no PDV.
 *
 * Fluxo:
 *  1. Vendedora busca cliente (CPF, nome ou codCliente)
 *  2. Lista parcelas em aberto da loja, com juros calculados
 *  3. Vendedora seleciona N parcelas → total acumulado
 *  4. Escolhe forma: PIX (gera QR Pagar.me) ou DINHEIRO (registra direto)
 *  5. Após confirmação → UPDATE no Giga + abre recibo silencioso
 *  6. Recibo imprime na térmica e PDV volta pra busca
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Search, Loader2, CheckCircle2, AlertCircle, Banknote, QrCode, Copy, Check, X,
  Calendar, User, FileText,
} from 'lucide-react';
import { api } from '@/lib/api';

type Installment = {
  registro: string;
  controle: string;
  numeroCompra: string | null;
  parcela: number | null;
  totalParcelas: number | null;
  vencimento: string;
  valorParcela: number;
  diasAtraso: number;
  jurosCalculado: number;
  valorComJuros: number;
  codCliente: string;
  nome: string | null;
  telefone: string | null;
};

type PixCharge = {
  baixaId: string;
  pagarmeOrderId: string;
  qrCodeText: string;
  qrCodeImageUrl: string;
  valor: number;
};

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatDate = (iso: string) => {
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('pt-BR');
  } catch {
    return iso;
  }
};

function printReceipt(baixaId: string) {
  const url = `/minha-loja/pdv/recebimentos/recibo/${baixaId}?autoprint=1`;
  const electron = (window as any).electronAPI;
  if (electron?.silentPrintUrl) {
    const absoluteUrl = window.location.origin + url;
    electron.silentPrintUrl(absoluteUrl).catch((e: any) => {
      console.warn('silentPrintUrl falhou, caindo pra iframe:', e);
      hiddenIframe(url);
    });
  } else {
    hiddenIframe(url);
  }
}
function hiddenIframe(url: string) {
  try {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:600px;border:0;';
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(() => { try { iframe.remove(); } catch {} }, 30000);
  } catch (e) {
    window.open(url, 'lurds_recibo', 'width=320,height=520,resizable=yes');
  }
}

export default function RecebimentosPage() {
  const [busca, setBusca] = useState('');
  const [loading, setLoading] = useState(false);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Pagamento
  const [showPagamento, setShowPagamento] = useState(false);
  const [forma, setForma] = useState<'pix' | 'dinheiro' | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const [pixCharge, setPixCharge] = useState<PixCharge | null>(null);
  const [pixPaid, setPixPaid] = useState(false);
  const [copyMsg, setCopyMsg] = useState(false);

  // Cliente atual (do primeiro item da lista — todos da mesma busca devem ser do mesmo cliente)
  const cliente = installments[0] || null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function buscar() {
    if (busca.trim().length < 2) {
      setError('Digite pelo menos 2 caracteres');
      return;
    }
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const data = await api<Installment[]>(
        `/crediarios/baixa/cliente?busca=${encodeURIComponent(busca.trim())}`,
      );
      setInstallments(data);
      if (!data.length) setError('Nenhuma parcela em aberto pra esse cliente nessa loja');
    } catch (e: any) {
      setError(e?.message || String(e));
      setInstallments([]);
    } finally {
      setLoading(false);
    }
  }

  function toggleSelect(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function selectAll() {
    if (selected.size === installments.length) setSelected(new Set());
    else setSelected(new Set(installments.map(keyOf)));
  }
  function keyOf(p: Installment) {
    return `${p.registro}/${p.controle}`;
  }

  const selecionadas = useMemo(
    () => installments.filter((p) => selected.has(keyOf(p))),
    [installments, selected],
  );
  const totalPrincipal = useMemo(
    () => Math.round(selecionadas.reduce((s, p) => s + p.valorParcela, 0) * 100) / 100,
    [selecionadas],
  );
  const totalJuros = useMemo(
    () => Math.round(selecionadas.reduce((s, p) => s + p.jurosCalculado, 0) * 100) / 100,
    [selecionadas],
  );
  const totalPago = Math.round((totalPrincipal + totalJuros) * 100) / 100;

  // ── Aplicação ───────────────────────────────────────────────

  function abrirPagamento() {
    if (selecionadas.length === 0) return;
    setShowPagamento(true);
    setForma(null);
    setPixCharge(null);
    setPixPaid(false);
  }

  async function aplicarDinheiro() {
    setAplicando(true);
    try {
      const r = await api<{ baixaId: string }>('/crediarios/baixa/dinheiro', {
        method: 'POST',
        body: JSON.stringify({
          parcelas: selecionadas.map((p) => ({ registro: p.registro, controle: p.controle })),
        }),
      });
      // Imprime + reseta
      printReceipt(r.baixaId);
      finalizarTudo();
    } catch (e: any) {
      alert('Erro ao registrar baixa: ' + (e?.message || e));
    } finally {
      setAplicando(false);
    }
  }

  async function gerarPix() {
    setAplicando(true);
    try {
      const r = await api<PixCharge>('/crediarios/baixa/pix', {
        method: 'POST',
        body: JSON.stringify({
          parcelas: selecionadas.map((p) => ({ registro: p.registro, controle: p.controle })),
          customerName: cliente?.nome || undefined,
          customerPhone: cliente?.telefone || undefined,
        }),
      });
      setPixCharge(r);
    } catch (e: any) {
      alert('Erro ao gerar PIX: ' + (e?.message || e));
    } finally {
      setAplicando(false);
    }
  }

  // Polling status PIX (1s)
  useEffect(() => {
    if (!pixCharge || pixPaid) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api<{ status: string; isPaid?: boolean }>(`/crediarios/baixa/status/${pixCharge.baixaId}`);
        if (cancelled) return;
        if (r.isPaid) {
          setPixPaid(true);
          // Imprime + finaliza
          printReceipt(pixCharge.baixaId);
          setTimeout(() => finalizarTudo(), 1500);
        }
      } catch {/* noop */}
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [pixCharge, pixPaid]);

  function finalizarTudo() {
    setShowPagamento(false);
    setSelected(new Set());
    setInstallments([]);
    setBusca('');
    setForma(null);
    setPixCharge(null);
    setPixPaid(false);
    setTimeout(() => inputRef.current?.focus(), 200);
  }

  async function copyPix() {
    if (!pixCharge) return;
    try {
      await navigator.clipboard.writeText(pixCharge.qrCodeText);
      setCopyMsg(true);
      setTimeout(() => setCopyMsg(false), 2000);
    } catch {/* noop */}
  }

  // ── Render ───────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-rose-50 to-pink-50 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-xl border-b border-rose-100 shadow-sm">
        <div className="max-w-4xl mx-auto p-4 flex items-center gap-3">
          <Link
            href="/minha-loja/pdv"
            className="p-2 rounded-lg hover:bg-rose-100 text-rose-700"
          >
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-xl md:text-2xl font-bold text-rose-900">RECEBIMENTOS</h1>
          <span className="text-xs text-gray-500 hidden md:inline">crediário · baixa de parcelas</span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto w-full p-4 md:p-6">
        {/* Busca */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
          <label className="block text-xs font-bold text-gray-700 mb-2 uppercase">
            Buscar cliente (CPF, nome ou cód.)
          </label>
          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && buscar()}
              placeholder="ex: 12345678901, MARIA SILVA, 7732"
              className="flex-1 p-3 border-2 rounded-lg text-base font-mono"
            />
            <button
              onClick={buscar}
              disabled={loading || busca.trim().length < 2}
              className="px-5 py-3 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-bold rounded-lg flex items-center gap-2"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search size={18} />}
              Buscar
            </button>
          </div>
          {error && (
            <div className="mt-3 bg-amber-50 border border-amber-200 rounded p-2 text-sm text-amber-900 flex items-start gap-2">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Cliente + Parcelas */}
        {installments.length > 0 && cliente && (
          <>
            <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-xs uppercase text-gray-500 font-bold">Cliente</div>
                  <div className="text-lg font-bold text-rose-900 flex items-center gap-2">
                    <User size={18} />
                    {cliente.nome || `Cód. ${cliente.codCliente}`}
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">
                    Cód: <b>{cliente.codCliente}</b>
                    {cliente.telefone && <> · Tel: <b>{cliente.telefone}</b></>}
                  </div>
                </div>
                <button
                  onClick={selectAll}
                  className="text-sm px-3 py-1.5 bg-rose-100 hover:bg-rose-200 text-rose-800 font-semibold rounded"
                >
                  {selected.size === installments.length ? 'Desmarcar todas' : 'Marcar todas'}
                </button>
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-32">
              <div className="px-4 py-2 bg-rose-50 border-b border-rose-100 text-xs font-bold uppercase text-rose-900 flex justify-between">
                <span>{installments.length} parcelas em aberto</span>
                <span>{selected.size} selecionadas</span>
              </div>
              <ul className="divide-y divide-gray-100">
                {installments.map((p) => {
                  const k = keyOf(p);
                  const isSel = selected.has(k);
                  return (
                    <li
                      key={k}
                      onClick={() => toggleSelect(k)}
                      className={`p-4 cursor-pointer transition flex items-start gap-3 ${
                        isSel ? 'bg-emerald-50 hover:bg-emerald-100' : 'hover:bg-rose-50'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex-shrink-0 mt-1 flex items-center justify-center ${
                        isSel ? 'bg-emerald-500 border-emerald-500' : 'border-gray-300 bg-white'
                      }`}>
                        {isSel && <Check size={14} className="text-white" />}
                      </div>
                      <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                        <div>
                          <div className="text-[10px] uppercase text-gray-500 font-bold">Promissória</div>
                          <div className="font-mono font-bold">
                            {p.numeroCompra || '—'}/{p.parcela}
                          </div>
                          {p.totalParcelas && (
                            <div className="text-[10px] text-gray-500">de {p.totalParcelas}</div>
                          )}
                        </div>
                        <div>
                          <div className="text-[10px] uppercase text-gray-500 font-bold">Vencimento</div>
                          <div className="font-mono">{formatDate(p.vencimento)}</div>
                          {p.diasAtraso > 0 && (
                            <div className="text-[10px] text-rose-700 font-bold">
                              {p.diasAtraso} dia{p.diasAtraso > 1 ? 's' : ''} atraso
                            </div>
                          )}
                        </div>
                        <div className="text-right md:text-left">
                          <div className="text-[10px] uppercase text-gray-500 font-bold">Valor</div>
                          <div className="font-mono">{brl(p.valorParcela)}</div>
                          {p.jurosCalculado > 0 && (
                            <div className="text-[10px] text-rose-700 font-bold">
                              + juros {brl(p.jurosCalculado)}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] uppercase text-gray-500 font-bold">Total</div>
                          <div className="font-bold text-emerald-700 tabular-nums">
                            {brl(p.valorComJuros)}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}

        {/* Footer fixo: total + receber */}
        {selecionadas.length > 0 && (
          <div className="fixed bottom-0 left-0 right-0 bg-white shadow-2xl border-t-4 border-emerald-500 p-4 z-30">
            <div className="max-w-4xl mx-auto flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <div className="text-xs uppercase text-gray-500 font-bold">
                  {selecionadas.length} parcela{selecionadas.length > 1 ? 's' : ''} selecionada{selecionadas.length > 1 ? 's' : ''}
                </div>
                <div className="text-2xl md:text-3xl font-black text-emerald-700 tabular-nums">
                  {brl(totalPago)}
                </div>
                {totalJuros > 0 && (
                  <div className="text-xs text-gray-600">
                    Principal {brl(totalPrincipal)} + juros {brl(totalJuros)}
                  </div>
                )}
              </div>
              <button
                onClick={abrirPagamento}
                className="px-6 py-4 bg-gradient-to-br from-emerald-500 to-emerald-700 hover:from-emerald-600 hover:to-emerald-800 text-white font-bold rounded-xl flex items-center gap-2 shadow-lg text-lg"
              >
                <Banknote size={22} />
                Receber pagamento
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Modal Pagamento */}
      {showPagamento && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b p-4 flex items-center justify-between">
              <h2 className="font-bold text-lg text-rose-900">Pagamento</h2>
              <button
                onClick={() => !aplicando && finalizarTudo()}
                disabled={aplicando}
                className="text-gray-500 hover:text-gray-800 p-1"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Resumo */}
              <div className="bg-emerald-50 rounded-lg p-3 text-sm">
                <div className="flex justify-between">
                  <span>{selecionadas.length} parcela{selecionadas.length > 1 ? 's' : ''}</span>
                  <span className="tabular-nums">{brl(totalPrincipal)}</span>
                </div>
                {totalJuros > 0 && (
                  <div className="flex justify-between text-rose-700">
                    <span>Juros</span>
                    <span className="tabular-nums">{brl(totalJuros)}</span>
                  </div>
                )}
                <div className="border-t border-emerald-200 pt-1 mt-1 flex justify-between text-lg font-bold">
                  <span>TOTAL</span>
                  <span className="tabular-nums text-emerald-700">{brl(totalPago)}</span>
                </div>
              </div>

              {!forma && !pixCharge && (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { setForma('dinheiro'); aplicarDinheiro(); }}
                    disabled={aplicando}
                    className="p-4 bg-amber-100 hover:bg-amber-200 border-2 border-amber-300 rounded-xl flex flex-col items-center gap-2 disabled:opacity-50"
                  >
                    <Banknote size={32} className="text-amber-700" />
                    <span className="font-bold text-amber-900">Dinheiro</span>
                  </button>
                  <button
                    onClick={() => { setForma('pix'); gerarPix(); }}
                    disabled={aplicando}
                    className="p-4 bg-emerald-100 hover:bg-emerald-200 border-2 border-emerald-300 rounded-xl flex flex-col items-center gap-2 disabled:opacity-50"
                  >
                    <QrCode size={32} className="text-emerald-700" />
                    <span className="font-bold text-emerald-900">PIX</span>
                  </button>
                </div>
              )}

              {/* PIX QR */}
              {forma === 'pix' && (
                <div className="space-y-3">
                  {aplicando && !pixCharge && (
                    <div className="text-center p-6">
                      <Loader2 className="w-8 h-8 animate-spin mx-auto text-emerald-600" />
                      <div className="text-sm text-gray-600 mt-2">Gerando QR PIX…</div>
                    </div>
                  )}
                  {pixCharge && (
                    <>
                      {pixPaid ? (
                        <div className="bg-emerald-100 border-2 border-emerald-400 rounded-lg p-4 text-center text-emerald-900 font-bold">
                          <CheckCircle2 size={32} className="mx-auto mb-2" />
                          Pagamento confirmado! Imprimindo recibo…
                        </div>
                      ) : (
                        <>
                          <div className="bg-emerald-50 border-2 border-emerald-300 rounded-xl p-3 flex justify-center">
                            <img
                              src={pixCharge.qrCodeImageUrl}
                              alt="QR PIX"
                              className="max-w-[240px] w-full"
                            />
                          </div>
                          <button
                            onClick={copyPix}
                            className="w-full px-3 py-2 bg-emerald-100 hover:bg-emerald-200 text-emerald-900 font-bold rounded text-sm flex items-center justify-center gap-2"
                          >
                            <Copy size={16} />
                            {copyMsg ? 'Copiado!' : 'Copiar PIX Copia e Cola'}
                          </button>
                          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-900">
                            Aguardando cliente pagar… O sistema confirma sozinho em ~1s.
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}

              {forma === 'dinheiro' && aplicando && (
                <div className="text-center p-6">
                  <Loader2 className="w-8 h-8 animate-spin mx-auto text-amber-600" />
                  <div className="text-sm text-gray-600 mt-2">Registrando baixa…</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
