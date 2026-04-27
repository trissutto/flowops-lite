'use client';

/**
 * /minha-loja/pdv — Frente de caixa (PDV TESTE).
 *
 * Fluxo:
 *   1. Tela abre venda OPEN automaticamente (ou retoma a última)
 *   2. Vendedora bipa SKU/EAN → adiciona ao carrinho (se já tem, incrementa)
 *   3. Pode editar qty, remover item, identificar cliente
 *   4. Clica "Finalizar" → escolhe pagamento → gera NFC-e (preview por enquanto)
 *   5. Modal final: cupom + botões enviar email/WhatsApp + nova venda
 *
 * Mobile-first. Listener global de teclas pra foco automático.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, X, Barcode, ArrowRight, Trash2, Plus, Minus,
  ShoppingCart, User, CreditCard, Banknote, QrCode, Check, AlertCircle,
  Send, Mail, MessageSquare, FileText, RotateCcw, History, Percent,
  Clock, ChevronRight, Pause,
} from 'lucide-react';
import { api } from '@/lib/api';

type Sale = {
  id: string;
  storeCode: string;
  storeName: string;
  vendedorName: string | null;
  customerCpf: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  status: 'open' | 'finalized' | 'cancelled' | string;
  subtotal: number;
  desconto: number;
  total: number;
  activePromotion: string | null;
  paymentMethod: string | null;
  nfceNumber: string | null;
  nfceChave: string | null;
  nfceXml: string | null;
  finalizedAt: string | null;
  items: Array<{
    id: string;
    sku: string;
    ean: string | null;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string;
    dataCadastro: string | null;
    qty: number;
    precoUnit: number;
    desconto: number;
    promoTag: string | null;
    total: number;
  }>;
};

type Store = { id: string; code: string; name: string; active: boolean };

const PAYMENT_METHODS = [
  { id: 'dinheiro', label: 'Dinheiro', icon: Banknote },
  { id: 'pix', label: 'PIX', icon: QrCode },
  { id: 'debito', label: 'Cartão Débito', icon: CreditCard },
  { id: 'credito', label: 'Cartão Crédito', icon: CreditCard },
  { id: 'crediario', label: 'Crediário', icon: User },
] as const;

const BANDEIRAS_DEBITO = ['REDESHOP', 'VISA ELECTRON', 'ELO'] as const;
const BANDEIRAS_CREDITO = ['MASTERCARD', 'VISANET', 'HIPERCARD', 'AMEX'] as const;

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function PdvPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeCode, setStoreCode] = useState<string>('');
  const [sale, setSale] = useState<Sale | null>(null);
  const [loadingSale, setLoadingSale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scanInput, setScanInput] = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [showCustomer, setShowCustomer] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [showFinalized, setShowFinalized] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  // ── Load lojas + restaura store + abre/retoma venda ──
  useEffect(() => {
    api<Store[]>('/stores')
      .then((arr) => {
        const ativas = arr.filter((s) => s.active).sort((a, b) => a.code.localeCompare(b.code));
        setStores(ativas);
        const saved = typeof window !== 'undefined' ? localStorage.getItem('lurds_pdv_store') : null;
        if (saved && ativas.find((s) => s.code === saved)) {
          setStoreCode(saved);
        } else if (ativas.length === 1) {
          setStoreCode(ativas[0].code);
        }
      })
      .catch(() => setError('Erro ao carregar lojas'));
  }, []);

  // Salva store escolhida + abre venda
  useEffect(() => {
    if (!storeCode) return;
    try {
      localStorage.setItem('lurds_pdv_store', storeCode);
    } catch {
      /* noop */
    }
    // Abre venda nova (se não tiver uma OPEN salva)
    const lastSaleId = localStorage.getItem(`lurds_pdv_sale_${storeCode}`);
    if (lastSaleId) {
      // Tenta retomar
      api<Sale>(`/pdv/sales/${lastSaleId}`)
        .then((s) => {
          if (s.status === 'open' && s.storeCode === storeCode) {
            setSale(s);
          } else {
            localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
            createNewSale();
          }
        })
        .catch(() => {
          localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
          createNewSale();
        });
    } else {
      createNewSale();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCode]);

  const createNewSale = async () => {
    if (!storeCode) return;
    setLoadingSale(true);
    setError(null);
    try {
      const s = await api<Sale>('/pdv/sales', {
        method: 'POST',
        body: JSON.stringify({ storeCode }),
      });
      // GET pra ter `items: []` populado
      const full = await api<Sale>(`/pdv/sales/${s.id}`);
      setSale(full);
      try {
        localStorage.setItem(`lurds_pdv_sale_${storeCode}`, full.id);
      } catch {
        /* noop */
      }
    } catch (e: any) {
      setError(e?.message || 'Erro ao abrir venda');
    } finally {
      setLoadingSale(false);
    }
  };

  // ── Foco automático ──
  useEffect(() => {
    if (!sale || sale.status !== 'open') return;
    if (!showCustomer && !showPayment && !showFinalized) {
      inputRef.current?.focus();
    }
  }, [sale, showCustomer, showPayment, showFinalized]);

  // Listener global: qualquer tecla redireciona pro input
  useEffect(() => {
    if (!sale || sale.status !== 'open') return;
    if (showCustomer || showPayment || showFinalized) return;
    const handler = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          (active as HTMLElement).isContentEditable)
      ) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') {
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [sale, showCustomer, showPayment, showFinalized]);

  // ── Bipagem ──
  const handleScan = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!sale) return;
    const sku = scanInput.trim();
    if (!sku) return;
    setScanLoading(true);
    setError(null);
    try {
      await api(`/pdv/sales/${sale.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ skuOrEan: sku }),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      setScanInput('');
    } catch (e: any) {
      setError(e?.message || 'Erro ao bipar');
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

  // ── Atualizar qty/desconto do item ──
  const updateItem = async (itemId: string, patch: { qty?: number; desconto?: number }) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // ── Trocar campanha promocional ATIVA ──
  const setPromotion = async (promotion: string | null) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/promotion`, {
        method: 'PATCH',
        body: JSON.stringify({ promotion }),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // ── Aplicar desconto na venda inteira ──
  const setSaleDiscount = async (desconto: number) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({ desconto }),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // ── "Fechar depois" — deixa venda OPEN e abre nova ──
  const fecharDepois = () => {
    if (!sale || !sale.items?.length) return;
    setShowPayment(false);
    // Limpa referência da venda atual e cria nova (a anterior fica OPEN no DB)
    localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
    setSale(null);
    createNewSale();
    // Recarrega contagem de vendas em aberto
    loadOpenCount();
  };

  // ── Vendas em aberto (badge) ──
  const [openCount, setOpenCount] = useState(0);
  const [showOpenList, setShowOpenList] = useState(false);
  const loadOpenCount = async () => {
    if (!storeCode) return;
    try {
      const list = await api<any[]>(`/pdv/sales?storeCode=${storeCode}&status=open&limit=50`);
      // Não conta a venda ATUAL (que também é open)
      const others = list.filter((s) => s.id !== sale?.id);
      setOpenCount(others.length);
    } catch {
      setOpenCount(0);
    }
  };
  useEffect(() => {
    if (storeCode) loadOpenCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCode, sale?.id]);

  const retomarVenda = async (saleId: string) => {
    try {
      const s = await api<Sale>(`/pdv/sales/${saleId}`);
      if (s.status !== 'open') {
        alert('Essa venda não está mais aberta');
        return;
      }
      setSale(s);
      try {
        localStorage.setItem(`lurds_pdv_sale_${storeCode}`, s.id);
      } catch { /* noop */ }
      setShowOpenList(false);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  const removeItem = async (itemId: string) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/items/${itemId}`, { method: 'DELETE' });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // ── Cliente ──
  const saveCustomer = async (data: { cpf: string; name: string; email: string; phone: string }) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/customer`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      setShowCustomer(false);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // ── Cancelar ──
  const cancelSale = async () => {
    if (!sale) return;
    if (!confirm('Cancelar essa venda? Vai perder tudo bipado.')) return;
    try {
      await api(`/pdv/sales/${sale.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Cancelado pela vendedora' }),
      });
      localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
      createNewSale();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // ── Finalizar ──
  const finalizeSale = async (paymentMethod: string, paymentDetails?: any) => {
    if (!sale) return;
    setFinalizing(true);
    try {
      const result = await api<{ ok: boolean; sale: Sale }>(
        `/pdv/sales/${sale.id}/finalize`,
        {
          method: 'POST',
          body: JSON.stringify({ paymentMethod, paymentDetails }),
        },
      );
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      setShowPayment(false);
      setShowFinalized(true);
      localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setFinalizing(false);
    }
  };

  const startNewSale = () => {
    setShowFinalized(false);
    setSale(null);
    createNewSale();
  };

  // ── Render ──

  if (!storeCode) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-md p-6 max-w-sm w-full space-y-4">
          <Link href="/minha-loja" className="text-slate-500 text-sm flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> Voltar
          </Link>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-emerald-600" /> PDV — Selecione a loja
          </h1>
          <select
            value={storeCode}
            onChange={(e) => setStoreCode(e.target.value)}
            className="w-full text-sm border rounded-md px-3 py-2"
          >
            <option value="">Escolha...</option>
            {stores.map((s) => (
              <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b shadow-sm">
        <div className="max-w-3xl mx-auto px-3 py-2 flex items-center gap-2">
          <Link href="/minha-loja" className="text-slate-500 hover:text-slate-700" aria-label="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-slate-800 flex items-center gap-1.5">
              <ShoppingCart className="w-4 h-4 text-emerald-600" />
              PDV {sale?.storeCode}
            </h1>
            <p className="text-[11px] text-slate-500 truncate">
              {sale ? `Venda ${sale.id.slice(-6).toUpperCase()} · ${sale.items?.length || 0} item(ns)` : 'Carregando...'}
            </p>
          </div>
          <button
            onClick={() => setShowCustomer(true)}
            disabled={!sale || sale.status !== 'open'}
            className="text-xs px-2 py-1.5 rounded bg-slate-100 hover:bg-slate-200 flex items-center gap-1 disabled:opacity-50"
            title="Identificar cliente"
          >
            <User className="w-3.5 h-3.5" />
            {sale?.customerCpf ? sale.customerName?.split(' ')[0] || 'Cliente' : 'Cliente'}
          </button>

          {/* Badge vendas em aberto */}
          <button
            onClick={() => setShowOpenList(true)}
            disabled={openCount === 0}
            className="text-xs px-2 py-1.5 rounded bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 flex items-center gap-1 disabled:opacity-30 disabled:bg-slate-100 disabled:text-slate-400 disabled:border-slate-200"
            title={openCount > 0 ? `${openCount} venda(s) em aberto` : 'Nenhuma venda em aberto'}
          >
            <Pause className="w-3.5 h-3.5" />
            {openCount > 0 && (
              <span className="font-bold tabular-nums">{openCount}</span>
            )}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full p-3 space-y-3 pb-32">
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 p-2 rounded text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Input bipagem */}
        {sale?.status === 'open' && (
          <form
            onSubmit={handleScan}
            className="bg-white rounded-lg border-2 border-emerald-300 p-3 shadow-sm"
          >
            <label className="text-xs uppercase font-semibold text-emerald-700 flex items-center gap-1 mb-1.5">
              <Barcode className="w-3.5 h-3.5" />
              Bipe o produto
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="SKU ou EAN"
                disabled={scanLoading}
                className="flex-1 px-4 py-3 text-lg font-mono border rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-50"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                type="submit"
                disabled={!scanInput || scanLoading}
                className="px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-md flex items-center disabled:opacity-40"
              >
                {scanLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
              </button>
            </div>
          </form>
        )}

        {/* Carrinho */}
        {loadingSale ? (
          <div className="text-center py-10 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin inline-block" />
          </div>
        ) : sale && sale.items?.length > 0 ? (
          <div className="bg-white rounded-lg border overflow-hidden">
            {/* Seletor de campanha */}
            <div className="px-3 py-2 bg-gradient-to-r from-fuchsia-50 to-amber-50 border-b border-fuchsia-200">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-xs uppercase font-bold text-fuchsia-700 flex items-center gap-1">
                  <span>🎁</span> Campanha promocional ativa
                </div>
                {sale.activePromotion && (
                  <button
                    onClick={() => setPromotion('NONE')}
                    className="text-[10px] text-rose-600 hover:underline"
                  >
                    Remover
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                <button
                  onClick={() => setPromotion('NONE')}
                  className={`text-xs py-1.5 px-1 rounded font-bold transition-colors border ${
                    !sale.activePromotion
                      ? 'bg-slate-700 text-white border-slate-700'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                  }`}
                >
                  Nenhuma
                </button>
                <button
                  onClick={() => setPromotion('YEAR_BASED')}
                  className={`text-xs py-1.5 px-1 rounded font-bold transition-colors border ${
                    sale.activePromotion === 'YEAR_BASED'
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-amber-700 border-amber-200 hover:border-amber-400'
                  }`}
                >
                  Por ano
                  <div className="text-[9px] font-normal">2023:20% · 2022:30% · ≤21:50%</div>
                </button>
                <button
                  onClick={() => setPromotion('FOUR_FOR_THREE')}
                  className={`text-xs py-1.5 px-1 rounded font-bold transition-colors border ${
                    sale.activePromotion === 'FOUR_FOR_THREE'
                      ? 'bg-fuchsia-600 text-white border-fuchsia-600'
                      : 'bg-white text-fuchsia-700 border-fuchsia-200 hover:border-fuchsia-400'
                  }`}
                >
                  4 LEVA 3
                  <div className="text-[9px] font-normal">menor sai grátis</div>
                </button>
              </div>
              {/* Status da campanha */}
              {sale.activePromotion === 'FOUR_FOR_THREE' && (() => {
                const totalPecas = sale.items.reduce((s, i) => s + i.qty, 0);
                if (totalPecas >= 4) {
                  return (
                    <div className="mt-1.5 text-[11px] text-fuchsia-800 bg-fuchsia-100 rounded px-2 py-1 font-semibold">
                      ✓ ATIVA — peça de menor valor saiu grátis
                    </div>
                  );
                }
                const faltam = 4 - totalPecas;
                return (
                  <div className="mt-1.5 text-[11px] text-amber-800 bg-amber-100 rounded px-2 py-1">
                    Falta{faltam > 1 ? 'm' : ''} {faltam} peça{faltam > 1 ? 's' : ''} pra ativar
                  </div>
                );
              })()}
            </div>
            <div className="px-3 py-2 bg-slate-50 border-b text-xs uppercase font-semibold text-slate-500">
              Carrinho ({sale.items.length})
            </div>
            <div className="divide-y">
              {sale.items.map((it) => {
                const bruto = it.precoUnit * it.qty;
                return (
                <div key={it.id} className="p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm font-bold text-slate-800">
                      {it.ref || it.sku}
                      {it.cor && <span className="ml-1.5 text-slate-500 font-normal">{it.cor}</span>}
                      {it.tamanho && <span className="ml-1 text-slate-500 font-normal">/{it.tamanho}</span>}
                    </div>
                    {it.descricao && (
                      <div className="text-[11px] text-slate-500 truncate">{it.descricao}</div>
                    )}
                    <div className="text-xs text-slate-600 mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>{brl(it.precoUnit)} cada</span>
                      {it.desconto > 0 && !it.promoTag && (
                        <span className="text-rose-600 font-semibold">−{brl(it.desconto)} desc</span>
                      )}
                      {it.promoTag && (
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            it.promoTag.includes('4 LEVA 3')
                              ? 'bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-300'
                              : 'bg-amber-100 text-amber-800 border border-amber-300'
                          }`}
                          title={`Desconto: ${brl(it.desconto)}`}
                        >
                          🎁 {it.promoTag}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => updateItem(it.id, { qty: it.qty - 1 })}
                      disabled={it.qty <= 1 || sale.status !== 'open'}
                      className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200 flex items-center justify-center disabled:opacity-30"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <span className="w-8 text-center font-bold tabular-nums">{it.qty}</span>
                    <button
                      onClick={() => updateItem(it.id, { qty: it.qty + 1 })}
                      disabled={sale.status !== 'open'}
                      className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200 flex items-center justify-center disabled:opacity-30"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="w-24 text-right shrink-0">
                    <div className="font-bold text-emerald-700 tabular-nums">{brl(it.total)}</div>
                    {it.desconto > 0 && (
                      <div className="text-[10px] text-slate-400 line-through tabular-nums">{brl(bruto)}</div>
                    )}
                  </div>
                  {sale.status === 'open' && (
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => {
                          const max = bruto.toFixed(2).replace('.', ',');
                          const cur = (it.desconto || 0).toFixed(2).replace('.', ',');
                          const v = window.prompt(
                            `Desconto desse item em R$ (máx ${max}):\nValor atual: ${cur}`,
                            cur,
                          );
                          if (v == null) return;
                          const n = Number(v.trim().replace(/\./g, '').replace(',', '.'));
                          if (isNaN(n) || n < 0) {
                            alert('Valor inválido');
                            return;
                          }
                          updateItem(it.id, { desconto: n });
                        }}
                        className="text-slate-400 hover:text-amber-600 p-1"
                        title="Desconto neste item"
                      >
                        <Percent className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => removeItem(it.id)}
                        className="text-slate-400 hover:text-rose-600 p-1"
                        title="Remover"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        ) : sale?.status === 'open' ? (
          <div className="text-center py-10 text-slate-400 bg-white rounded-lg border-2 border-dashed">
            <ShoppingCart className="w-10 h-10 inline-block mb-2 opacity-50" />
            <div className="text-sm">Carrinho vazio · bipe o primeiro produto</div>
          </div>
        ) : null}
      </main>

      {/* Footer fixo: total + finalizar */}
      {sale?.status === 'open' && (
        <footer className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg z-10">
          <div className="max-w-3xl mx-auto px-3 py-2">
            {sale.desconto > 0 && (
              <div className="flex items-center justify-between text-xs text-slate-500 mb-1 px-1">
                <span>Subtotal</span>
                <span className="tabular-nums">{brl(sale.subtotal)}</span>
              </div>
            )}
            {sale.desconto > 0 && (
              <div className="flex items-center justify-between text-xs text-emerald-700 mb-1 px-1 font-semibold">
                <span>🎁 Você economizou</span>
                <span className="tabular-nums">−{brl(sale.desconto)}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={cancelSale}
                className="text-xs text-rose-600 hover:bg-rose-50 px-2 py-2 rounded"
                title="Cancelar venda"
              >
                <X className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  const subtotalLiquido = sale.items.reduce((s, i) => s + i.total, 0);
                  const cur = (sale.desconto || 0).toFixed(2).replace('.', ',');
                  const v = window.prompt(
                    `Desconto na venda inteira em R$ (máx ${subtotalLiquido.toFixed(2).replace('.', ',')}):\nValor atual: ${cur}`,
                    cur,
                  );
                  if (v == null) return;
                  const n = Number(v.trim().replace(/\./g, '').replace(',', '.'));
                  if (isNaN(n) || n < 0) {
                    alert('Valor inválido');
                    return;
                  }
                  setSaleDiscount(n);
                }}
                className="text-xs text-amber-700 hover:bg-amber-50 px-2 py-2 rounded flex items-center gap-1"
                title="Desconto na venda"
              >
                <Percent className="w-4 h-4" />
              </button>
              <div className="flex-1">
                <div className="text-[10px] text-slate-500 uppercase">Total</div>
                <div className="text-2xl font-bold text-emerald-700 tabular-nums leading-none">
                  {brl(sale.total)}
                </div>
              </div>
              <button
                onClick={() => setShowPayment(true)}
                disabled={!sale.items?.length || sale.total <= 0}
                className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg flex items-center gap-2 disabled:opacity-40"
              >
                <Check className="w-5 h-5" />
                Finalizar
              </button>
            </div>
          </div>
        </footer>
      )}

      {/* Modal Cliente */}
      {showCustomer && sale && (
        <CustomerModal
          initial={{
            cpf: sale.customerCpf || '',
            name: sale.customerName || '',
            email: sale.customerEmail || '',
            phone: sale.customerPhone || '',
          }}
          onClose={() => setShowCustomer(false)}
          onSave={saveCustomer}
        />
      )}

      {/* Modal Pagamento */}
      {showPayment && sale && (
        <PaymentModal
          total={sale.total}
          customerCpf={sale.customerCpf}
          finalizing={finalizing}
          onClose={() => setShowPayment(false)}
          onConfirm={finalizeSale}
          onLater={fecharDepois}
        />
      )}

      {/* Modal Vendas em Aberto (retomar) */}
      {showOpenList && (
        <OpenSalesModal
          storeCode={storeCode}
          currentSaleId={sale?.id}
          onClose={() => setShowOpenList(false)}
          onResume={retomarVenda}
          onRefresh={loadOpenCount}
        />
      )}

      {/* Modal Finalizada */}
      {showFinalized && sale && sale.status === 'finalized' && (
        <FinalizedModal sale={sale} onNew={startNewSale} />
      )}
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────

function CustomerModal({
  initial,
  onClose,
  onSave,
}: {
  initial: { cpf: string; name: string; email: string; phone: string };
  onClose: () => void;
  onSave: (d: { cpf: string; name: string; email: string; phone: string }) => void;
}) {
  const [cpf, setCpf] = useState(initial.cpf);
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [phone, setPhone] = useState(initial.phone);
  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-lg w-full max-w-md p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <User className="w-4 h-4" /> Identificar cliente
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-2">
          <input
            value={cpf}
            onChange={(e) => setCpf(e.target.value)}
            placeholder="CPF"
            className="w-full border rounded px-3 py-2 text-sm"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome"
            className="w-full border rounded px-3 py-2 text-sm"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="E-mail (pra mandar nota)"
            className="w-full border rounded px-3 py-2 text-sm"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="WhatsApp"
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={() => onSave({ cpf, name, email, phone })}
          className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded"
        >
          Salvar
        </button>
      </div>
    </div>
  );
}

function PaymentModal({
  total,
  customerCpf,
  finalizing,
  onClose,
  onConfirm,
  onLater,
}: {
  total: number;
  customerCpf: string | null;
  finalizing: boolean;
  onClose: () => void;
  onConfirm: (method: string, details?: any) => void;
  onLater: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [bandeira, setBandeira] = useState<string | null>(null);
  const [parcelas, setParcelas] = useState(1);
  const [recebido, setRecebido] = useState('');

  const recebidoNum = Number((recebido || '0').replace(/\./g, '').replace(',', '.'));
  const troco = selected === 'dinheiro' && recebidoNum > total ? recebidoNum - total : 0;

  // Reset bandeira ao trocar de método
  const selectMethod = (id: string) => {
    setSelected(id);
    setBandeira(null);
    setParcelas(1);
  };

  const needsBandeira = selected === 'debito' || selected === 'credito';
  const bandeiras =
    selected === 'debito'
      ? BANDEIRAS_DEBITO
      : selected === 'credito'
      ? BANDEIRAS_CREDITO
      : [];

  const canConfirm = useMemo(() => {
    if (!selected) return false;
    if (selected === 'crediario' && !customerCpf) return false;
    if (selected === 'dinheiro' && recebidoNum < total) return false;
    if (needsBandeira && !bandeira) return false;
    return true;
  }, [selected, bandeira, needsBandeira, recebidoNum, total, customerCpf]);

  const confirm = () => {
    if (!selected) return;
    const details: any = {};
    if (selected === 'credito' || selected === 'crediario') details.parcelas = parcelas;
    if (selected === 'dinheiro') {
      details.recebido = recebidoNum;
      details.troco = troco;
    }
    if (needsBandeira) details.bandeira = bandeira;
    onConfirm(selected, details);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-lg w-full max-w-md p-4 space-y-3 max-h-[95vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> Pagamento
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        <div className="text-center py-2 bg-emerald-50 rounded">
          <div className="text-xs text-slate-500 uppercase">Total a pagar</div>
          <div className="text-3xl font-bold text-emerald-700 tabular-nums">{brl(total)}</div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {PAYMENT_METHODS.map((p) => {
            const Icon = p.icon;
            const isSelected = selected === p.id;
            const disabled = p.id === 'crediario' && !customerCpf;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => !disabled && selectMethod(p.id)}
                disabled={disabled}
                className={`p-3 rounded-lg border-2 text-sm font-bold transition-colors flex flex-col items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed ${
                  isSelected
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 hover:border-slate-300 text-slate-600'
                }`}
                title={disabled ? 'Crediário exige CPF do cliente' : ''}
              >
                <Icon className="w-5 h-5" />
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Sub-bandeiras (débito/crédito) */}
        {needsBandeira && (
          <div className="space-y-2 pt-2 border-t">
            <label className="text-xs text-slate-600 uppercase font-semibold">Bandeira</label>
            <div className={`grid gap-1.5 ${bandeiras.length === 4 ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {bandeiras.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBandeira(b)}
                  className={`py-3 px-2 rounded border-2 transition-all flex items-center justify-center min-h-[56px] ${
                    bandeira === b
                      ? 'border-emerald-600 bg-emerald-50 shadow-md scale-105'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <BandeiraLogo brand={b} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Detalhes dinheiro */}
        {selected === 'dinheiro' && (
          <div className="space-y-2 pt-2 border-t">
            <label className="text-xs text-slate-600 uppercase font-semibold">Valor recebido</label>
            <input
              type="text"
              inputMode="decimal"
              value={recebido}
              onChange={(e) => setRecebido(e.target.value)}
              placeholder={total.toFixed(2).replace('.', ',')}
              className="w-full border rounded px-3 py-2 text-lg font-mono"
              autoFocus
            />
            {troco > 0 && (
              <div className="flex justify-between text-sm bg-amber-50 p-2 rounded">
                <span>Troco</span>
                <span className="font-bold text-amber-700">{brl(troco)}</span>
              </div>
            )}
          </div>
        )}

        {/* Parcelas (crédito ou crediário) — 1 a 12x sem juros */}
        {(selected === 'credito' || selected === 'crediario') && (
          <div className="space-y-2 pt-2 border-t">
            <label className="text-xs text-slate-600 uppercase font-semibold">
              Parcelas (sem juros)
            </label>
            <div className="grid grid-cols-6 gap-1">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setParcelas(p)}
                  className={`py-2 rounded text-sm font-bold transition-colors ${
                    parcelas === p ? 'bg-emerald-600 text-white shadow' : 'bg-slate-100 hover:bg-slate-200'
                  }`}
                >
                  {p}×
                </button>
              ))}
            </div>
            <div className="text-center text-sm bg-emerald-50 rounded py-2">
              <span className="text-slate-600">{parcelas}× de </span>
              <span className="font-bold text-emerald-700 text-lg">{brl(total / parcelas)}</span>
              <span className="text-slate-500 text-xs ml-1">sem juros</span>
            </div>
          </div>
        )}

        <button
          onClick={confirm}
          disabled={!canConfirm || finalizing}
          className="w-full px-3 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded text-base disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {finalizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Confirmar pagamento
        </button>

        {/* Fechar depois — separa visualmente do botão principal */}
        <div className="border-t pt-3">
          <button
            onClick={onLater}
            disabled={finalizing}
            className="w-full px-3 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-semibold rounded text-sm flex items-center justify-center gap-2"
            title="Pausar a venda — fica em aberto pra finalizar depois"
          >
            <Pause className="w-4 h-4" />
            Fechar depois (pausar)
          </button>
          <p className="text-[10px] text-slate-500 text-center mt-1">
            A venda fica em aberto. Você atende outra cliente e volta nessa pelo botão <Pause className="w-3 h-3 inline" /> do topo.
          </p>
        </div>
      </div>
    </div>
  );
}

function FinalizedModal({ sale, onNew }: { sale: Sale; onNew: () => void }) {
  const [showXml, setShowXml] = useState(false);
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg w-full max-w-md my-8 overflow-hidden">
        <div className="px-4 py-3 bg-emerald-50 border-b text-center">
          <Check className="w-10 h-10 mx-auto text-emerald-600 mb-1" />
          <h2 className="font-bold text-lg text-emerald-900">Venda Finalizada</h2>
          <p className="text-xs text-emerald-700">
            {brl(sale.total)} · {sale.paymentMethod?.toUpperCase()}
          </p>
        </div>
        <div className="p-4 space-y-3">
          {/* Mini cupom */}
          <div className="bg-slate-50 border border-dashed rounded p-3 text-xs font-mono space-y-1">
            <div className="text-center font-bold mb-1">CUPOM FISCAL ELETRÔNICO</div>
            <div className="text-center text-[10px] text-slate-500">
              {sale.storeName} · NFC-e {sale.nfceNumber || '—'}
            </div>
            {sale.nfceChave && (
              <div className="text-center text-[9px] text-slate-400 break-all">
                Chave: {sale.nfceChave}
              </div>
            )}
            {sale.customerCpf && (
              <div className="text-[10px]">CPF: {sale.customerCpf}</div>
            )}
            <hr className="border-slate-300 my-1" />
            {sale.items.map((it) => (
              <div key={it.id} className="flex justify-between">
                <span className="truncate">{it.qty}× {it.ref || it.sku} {it.cor || ''}/{it.tamanho || ''}</span>
                <span className="tabular-nums">{brl(it.total)}</span>
              </div>
            ))}
            <hr className="border-slate-300 my-1" />
            <div className="flex justify-between font-bold">
              <span>TOTAL</span>
              <span className="tabular-nums">{brl(sale.total)}</span>
            </div>
            <div className="text-[10px] text-amber-700 text-center mt-2 italic">
              ⚠ NFC-e MODO PREVIEW — não emitida na SEFAZ
            </div>
          </div>

          {/* Ações de envio (mockadas) */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => alert('Envio por email — a integrar (Resend/SES)')}
              disabled={!sale.customerEmail}
              className="px-3 py-2 text-sm border-2 border-blue-200 text-blue-700 rounded hover:bg-blue-50 flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              <Mail className="w-4 h-4" />
              Email
            </button>
            <button
              onClick={() => alert('Envio por WhatsApp — a integrar (Baileys)')}
              disabled={!sale.customerPhone}
              className="px-3 py-2 text-sm border-2 border-emerald-200 text-emerald-700 rounded hover:bg-emerald-50 flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              <MessageSquare className="w-4 h-4" />
              WhatsApp
            </button>
          </div>

          <button
            onClick={() => setShowXml(!showXml)}
            className="w-full text-xs text-slate-500 hover:text-slate-700 flex items-center justify-center gap-1"
          >
            <FileText className="w-3 h-3" />
            {showXml ? 'Esconder XML NFC-e' : 'Ver XML NFC-e (preview)'}
          </button>
          {showXml && sale.nfceXml && (
            <pre className="bg-slate-900 text-emerald-300 text-[9px] font-mono p-2 rounded max-h-60 overflow-auto">
              {sale.nfceXml}
            </pre>
          )}

          <button
            onClick={onNew}
            className="w-full px-3 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded flex items-center justify-center gap-2"
          >
            <RotateCcw className="w-4 h-4" />
            Nova venda
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal Vendas em Aberto ────────────────────────────────────────────

function OpenSalesModal({
  storeCode,
  currentSaleId,
  onClose,
  onResume,
  onRefresh,
}: {
  storeCode: string;
  currentSaleId?: string;
  onClose: () => void;
  onResume: (id: string) => void;
  onRefresh: () => void;
}) {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const arr = await api<any[]>(`/pdv/sales?storeCode=${storeCode}&status=open&limit=50`);
      setList(arr.filter((s) => s.id !== currentSaleId));
    } catch {
      setList([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelOne = async (id: string) => {
    if (!confirm('Cancelar essa venda em aberto?')) return;
    try {
      await api(`/pdv/sales/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'Cancelada do painel de vendas em aberto' }),
      });
      load();
      onRefresh();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-md my-8 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 bg-amber-50 border-b flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <Pause className="w-4 h-4 text-amber-700" />
            Vendas em aberto
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <div className="p-3 space-y-2 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="text-center py-6 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin inline-block" />
            </div>
          ) : list.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-sm">
              Nenhuma venda em aberto além da atual.
            </div>
          ) : (
            list.map((s) => (
              <div key={s.id} className="border rounded p-2 flex items-center gap-2 hover:bg-slate-50">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-mono text-slate-500">
                    {s.id.slice(-6).toUpperCase()} ·{' '}
                    {new Date(s.createdAt).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                  <div className="font-bold text-emerald-700 tabular-nums">{brl(s.total)}</div>
                  {s.customerName && (
                    <div className="text-xs text-slate-600 truncate">{s.customerName}</div>
                  )}
                </div>
                <button
                  onClick={() => onResume(s.id)}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded flex items-center gap-1"
                >
                  Retomar
                  <ChevronRight className="w-3 h-3" />
                </button>
                <button
                  onClick={() => cancelOne(s.id)}
                  className="p-1.5 text-rose-600 hover:bg-rose-50 rounded"
                  title="Cancelar venda"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Logos das bandeiras (SVG inline) ──────────────────────────────────

function BandeiraLogo({ brand }: { brand: string }) {
  switch (brand) {
    case 'MASTERCARD':
      return (
        <svg viewBox="0 0 60 36" className="h-7" aria-label="Mastercard">
          <circle cx="22" cy="18" r="14" fill="#EB001B" />
          <circle cx="38" cy="18" r="14" fill="#F79E1B" />
          <path
            d="M30 8a14 14 0 0 0 0 20 14 14 0 0 0 0-20z"
            fill="#FF5F00"
          />
        </svg>
      );

    case 'VISANET':
    case 'VISA ELECTRON':
      return (
        <div className="flex flex-col items-center">
          <svg viewBox="0 0 80 26" className="h-6">
            <text
              x="40"
              y="22"
              textAnchor="middle"
              fontFamily="Arial Black, sans-serif"
              fontSize="22"
              fontWeight="900"
              fontStyle="italic"
              fill="#1A1F71"
            >
              VISA
            </text>
          </svg>
          {brand === 'VISA ELECTRON' && (
            <span className="text-[8px] font-bold tracking-wider text-[#1A1F71]">
              ELECTRON
            </span>
          )}
        </div>
      );

    case 'HIPERCARD':
      return (
        <svg viewBox="0 0 110 24" className="h-6" aria-label="Hipercard">
          <text
            x="55"
            y="20"
            textAnchor="middle"
            fontFamily="Arial Black, sans-serif"
            fontSize="18"
            fontWeight="900"
            fontStyle="italic"
            fill="#B3131B"
          >
            Hipercard
          </text>
        </svg>
      );

    case 'AMEX':
      return (
        <div className="bg-[#006FCF] rounded px-2 py-1 flex items-center justify-center min-w-[64px]">
          <span className="text-white font-black text-sm tracking-wide italic">
            AMEX
          </span>
        </div>
      );

    case 'ELO':
      return (
        <div className="flex items-center gap-0.5">
          <span
            className="inline-block w-3 h-3 rounded-full"
            style={{ background: '#FFCB05' }}
          />
          <span
            className="inline-block w-3 h-3 rounded-full -ml-1.5"
            style={{ background: '#00A4E0' }}
          />
          <span
            className="inline-block w-3 h-3 rounded-full -ml-1.5"
            style={{ background: '#EE3124' }}
          />
          <span className="font-black text-sm text-slate-800 ml-1 italic">
            elo
          </span>
        </div>
      );

    case 'REDESHOP':
      return (
        <svg viewBox="0 0 110 24" className="h-6" aria-label="Redeshop">
          <text
            x="55"
            y="20"
            textAnchor="middle"
            fontFamily="Arial Black, sans-serif"
            fontSize="16"
            fontWeight="900"
            fill="#CC092F"
          >
            REDESHOP
          </text>
        </svg>
      );

    default:
      return <span className="text-xs font-bold text-slate-700">{brand}</span>;
  }
}
