'use client';

/**
 * /minha-loja/pdv/recebimentos — RECEBIMENTOS de crediário no PDV.
 *
 * Estratégia:
 *  1. Mount → carrega TODOS os clientes do Giga (query LEVE na tabela
 *     `clientes`, não toca em `movimento`). Cache 30min no backend.
 *  2. Frontend filtra local em JS por nome/código (busca instantânea).
 *  3. Click no cliente → expande em CASCATA suas parcelas (carrega
 *     sob demanda — query rápida `WHERE codcliente=X`).
 *  4. Marca parcelas → escolhe PIX/dinheiro → confirma → cupom imprime.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Search, Loader2, CheckCircle2, AlertCircle, Banknote, QrCode, Copy, Check, X,
  User, RefreshCw, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';

type Cliente = {
  codCliente: string;
  nome: string;
  telefone: string | null;
};

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

// Normalize SIMPLES — só lowercase + substituição manual de acentos.
// Sem regex Unicode (que estava bugando o filtro). Robusto e à prova de
// problemas de encoding do arquivo fonte.
const ACENTOS: Record<string, string> = {
  'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a',
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
  'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
  'ç': 'c', 'ñ': 'n',
};
const normalize = (s: string): string => {
  if (!s) return '';
  let out = String(s).toLowerCase().trim();
  out = out.replace(/[áàâãäéèêëíìîïóòôõöúùûüçñ]/g, (c) => ACENTOS[c] || c);
  return out;
};

function printReceipt(baixaId: string) {
  const url = `/minha-loja/pdv/recebimentos/recibo/${baixaId}?autoprint=1`;
  const electron = (window as any).electronAPI;
  if (electron?.silentPrintUrl) {
    electron.silentPrintUrl(window.location.origin + url).catch(() => hiddenIframe(url));
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
  } catch {
    window.open(url, 'lurds_recibo', 'width=320,height=520,resizable=yes');
  }
}

export default function RecebimentosPage() {
  // Lista de clientes (carrega 1x)
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loadingClientes, setLoadingClientes] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Busca local
  const [busca, setBusca] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Cliente expandido + suas parcelas
  const [expandedCod, setExpandedCod] = useState<string | null>(null);
  const [parcelasCache, setParcelasCache] = useState<Record<string, Installment[]>>({});
  const [parcelasLoading, setParcelasLoading] = useState<string | null>(null);
  const [parcelasError, setParcelasError] = useState<string | null>(null);

  // Seleção de parcelas
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Pagamento
  const [showPagamento, setShowPagamento] = useState(false);
  const [forma, setForma] = useState<'pix' | 'dinheiro' | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const [pixCharge, setPixCharge] = useState<PixCharge | null>(null);
  const [pixPaid, setPixPaid] = useState(false);
  const [copyMsg, setCopyMsg] = useState(false);

  // ── Load clientes ───────────────────────────────────────────

  async function loadClientes() {
    setLoadingClientes(true);
    setLoadError(null);
    try {
      const data = await api<Cliente[]>('/crediarios/baixa/clientes-todos');
      setClientes(data);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoadingClientes(false);
    }
  }

  useEffect(() => {
    loadClientes();
    inputRef.current?.focus();
  }, []);

  // ── Filtro local ────────────────────────────────────────────

  const clientesFiltrados = useMemo(() => {
    // BUSCA ULTRA-SIMPLES — só lowercase + includes. Sem regex Unicode.
    const q = normalize(busca);
    console.log(`[RECEBIMENTOS-V3] busca="${busca}" q="${q}" totalClientes=${clientes.length}`);
    if (q.length === 0) return clientes.slice(0, 200);

    const tokens = q.split(' ').filter((t) => t.length > 0);
    if (tokens.length === 0) return clientes.slice(0, 200);

    const filtered = clientes.filter((c) => {
      const nome = normalize(c.nome);
      const cod = String(c.codCliente || '').toLowerCase();
      // TODOS os tokens precisam bater no nome OU código
      return tokens.every((t) => nome.includes(t) || cod.includes(t));
    });
    console.log(`[RECEBIMENTOS-V3] tokens=${JSON.stringify(tokens)} → ${filtered.length} resultados`);
    if (filtered.length > 0 && filtered.length < 5) {
      console.log('[RECEBIMENTOS-V3] primeiros:', filtered.slice(0, 3).map((c) => `${c.nome}(${c.codCliente})`));
    }
    return filtered;
  }, [busca, clientes]);

  // ── Expandir cliente → carrega parcelas ─────────────────────

  async function toggleExpand(cod: string) {
    if (expandedCod === cod) {
      setExpandedCod(null);
      return;
    }
    setExpandedCod(cod);
    setParcelasError(null);
    if (parcelasCache[cod]) return; // já carregado
    setParcelasLoading(cod);
    try {
      const parcelas = await api<Installment[]>(
        `/crediarios/baixa/parcelas?codCliente=${encodeURIComponent(cod)}`,
      );
      setParcelasCache((prev) => ({ ...prev, [cod]: parcelas }));
    } catch (e: any) {
      setParcelasError(e?.message || String(e));
    } finally {
      setParcelasLoading(null);
    }
  }

  const parcelasExpandido = expandedCod ? parcelasCache[expandedCod] || [] : [];

  // ── Seleção ────────────────────────────────────────────────

  function keyOf(p: Installment) {
    return `${p.registro}/${p.controle}`;
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
    if (selected.size === parcelasExpandido.length) setSelected(new Set());
    else setSelected(new Set(parcelasExpandido.map(keyOf)));
  }

  const selecionadas = useMemo(
    () => parcelasExpandido.filter((p) => selected.has(keyOf(p))),
    [parcelasExpandido, selected],
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

  // ── Pagamento ──────────────────────────────────────────────

  function abrirPagamento() {
    if (selecionadas.length === 0) return;
    setShowPagamento(true);
    setForma(null);
    setPixCharge(null);
    setPixPaid(false);
  }

  const clienteAtual = clientes.find((c) => c.codCliente === expandedCod) || null;

  async function aplicarDinheiro() {
    setAplicando(true);
    try {
      const r = await api<{ baixaId: string }>('/crediarios/baixa/dinheiro', {
        method: 'POST',
        body: JSON.stringify({
          parcelas: selecionadas.map((p) => ({ registro: p.registro, controle: p.controle })),
        }),
      });
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
          customerName: clienteAtual?.nome || undefined,
          customerPhone: clienteAtual?.telefone || undefined,
        }),
      });
      setPixCharge(r);
    } catch (e: any) {
      alert('Erro ao gerar PIX: ' + (e?.message || e));
    } finally {
      setAplicando(false);
    }
  }

  // Polling status PIX
  useEffect(() => {
    if (!pixCharge || pixPaid) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api<{ status: string; isPaid?: boolean }>(`/crediarios/baixa/status/${pixCharge.baixaId}`);
        if (cancelled) return;
        if (r.isPaid) {
          setPixPaid(true);
          printReceipt(pixCharge.baixaId);
          setTimeout(() => finalizarTudo(), 1500);
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [pixCharge, pixPaid]);

  function finalizarTudo() {
    setShowPagamento(false);
    setSelected(new Set());
    // Limpa cache de parcelas do cliente atual (parcelas pagas saem)
    if (expandedCod) {
      setParcelasCache((prev) => {
        const next = { ...prev };
        delete next[expandedCod];
        return next;
      });
    }
    setExpandedCod(null);
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
    } catch {}
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-rose-50 to-pink-50 flex flex-col">
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-xl border-b border-rose-100 shadow-sm">
        <div className="max-w-4xl mx-auto p-4 flex items-center gap-3">
          <Link href="/minha-loja/pdv" className="p-2 rounded-lg hover:bg-rose-100 text-rose-700">
            <ArrowLeft size={20} />
          </Link>
          <h1 className="text-xl md:text-2xl font-bold text-rose-900">RECEBIMENTOS</h1>
          <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold">v3</span>
          <span className="text-xs text-gray-500 hidden md:inline flex-1">
            crediário · baixa de parcelas
          </span>
          <button
            onClick={loadClientes}
            disabled={loadingClientes}
            className="p-2 rounded-lg hover:bg-rose-100 text-rose-700 disabled:opacity-50"
            title="Recarregar lista"
          >
            <RefreshCw size={18} className={loadingClientes ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto w-full p-4 md:p-6">
        {loadingClientes && clientes.length === 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-12 text-center">
            <Loader2 className="w-10 h-10 animate-spin mx-auto text-rose-600" />
            <div className="mt-3 text-gray-700 font-bold">Carregando clientes…</div>
            <div className="text-xs text-gray-500 mt-1">Próximas buscas são instantâneas (cache).</div>
          </div>
        )}

        {loadError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-900 mb-4 flex items-start gap-2">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <div>
              <b>Erro:</b> {loadError}{' '}
              <button onClick={loadClientes} className="ml-2 underline">tentar de novo</button>
            </div>
          </div>
        )}

        {/* Busca */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
          <label className="block text-xs font-bold text-gray-700 mb-2 uppercase">
            Buscar cliente {!loadingClientes && clientes.length > 0 && (
              <span className="text-gray-500 normal-case">({clientes.length} cadastrados)</span>
            )}
          </label>
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              ref={inputRef}
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Digita o nome (ELISA, MARIA SILVA), CPF ou código..."
              className="w-full p-3 pl-10 border-2 rounded-lg text-base"
              autoComplete="off"
              disabled={loadingClientes && clientes.length === 0}
            />
          </div>
        </div>

        {!loadingClientes && clientes.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-32">
            <div className="px-4 py-2 bg-rose-50 border-b border-rose-100 text-xs font-bold uppercase text-rose-900 flex justify-between">
              <span>
                {busca.trim() ? `${clientesFiltrados.length} resultado${clientesFiltrados.length !== 1 ? 's' : ''}` : `${clientes.length} clientes`}
              </span>
              {!busca.trim() && clientes.length > 200 && (
                <span className="text-gray-500 normal-case">mostrando 200 — digite pra filtrar</span>
              )}
            </div>
            {clientesFiltrados.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-sm">
                Nenhum cliente. Tente parte do nome ou código.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
                {clientesFiltrados.map((c) => {
                  const isExpanded = expandedCod === c.codCliente;
                  const parcelas = parcelasCache[c.codCliente] || [];
                  const isLoadingThis = parcelasLoading === c.codCliente;
                  return (
                    <li key={c.codCliente}>
                      <div
                        onClick={() => toggleExpand(c.codCliente)}
                        className={`p-3 cursor-pointer transition flex items-center gap-3 ${
                          isExpanded ? 'bg-rose-100' : 'hover:bg-rose-50'
                        }`}
                      >
                        {isExpanded ? <ChevronDown size={18} className="text-rose-700" /> : <ChevronRight size={18} className="text-gray-400" />}
                        <div className="w-9 h-9 rounded-full bg-rose-200 text-rose-900 flex items-center justify-center flex-shrink-0">
                          <User size={16} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-bold text-rose-900 truncate">{c.nome}</div>
                          <div className="text-xs text-gray-600">
                            Cód: <b>{c.codCliente}</b>
                            {c.telefone && <> · Tel: <b>{c.telefone}</b></>}
                          </div>
                        </div>
                        {isLoadingThis && <Loader2 className="w-4 h-4 animate-spin text-rose-600 flex-shrink-0" />}
                      </div>

                      {/* Cascata: parcelas do cliente */}
                      {isExpanded && (
                        <div className="bg-white border-l-4 border-rose-300 ml-3">
                          {isLoadingThis ? (
                            <div className="p-4 text-center text-sm text-gray-500">
                              <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                              <div className="mt-2">Carregando parcelas…</div>
                            </div>
                          ) : parcelasError ? (
                            <div className="p-4 text-sm text-red-700 flex items-start gap-2">
                              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                              {parcelasError}
                            </div>
                          ) : parcelas.length === 0 ? (
                            <div className="p-4 text-center text-sm text-gray-500">
                              Esse cliente não tem parcelas em aberto.
                            </div>
                          ) : (
                            <>
                              <div className="px-3 py-2 bg-rose-50/50 text-[10px] font-bold uppercase text-rose-900 flex justify-between">
                                <span>{parcelas.length} parcela{parcelas.length > 1 ? 's' : ''} em aberto</span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); selectAll(); }}
                                  className="px-2 py-0.5 bg-rose-200 hover:bg-rose-300 text-rose-900 rounded text-[10px] font-bold normal-case"
                                >
                                  {selected.size === parcelas.length ? 'Desmarcar todas' : 'Marcar todas'}
                                </button>
                              </div>
                              <ul className="divide-y divide-gray-100">
                                {parcelas.map((p) => {
                                  const k = keyOf(p);
                                  const isSel = selected.has(k);
                                  const isVencida = p.diasAtraso > 0;
                                  return (
                                    <li
                                      key={k}
                                      onClick={(e) => { e.stopPropagation(); toggleSelect(k); }}
                                      className={`p-3 cursor-pointer flex items-start gap-3 ${
                                        isSel ? 'bg-emerald-50' : 'hover:bg-gray-50'
                                      }`}
                                    >
                                      <div className={`w-5 h-5 rounded border-2 flex-shrink-0 mt-0.5 flex items-center justify-center ${
                                        isSel ? 'bg-emerald-500 border-emerald-500' : 'border-gray-300 bg-white'
                                      }`}>
                                        {isSel && <Check size={14} className="text-white" />}
                                      </div>
                                      <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
                                        <div>
                                          <div className="text-[9px] uppercase text-gray-500 font-bold">Promissória</div>
                                          <div className="font-mono font-bold text-xs">
                                            {p.numeroCompra || '—'}/{p.parcela}
                                          </div>
                                          {p.totalParcelas && <div className="text-[9px] text-gray-500">de {p.totalParcelas}</div>}
                                        </div>
                                        <div>
                                          <div className="text-[9px] uppercase text-gray-500 font-bold">Vencto</div>
                                          <div className={`font-mono text-xs ${isVencida ? 'text-rose-700 font-bold' : ''}`}>
                                            {formatDate(p.vencimento)}
                                          </div>
                                          {isVencida && (
                                            <div className="text-[9px] text-rose-700 font-bold">{p.diasAtraso}d atraso</div>
                                          )}
                                        </div>
                                        <div className="text-right md:text-left">
                                          <div className="text-[9px] uppercase text-gray-500 font-bold">Valor</div>
                                          <div className="font-mono text-xs">{brl(p.valorParcela)}</div>
                                          {p.jurosCalculado > 0 && (
                                            <div className="text-[9px] text-rose-700 font-bold">+ juros {brl(p.jurosCalculado)}</div>
                                          )}
                                        </div>
                                        <div className="text-right">
                                          <div className="text-[9px] uppercase text-gray-500 font-bold">Total</div>
                                          <div className="font-bold text-emerald-700 tabular-nums text-sm">
                                            {brl(p.valorComJuros)}
                                          </div>
                                        </div>
                                      </div>
                                    </li>
                                  );
                                })}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* Footer fixo: total + receber */}
        {selecionadas.length > 0 && (
          <div className="fixed bottom-0 left-0 right-0 bg-white shadow-2xl border-t-4 border-emerald-500 p-4 z-30">
            <div className="max-w-4xl mx-auto flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <div className="text-xs uppercase text-gray-500 font-bold">
                  {selecionadas.length} parcela{selecionadas.length > 1 ? 's' : ''} · {clienteAtual?.nome || ''}
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

      {/* Modal Pagamento (mantido igual) */}
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
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={pixCharge.qrCodeImageUrl} alt="QR PIX" className="max-w-[240px] w-full" />
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
