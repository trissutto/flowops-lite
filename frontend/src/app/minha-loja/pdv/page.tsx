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
import Image from 'next/image';
import {
  ArrowLeft, Loader2, X, Barcode, ArrowRight, Trash2, Plus, Minus,
  ShoppingCart, User, CreditCard, Banknote, QrCode, Check, AlertCircle,
  Send, Mail, MessageSquare, FileText, RotateCcw, History, Percent,
  Clock, ChevronRight, Pause, DollarSign, ArrowRightLeft, Search, Sparkles,
  Receipt, Globe, Shuffle,
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
  payments?: Array<{
    id: string;
    method: string;
    valor: number;
    details: string | null;
    createdAt: string;
  }>;
  nfceNumber: string | null;
  nfceChave: string | null;
  nfceXml: string | null;
  nfceStatus?: string | null;
  nfceMotivo?: string | null;
  nfceProtocolo?: string | null;
  nfceQrUrl?: string | null;
  nfceUrlConsulta?: string | null;
  nfceAutorizadaEm?: string | null;
  nfceCanceladaEm?: string | null;
  nfceCancelamentoMotivo?: string | null;
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

/**
 * Imprime um cupom em browser puro (sem Electron).
 *
 * Estratégia em 2 camadas:
 *   1) Cria iframe FORA DA TELA (left:-9999px) com tamanho real (300×600).
 *      Iframes 0×0 não renderizam, e o window.print() interno não dispara.
 *      Com tamanho real renderizado fora da viewport, o print funciona.
 *   2) Se o iframe falhar (popup blocker, navegação cross-origin), faz
 *      fallback pra window.open() popup pequeno e visível que se auto-fecha.
 *
 * A página do recibo já dispara window.print() sozinha no useEffect
 * e remove a janela com afterprint.
 */
function printViaHiddenIframe(url: string) {
  try {
    // Tentativa 1: iframe fora da tela (não bloqueia popup, não aparece visível)
    const iframe = document.createElement('iframe');
    iframe.style.cssText =
      'position:fixed;left:-9999px;top:0;width:300px;height:600px;border:0;';
    iframe.src = url;
    iframe.setAttribute('aria-hidden', 'true');

    // Detecta se o iframe carregou — se não, cai pro fallback popup
    let loaded = false;
    iframe.onload = () => {
      loaded = true;
    };

    document.body.appendChild(iframe);

    // Fallback: se em 4s o iframe não carregou, abre popup visível pequeno
    setTimeout(() => {
      if (!loaded) {
        try {
          iframe.remove();
        } catch {}
        const w = window.open(url, 'lurds_recibo', 'width=320,height=520,resizable=yes');
        if (!w) {
          alert('Popup bloqueado — habilite pop-ups nessa página pra imprimir cupom automático.');
        }
      }
    }, 4000);

    // Cleanup do iframe após 30s
    setTimeout(() => {
      try {
        iframe.remove();
      } catch {}
    }, 30000);
  } catch (e) {
    console.warn('printViaHiddenIframe falhou, tentando popup direto:', e);
    try {
      window.open(url, 'lurds_recibo', 'width=320,height=520,resizable=yes');
    } catch {}
  }
}

/**
 * Calcula parcelas com regra "centavos só na primeira":
 *   total = R$ 153,10, n = 3 → primeira: R$ 51,10 · demais: R$ 51,00 (×2)
 *
 * Regra:
 *   - Demais parcelas = floor(total / n) em REAIS (sem centavos)
 *   - Primeira parcela = total − demais × (n−1)  (absorve o resto)
 *
 * Quando parcela = 1, primeira = total e demais = 0.
 */
function calcularParcelas(total: number, n: number): {
  primeira: number;
  demais: number;
  qtdDemais: number;
} {
  if (n <= 1) return { primeira: total, demais: 0, qtdDemais: 0 };
  const demais = Math.floor(total / n); // em reais inteiros
  const primeira = Math.round((total - demais * (n - 1)) * 100) / 100;
  return { primeira, demais, qtdDemais: n - 1 };
}

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

  // Quando true, o filho (PaymentModal) confirmou PIX automaticamente via webhook/polling.
  // Após finalizeSale, em vez de mostrar a tela "Venda finalizada", o PDV
  // imprime + abre nova venda direto (fluxo full-auto pra caixa não travar).
  const autoFlowRef = useRef(false);

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
  const [showPixAvulso, setShowPixAvulso] = useState(false);
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

  // ── Badges de operação (pedidos site + realinhamento) ──
  // Polling leve a cada 30s pra alertar quando matriz manda algo novo.
  const [pedidosSitePending, setPedidosSitePending] = useState(0);
  const [realignPending, setRealignPending] = useState(0);
  useEffect(() => {
    let cancel = false;
    const load = async () => {
      try {
        const [picks, realigns] = await Promise.all([
          api<any[]>('/pick-orders/mine').catch(() => []),
          api<any[]>('/realignment/mine').catch(() => []),
        ]);
        if (cancel) return;
        setPedidosSitePending(Array.isArray(picks) ? picks.length : 0);
        setRealignPending(Array.isArray(realigns) ? realigns.length : 0);
      } catch { /* silencioso */ }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

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
  // Se paymentMethod vier vazio, usa modo SPLIT (pagamentos parciais já adicionados via addPayment)
  const finalizeSale = async (paymentMethod: string, paymentDetails?: any) => {
    if (!sale) return;
    setFinalizing(true);
    try {
      const body: any = {};
      if (paymentMethod) {
        body.paymentMethod = paymentMethod;
        body.paymentDetails = paymentDetails;
      }
      await api(
        `/pdv/sales/${sale.id}/finalize`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      setShowPayment(false);
      localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);

      // Em fluxo AUTO (PIX confirmado pelo Pagar.me), pula a tela de finalizada
      // — só imprime e abre próxima venda. Em fluxo MANUAL, mostra a tela.
      const wasAutoFlow = autoFlowRef.current;
      autoFlowRef.current = false;
      if (!wasAutoFlow) {
        setShowFinalized(true);
      }

      // ── Imprime cupom NÃO FISCAL SILENCIOSAMENTE ──
      // Estratégia:
      //   - Electron (loja com instalador): usa electronAPI.silentPrintUrl()
      //     → abre hidden window invisível no main process e imprime direto
      //       na térmica padrão. Vendedora não vê nada.
      //   - Browser puro: cria <iframe> oculto carregando o recibo. A tela
      //     do recibo dispara window.print() sozinha no useEffect → o browser
      //     imprime só o conteúdo do iframe. Mostra diálogo do SO mas não
      //     abre janela visível.
      try {
        const reciboPath = `/minha-loja/pdv/recibo/${sale.id}?autoprint=1`;
        const electron = (window as any).electronAPI;
        if (electron?.silentPrintUrl) {
          const absoluteUrl = window.location.origin + reciboPath;
          electron.silentPrintUrl(absoluteUrl).catch((e: any) => {
            console.warn('silentPrintUrl falhou, caindo pra iframe:', e);
            printViaHiddenIframe(reciboPath);
          });
        } else {
          printViaHiddenIframe(reciboPath);
        }
      } catch (printErr) {
        console.error('Falha ao imprimir recibo:', printErr);
      }

      // Em fluxo AUTO: depois de imprimir, abre próxima venda em ~1.5s
      // (tempo suficiente pro recibo carregar e disparar print() no iframe).
      if (wasAutoFlow) {
        setTimeout(() => {
          setSale(null);
          createNewSale();
        }, 1500);
      }
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setFinalizing(false);
    }
  };

  // Recarrega a venda quando pagamentos parciais mudam (pra atualizar o footer da tela principal se quiser)
  const onPaymentsChanged = async () => {
    if (!sale) return;
    try {
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
    } catch { /* noop */ }
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
    <div className="min-h-screen bg-gradient-to-br from-rose-50 via-pink-50 to-fuchsia-50 flex flex-col">
      {/* ╔══════════════════════════════════════════════════════════════╗
          ║  HEADER MODERNO — hero card com logo grande + ações         ║
          ╚══════════════════════════════════════════════════════════════╝ */}
      <header className="sticky top-0 z-20 bg-white/70 backdrop-blur-xl border-b border-rose-100/60 shadow-[0_2px_24px_-8px_rgba(244,63,94,0.15)]">
        {/* Linha 1 — logo grande + título + status */}
        <div className="max-w-3xl mx-auto px-4 pt-3 pb-2 flex items-center gap-3">
          <Link
            href="/minha-loja"
            className="text-rose-700 hover:text-rose-900 transition shrink-0 -ml-1"
            aria-label="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>

          {/* LOGO GRANDE — destaque visual */}
          <Link
            href="/minha-loja"
            className="flex items-center gap-3 shrink-0 group"
            title="Início"
          >
            <div className="relative w-16 h-16 transition-transform group-hover:scale-105">
              <div className="absolute inset-0 rounded-full bg-gradient-to-br from-rose-200/50 to-pink-300/50 blur-md" />
              <Image
                src="/lurds-logo.png"
                alt="Lurd's Plus Size"
                fill
                sizes="64px"
                className="object-contain relative drop-shadow-md"
                priority
              />
            </div>
          </Link>

          {/* Título + venda */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-black bg-gradient-to-r from-rose-700 via-pink-600 to-fuchsia-600 bg-clip-text text-transparent leading-tight tracking-tight">
                PDV
              </h1>
              {sale?.storeCode && (
                <span className="text-xs font-mono font-bold text-rose-700 bg-rose-100 px-2 py-0.5 rounded-full">
                  {sale.storeCode}
                </span>
              )}
            </div>
            <p className="text-[11px] text-rose-700/70 truncate font-semibold mt-0.5">
              {sale
                ? `Venda #${sale.id.slice(-6).toUpperCase()} · ${sale.items?.length || 0} item(ns) no carrinho`
                : 'Carregando…'}
            </p>
          </div>

          {/* Botão Cliente — pill compacta */}
          <button
            onClick={() => setShowCustomer(true)}
            disabled={!sale || sale.status !== 'open'}
            className={`text-xs px-3 py-2.5 rounded-full flex items-center gap-1.5 font-bold transition shadow-md disabled:opacity-50 ${
              sale?.customerCpf
                ? 'bg-gradient-to-br from-rose-500 to-pink-600 text-white shadow-rose-300/60'
                : 'bg-white hover:bg-rose-50 text-rose-700 border-2 border-rose-200 shadow-rose-100'
            }`}
            title="Identificar cliente"
          >
            <User className="w-4 h-4" />
            <span className="hidden sm:inline truncate max-w-[80px]">
              {sale?.customerCpf ? sale.customerName?.split(' ')[0] || 'Cliente' : 'Cliente'}
            </span>
          </button>
        </div>

        {/* Linha 2 — Atalhos rápidos (8 pílulas) */}
        <div className="max-w-4xl mx-auto px-4 pb-3 grid grid-cols-4 md:grid-cols-8 gap-2">
          <button
            type="button"
            onClick={() => setShowPixAvulso(true)}
            className="bg-gradient-to-br from-emerald-100 to-teal-200 hover:from-emerald-200 hover:to-teal-300 border border-emerald-300 text-emerald-900 rounded-2xl p-2.5 flex flex-col items-center gap-1 transition shadow-sm hover:shadow-md group"
            title="Cobrança PIX avulsa"
          >
            <div className="w-9 h-9 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-md group-hover:scale-110 transition-transform">
              <DollarSign className="w-5 h-5" />
            </div>
            <div className="text-center leading-tight">
              <div className="text-[11px] font-black uppercase tracking-wide">PIX</div>
              <div className="text-[9px] opacity-70 font-semibold">Avulso</div>
            </div>
          </button>
          <ShortcutPill
            href="/minha-loja/consultar"
            icon={<Search className="w-5 h-5" />}
            label="Consultar"
            sub="Estoque"
            gradient="from-sky-100 to-blue-200"
            border="border-sky-300"
            text="text-sky-800"
            iconBg="bg-sky-500"
          />
          <ShortcutPill
            href="/minha-loja/pdv/caixa"
            icon={<DollarSign className="w-5 h-5" />}
            label="Caixa"
            sub="Sangria · Z"
            gradient="from-emerald-100 to-green-200"
            border="border-emerald-300"
            text="text-emerald-800"
            iconBg="bg-emerald-500"
          />
          <ShortcutPill
            href="/minha-loja/pdv/recebimentos"
            icon={<Receipt className="w-5 h-5" />}
            label="Receber"
            sub="Crediário"
            gradient="from-rose-100 to-pink-200"
            border="border-rose-300"
            text="text-rose-900"
            iconBg="bg-rose-500"
          />
          <ShortcutPill
            href="/minha-loja/pdv/devolucao"
            icon={<ArrowRightLeft className="w-5 h-5" />}
            label="Trocar"
            sub="Devolução"
            gradient="from-amber-100 to-orange-200"
            border="border-amber-300"
            text="text-amber-900"
            iconBg="bg-amber-500"
          />
          <button
            type="button"
            onClick={() => setShowOpenList(true)}
            disabled={openCount === 0}
            className="relative bg-gradient-to-br from-violet-100 to-purple-200 hover:from-violet-200 hover:to-purple-300 border border-violet-300 text-violet-900 rounded-2xl p-2.5 flex flex-col items-center gap-1 transition shadow-sm hover:shadow-md disabled:opacity-40 disabled:cursor-not-allowed group"
            title={openCount > 0 ? `${openCount} venda(s) pausadas` : 'Nenhuma venda pausada'}
          >
            <div className="w-9 h-9 rounded-full bg-violet-500 text-white flex items-center justify-center shadow-md group-hover:scale-110 transition-transform">
              <Pause className="w-5 h-5" />
            </div>
            <div className="text-center leading-tight">
              <div className="text-[11px] font-black uppercase tracking-wide">Pausadas</div>
              <div className="text-[9px] opacity-70 font-semibold">Retomar</div>
            </div>
            {openCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-rose-600 text-white text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1 shadow-lg ring-2 ring-white animate-pulse">
                {openCount}
              </span>
            )}
          </button>

          {/* Pedido Site — separar pedido WC da loja */}
          <Link
            href="/minha-loja"
            className={`relative rounded-2xl p-2.5 flex flex-col items-center gap-1 transition shadow-sm hover:shadow-md group border ${
              pedidosSitePending > 0
                ? 'bg-gradient-to-br from-indigo-200 to-blue-300 border-indigo-400 text-indigo-900 ring-2 ring-indigo-300 animate-pulse'
                : 'bg-gradient-to-br from-indigo-100 to-blue-200 border-indigo-300 text-indigo-900'
            }`}
            title={pedidosSitePending > 0 ? `${pedidosSitePending} pedido(s) do site aguardando` : 'Pedidos do site'}
          >
            <div className="w-9 h-9 rounded-full bg-indigo-500 text-white flex items-center justify-center shadow-md group-hover:scale-110 transition-transform">
              <Globe className="w-5 h-5" />
            </div>
            <div className="text-center leading-tight">
              <div className="text-[11px] font-black uppercase tracking-wide">Pedido Site</div>
              <div className="text-[9px] opacity-70 font-semibold">Separar</div>
            </div>
            {pedidosSitePending > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-rose-600 text-white text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1 shadow-lg ring-2 ring-white">
                {pedidosSitePending}
              </span>
            )}
          </Link>

          {/* Realinhar — separar mercadoria pra outras lojas (realinhamento + reposição + venda certa) */}
          <Link
            href="/minha-loja/realinhamento"
            className={`relative rounded-2xl p-2.5 flex flex-col items-center gap-1 transition shadow-sm hover:shadow-md group border ${
              realignPending > 0
                ? 'bg-gradient-to-br from-fuchsia-200 to-purple-300 border-fuchsia-400 text-fuchsia-900 ring-2 ring-fuchsia-300 animate-pulse'
                : 'bg-gradient-to-br from-fuchsia-100 to-purple-200 border-fuchsia-300 text-fuchsia-900'
            }`}
            title={realignPending > 0 ? `${realignPending} item(s) pra outras lojas` : 'Separar mercadoria pra outras lojas'}
          >
            <div className="w-9 h-9 rounded-full bg-fuchsia-500 text-white flex items-center justify-center shadow-md group-hover:scale-110 transition-transform">
              <Shuffle className="w-5 h-5" />
            </div>
            <div className="text-center leading-tight">
              <div className="text-[11px] font-black uppercase tracking-wide">Realinhar</div>
              <div className="text-[9px] opacity-70 font-semibold">Outras lojas</div>
            </div>
            {realignPending > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-rose-600 text-white text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1 shadow-lg ring-2 ring-white">
                {realignPending}
              </span>
            )}
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full p-3 space-y-3 pb-32">
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 p-2 rounded text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Input bipagem — destaque rosa */}
        {sale?.status === 'open' && (
          <form
            onSubmit={handleScan}
            className="bg-white rounded-2xl border-2 border-rose-300 p-3 shadow-md ring-4 ring-rose-100/50"
          >
            <label className="text-xs uppercase font-bold text-rose-700 flex items-center gap-1.5 mb-2 tracking-wide">
              <Barcode className="w-3.5 h-3.5" />
              Bipe o produto
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="SKU ou EAN13"
                disabled={scanLoading}
                className="flex-1 px-4 py-3.5 text-xl font-mono font-bold border-2 border-rose-200 rounded-xl focus:outline-none focus:ring-4 focus:ring-rose-300 focus:border-rose-400 disabled:bg-slate-50 placeholder:text-rose-200 placeholder:font-normal"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                type="submit"
                disabled={!scanInput || scanLoading}
                className="px-5 py-3.5 bg-gradient-to-br from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 text-white font-bold rounded-xl flex items-center disabled:opacity-40 shadow-md shadow-rose-200 transition"
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
          saleId={sale.id}
          total={sale.total}
          storeCode={sale.storeCode}
          customerCpf={sale.customerCpf}
          customerName={sale.customerName}
          customerEmail={sale.customerEmail}
          finalizing={finalizing}
          initialPayments={sale.payments || []}
          onClose={() => setShowPayment(false)}
          onConfirm={finalizeSale}
          onLater={fecharDepois}
          onPaymentsChange={onPaymentsChanged}
          onAutoFlowTriggered={() => { autoFlowRef.current = true; }}
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

      {/* Modal PIX Rápido (cobrança avulsa) */}
      {showPixAvulso && (
        <PixAvulsoModal
          saleId={sale?.id || null}
          defaultValor={sale?.total && sale.total > 0 ? sale.total : null}
          onClose={() => setShowPixAvulso(false)}
        />
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
  saleId,
  total,
  storeCode,
  customerCpf,
  customerName,
  customerEmail,
  finalizing,
  initialPayments,
  onClose,
  onConfirm,
  onLater,
  onPaymentsChange,
  onAutoFlowTriggered,
}: {
  saleId: string;
  total: number;
  storeCode?: string;
  customerCpf: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  finalizing: boolean;
  initialPayments?: Array<{ id: string; method: string; valor: number; details: string | null }>;
  onClose: () => void;
  onConfirm: (method: string, details?: any) => void;
  onLater: () => void;
  onPaymentsChange?: () => void;
  /** Sinaliza pro parent que entrou em fluxo automático (PIX confirmado) */
  onAutoFlowTriggered?: () => void;
}) {
  // Lista de pagamentos parciais já adicionados
  const [payments, setPayments] = useState(initialPayments || []);
  const jaPago = payments.reduce((s, p) => s + p.valor, 0);
  const restante = Math.max(0, Math.round((total - jaPago) * 100) / 100);
  const pago100 = restante < 0.01;
  const [selected, setSelected] = useState<string | null>(null);
  const [bandeira, setBandeira] = useState<string | null>(null);
  const [parcelas, setParcelas] = useState(1);
  const [recebido, setRecebido] = useState('');
  // Valor que vai cobrir essa forma de pagamento (default = restante)
  const [valorParcial, setValorParcial] = useState('');
  const [addingPayment, setAddingPayment] = useState(false);

  // Quando muda o restante, sugere preencher o valor parcial
  useEffect(() => {
    if (restante > 0 && selected && !valorParcial) {
      setValorParcial(restante.toFixed(2).replace('.', ','));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  // PIX state — providers possíveis: pagarme (preferido), pagbank, local
  const [pixCharge, setPixCharge] = useState<{
    txid: string;
    chave: string;
    payload: string;
    qrCodeDataUrl: string;
    provider?: 'pagarme' | 'pagbank' | 'local';
    pagbankOrderId?: string;
    pagarmeOrderId?: string;
    expiresAt?: string;
  } | null>(null);
  const [pixLoading, setPixLoading] = useState(false);
  const [pixPaid, setPixPaid] = useState(false);  // setado quando PagBank webhook confirma
  const [pixFallbackReason, setPixFallbackReason] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState(false);

  // ── Adicionar pagamento parcial ──
  const adicionarPagamento = async () => {
    if (!selected) return;
    const valor = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.'));
    if (isNaN(valor) || valor <= 0) {
      alert('Valor inválido');
      return;
    }
    if (valor > restante + 0.01) {
      alert(`Valor maior que o restante (${brl(restante)})`);
      return;
    }
    if (selected === 'crediario' && !customerCpf) {
      alert('Crediário exige CPF do cliente');
      return;
    }
    if (needsBandeira && !bandeira) {
      alert('Escolha a bandeira');
      return;
    }
    if (selected === 'pix' && !pixCharge) {
      alert('Aguarde o QR PIX ser gerado');
      return;
    }
    if (selected === 'dinheiro' && recebidoNum > 0 && recebidoNum < valor) {
      alert(`Recebido (${brl(recebidoNum)}) menor que o valor parcial (${brl(valor)})`);
      return;
    }

    const details: any = {};
    if (selected === 'credito' || selected === 'crediario') {
      details.parcelas = parcelas;
      const calc = calcularParcelas(valor, parcelas);
      details.valorPrimeira = calc.primeira;
      details.valorDemais = calc.demais;
      details.qtdDemais = calc.qtdDemais;
    }
    if (selected === 'dinheiro') {
      const trocoP = recebidoNum > valor ? recebidoNum - valor : 0;
      details.recebido = recebidoNum || valor;
      details.troco = trocoP;
    }
    if (selected === 'pix' && pixCharge) {
      details.pixTxid = pixCharge.txid;
      details.pixChave = pixCharge.chave;
    }
    if (needsBandeira) details.bandeira = bandeira;

    setAddingPayment(true);
    try {
      const newPayment = await api<any>(`/pdv/sales/${saleId}/payments`, {
        method: 'POST',
        body: JSON.stringify({ method: selected, valor, details }),
      });
      setPayments((prev) => [...prev, newPayment]);
      // Reset form pra próximo pagamento
      setSelected(null);
      setBandeira(null);
      setParcelas(1);
      setRecebido('');
      setValorParcial('');
      setPixCharge(null);
      onPaymentsChange?.();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setAddingPayment(false);
    }
  };

  const removerPagamento = async (paymentId: string) => {
    if (!window.confirm('Remover essa forma de pagamento?')) return;
    try {
      await api(`/pdv/sales/${saleId}/payments/${paymentId}`, { method: 'DELETE' });
      setPayments((prev) => prev.filter((p) => p.id !== paymentId));
      onPaymentsChange?.();
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // Quando seleciona PIX, tenta gerar via PagBank primeiro.
  // Se PagBank desabilitado/quebrado, fallback no PIX local (chave pessoal celular).
  // Em PagBank, o webhook confirma sozinho e a vendedora não precisa apertar nada —
  // o polling abaixo detecta o status=paid e finaliza automático.
  const generatePix = async (pixValor?: number) => {
    setPixLoading(true);
    setPixPaid(false);
    setPixFallbackReason(null);
    try {
      const valor = pixValor && pixValor > 0 ? pixValor : total;
      const customerPayload = {
        saleId,
        valor,
        storeCode,
        customerName: customerName || undefined,
        customerCpf: customerCpf || undefined,
        customerEmail: customerEmail || undefined,
        expiresInMinutes: 15,
      };

      // Coleta motivos de falha de cada provider pra debug se cair no local
      const failures: string[] = [];

      // 1) Tenta Pagar.me primeiro (provider preferido)
      try {
        const pm = await api<{
          pagarmeOrderId: string;
          qrCodeText: string;
          qrCodeImageUrl: string;
          expiresAt: string;
          valor: number;
        }>('/pagarme/pix/create', {
          method: 'POST',
          body: JSON.stringify(customerPayload),
        });
        setPixCharge({
          txid: pm.pagarmeOrderId,
          chave: 'Pagar.me',
          payload: pm.qrCodeText,
          qrCodeDataUrl: pm.qrCodeImageUrl || '',
          provider: 'pagarme',
          pagarmeOrderId: pm.pagarmeOrderId,
          expiresAt: pm.expiresAt,
        });
        return;
      } catch (e: any) {
        const msg = String(e?.message || e);
        const status = e?.status || e?.response?.status;
        let reason = '';
        if (status === 404 || /Cannot (POST|GET).*pagarme/i.test(msg))
          reason = 'backend antigo (deploy pendente)';
        else if (/desabilitado/i.test(msg)) reason = 'desligado';
        else if (/não configurado|API Key/i.test(msg)) reason = 'sem key';
        else reason = msg.slice(0, 80);
        failures.push(`Pagar.me: ${reason}`);
        console.warn('[pdv] Pagar.me PIX falhou:', msg);
      }

      // 2) Tenta PagBank (segundo provider)
      try {
        const pb = await api<{
          pagbankOrderId: string;
          qrCodeText: string;
          qrCodeImageB64: string;
          expiresAt: string;
          valor: number;
        }>('/pagbank/pix/create', {
          method: 'POST',
          body: JSON.stringify(customerPayload),
        });
        setPixCharge({
          txid: pb.pagbankOrderId,
          chave: 'PagBank',
          payload: pb.qrCodeText,
          qrCodeDataUrl: pb.qrCodeImageB64
            ? `data:image/png;base64,${pb.qrCodeImageB64}`
            : '',
          provider: 'pagbank',
          pagbankOrderId: pb.pagbankOrderId,
          expiresAt: pb.expiresAt,
        });
        return;
      } catch (e: any) {
        const msg = String(e?.message || e);
        let reason = '';
        if (/desabilitado/i.test(msg)) reason = 'desligado';
        else if (/não configurado|Token/i.test(msg)) reason = 'sem token';
        else reason = msg.slice(0, 80);
        failures.push(`PagBank: ${reason}`);
        console.warn('[pdv] PagBank PIX falhou:', msg);
      }

      // Se chegou aqui, ambos providers falharam
      setPixFallbackReason(failures.join(' · '));

      // 3) Fallback final: PIX local (chave celular)
      const r = await api<any>(`/pdv/sales/${saleId}/pix-charge`, { method: 'POST' });
      setPixCharge({ ...r, provider: 'local' });
    } catch (e: any) {
      alert(`Erro ao gerar PIX: ${e?.message}`);
    } finally {
      setPixLoading(false);
    }
  };

  // ── POLLING (Pagar.me ou PagBank) ──
  // Quando PIX foi gerado via provider externo, faz polling a cada 1s
  // (era 3s — reduzido pra UX no caixa: confirmação <1.5s após pagamento).
  // Webhook → marca paid no banco + backend Pagar.me consulta ao vivo
  // como fallback → polling pega → setPixPaid(true).
  useEffect(() => {
    if (!pixCharge || pixPaid) return;
    if (pixCharge.provider !== 'pagarme' && pixCharge.provider !== 'pagbank') return;

    const endpoint =
      pixCharge.provider === 'pagarme'
        ? `/pagarme/pix/status/${saleId}`
        : `/pagbank/pix/status/${saleId}`;

    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api<{ status: string; isPaid?: boolean }>(endpoint);
        if (cancelled) return;
        if (r.status === 'paid') setPixPaid(true);
      } catch {
        // silencioso
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pixCharge, pixPaid, saleId]);

  const copyPix = async () => {
    if (!pixCharge) return;
    try {
      await navigator.clipboard.writeText(pixCharge.payload);
      setCopyMsg(true);
      setTimeout(() => setCopyMsg(false), 2000);
    } catch {
      alert('Não consegui copiar — selecione e copie manualmente');
    }
  };

  // ── AUTO-FLUXO PIX: webhook/polling confirma → adiciona pagamento → finaliza venda ──
  //
  // 3 useEffects encadeados:
  //   1) pixPaid=true        → marca autoAdd e chama adicionarPagamento + sinaliza parent
  //   2) autoAdd + pago100   → chama onConfirm('') (finaliza)
  //   3) reset quando pix cancelado/método trocado
  //
  // Resultado: vendedora não clica em NADA depois que cliente paga.
  // Cupom imprime + PDV abre próxima venda automaticamente.
  const autoAddRef = useRef(false);
  const autoFinalizeRef = useRef(false);

  useEffect(() => {
    if (!pixPaid) {
      autoAddRef.current = false;
      autoFinalizeRef.current = false;
      return;
    }
    if (autoAddRef.current) return;
    if (selected !== 'pix' || !pixCharge) return;
    if (addingPayment) return;
    autoAddRef.current = true;
    // Sinaliza o parent que entramos em fluxo full-auto (parent vai pular tela
    // de "Venda finalizada" e abrir nova venda direto).
    onAutoFlowTriggered?.();
    // Pequeno delay pro toast "✓ Pagamento confirmado" aparecer antes do add
    const t = setTimeout(() => {
      adicionarPagamento();
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixPaid, selected, pixCharge]);

  // Auto-finaliza quando o auto-add do PIX zerou o restante.
  useEffect(() => {
    if (!autoAddRef.current) return;
    if (autoFinalizeRef.current) return;
    if (!pago100) return;
    if (finalizing || addingPayment) return;
    autoFinalizeRef.current = true;
    const t = setTimeout(() => {
      onConfirm('', undefined);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pago100, finalizing, addingPayment]);

  const recebidoNum = Number((recebido || '0').replace(/\./g, '').replace(',', '.'));
  const troco = selected === 'dinheiro' && recebidoNum > total ? recebidoNum - total : 0;

  // Reset bandeira ao trocar de método
  const selectMethod = (id: string) => {
    setSelected(id);
    setBandeira(null);
    setParcelas(1);
    setPixCharge(null);
    setPixPaid(false);
    if (id === 'pix') {
      generatePix();
    }
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
    if (selected === 'credito' || selected === 'crediario') {
      details.parcelas = parcelas;
      const calc = calcularParcelas(total, parcelas);
      details.valorPrimeira = calc.primeira;
      details.valorDemais = calc.demais;
      details.qtdDemais = calc.qtdDemais;
    }
    if (selected === 'dinheiro') {
      details.recebido = recebidoNum;
      details.troco = troco;
    }
    if (selected === 'pix' && pixCharge) {
      details.pixTxid = pixCharge.txid;
      details.pixChave = pixCharge.chave;
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

        {/* Cabeçalho: total + pago + restante */}
        <div className="bg-emerald-50 rounded p-2 space-y-1">
          <div className="flex justify-between text-xs text-slate-600">
            <span>Total da venda</span>
            <span className="tabular-nums">{brl(total)}</span>
          </div>
          {payments.length > 0 && (
            <div className="flex justify-between text-xs text-emerald-700">
              <span>Já pago</span>
              <span className="tabular-nums">−{brl(jaPago)}</span>
            </div>
          )}
          <div className="border-t border-emerald-200 pt-1 flex justify-between items-baseline">
            <span className="text-xs uppercase font-semibold text-slate-700">
              {pago100 ? 'Pago 100%' : 'Restante'}
            </span>
            <span
              className={`text-2xl font-bold tabular-nums ${
                pago100 ? 'text-emerald-600' : 'text-rose-700'
              }`}
            >
              {pago100 ? '✓' : brl(restante)}
            </span>
          </div>
        </div>

        {/* Lista de pagamentos parciais já adicionados */}
        {payments.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase font-semibold text-slate-500">
              Pagamentos ({payments.length})
            </div>
            {payments.map((p) => {
              const det = p.details ? JSON.parse(p.details) : {};
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-2 bg-slate-50 border rounded px-2 py-1.5"
                >
                  <span className="text-xs font-bold uppercase text-slate-700">
                    {p.method === 'MULTIPLO' ? 'Múltiplo' : p.method}
                  </span>
                  {det.bandeira && (
                    <span className="text-[10px] text-slate-500">
                      {det.bandeira}
                    </span>
                  )}
                  {det.parcelas > 1 && (
                    <span className="text-[10px] text-slate-500">
                      {det.parcelas}×
                    </span>
                  )}
                  <span className="ml-auto font-bold text-emerald-700 tabular-nums">
                    {brl(p.valor)}
                  </span>
                  <button
                    onClick={() => removerPagamento(p.id)}
                    className="text-rose-500 hover:bg-rose-50 p-1 rounded"
                    title="Remover"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Métodos só aparecem quando ainda há restante a pagar */}
        {!pago100 && (
          <>
            <div className="text-[10px] uppercase font-semibold text-slate-500">
              Adicionar forma de pagamento
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

            {/* Input de valor parcial — quanto vai cobrir nessa forma */}
            {selected && (
              <div className="space-y-1 pt-2">
                <label className="text-xs text-slate-600 uppercase font-semibold">
                  Valor pago nessa forma
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={valorParcial}
                    onChange={(e) => setValorParcial(e.target.value)}
                    placeholder={restante.toFixed(2).replace('.', ',')}
                    className="flex-1 border rounded px-3 py-2 text-base font-mono"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setValorParcial(restante.toFixed(2).replace('.', ','))
                    }
                    className="px-2 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded font-bold text-slate-700"
                    title="Preencher com o restante"
                  >
                    = restante
                  </button>
                </div>
              </div>
            )}
          </>
        )}

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
            {/* Simulador com regra "centavos só na primeira" */}
            {(() => {
              const calc = calcularParcelas(total, parcelas);
              if (parcelas === 1) {
                return (
                  <div className="text-center bg-emerald-50 rounded py-2">
                    <span className="text-slate-600 text-sm">À vista </span>
                    <span className="font-bold text-emerald-700 text-lg">{brl(total)}</span>
                  </div>
                );
              }
              const parcelasIguais = calc.primeira === calc.demais;
              return (
                <div className="bg-emerald-50 rounded p-3 space-y-1.5">
                  {parcelasIguais ? (
                    <div className="text-center">
                      <span className="text-slate-600 text-sm">{parcelas}× de </span>
                      <span className="font-bold text-emerald-700 text-lg">{brl(calc.primeira)}</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-700">
                          <b>1ª</b> parcela
                          <span className="text-[10px] text-slate-500 ml-1">(com centavos)</span>
                        </span>
                        <span className="font-bold text-emerald-700 tabular-nums">
                          {brl(calc.primeira)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm border-t pt-1.5 border-emerald-200">
                        <span className="text-slate-700">
                          <b>{calc.qtdDemais}×</b> demais parcelas
                        </span>
                        <span className="font-bold text-emerald-700 tabular-nums">
                          {brl(calc.demais)}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="text-center text-[10px] text-slate-500 border-t pt-1 border-emerald-200">
                    Total: {brl(total)} · sem juros
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Painel PIX — QR Code com valor */}
        {selected === 'pix' && (
          <div className="space-y-2 pt-2 border-t">
            {pixLoading ? (
              <div className="text-center py-8">
                <Loader2 className="w-8 h-8 animate-spin inline-block text-emerald-600 mb-2" />
                <div className="text-sm text-slate-500">Gerando QR Code PIX...</div>
              </div>
            ) : pixCharge ? (
              <>
                {/* Badge identificando o provedor + status PagBank */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                      pixCharge.provider === 'pagarme'
                        ? 'bg-emerald-100 text-emerald-800'
                        : pixCharge.provider === 'pagbank'
                        ? 'bg-sky-100 text-sky-800'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {pixCharge.provider === 'pagarme'
                      ? '✓ Pagar.me'
                      : pixCharge.provider === 'pagbank'
                      ? '✓ PagBank'
                      : 'PIX direto'}
                  </span>
                  {pixCharge.provider === 'local' && pixFallbackReason && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-900">
                      ⚠ {pixFallbackReason}
                    </span>
                  )}
                  {(pixCharge.provider === 'pagarme' || pixCharge.provider === 'pagbank') && (
                    <span
                      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full flex items-center gap-1 ${
                        pixPaid
                          ? 'bg-emerald-600 text-white animate-pulse'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {pixPaid ? (
                        <>
                          <Check className="w-3 h-3" /> PAGO
                        </>
                      ) : (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" /> AGUARDANDO
                        </>
                      )}
                    </span>
                  )}
                </div>

                <div
                  className={`flex flex-col items-center rounded-lg p-3 transition ${
                    pixPaid ? 'bg-emerald-100 ring-4 ring-emerald-400' : 'bg-emerald-50'
                  }`}
                >
                  {pixCharge.qrCodeDataUrl && (
                    <img
                      src={pixCharge.qrCodeDataUrl}
                      alt="QR Code PIX"
                      className="w-48 h-48 sm:w-56 sm:h-56 bg-white rounded shadow"
                    />
                  )}
                  {pixCharge.provider === 'local' && (
                    <div className="text-[10px] text-slate-500 mt-1 font-mono">
                      Chave: {pixCharge.chave.replace(/\+55/, '')} (celular)
                    </div>
                  )}
                  {pixCharge.provider === 'pagbank' && pixCharge.expiresAt && (
                    <div className="text-[10px] text-slate-500 mt-1">
                      QR expira em{' '}
                      {new Date(pixCharge.expiresAt).toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={copyPix}
                  className="w-full px-3 py-2 bg-slate-100 hover:bg-slate-200 rounded font-mono text-xs flex items-center justify-center gap-2 transition-colors"
                >
                  {copyMsg ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-emerald-700 font-bold">Copiado!</span>
                    </>
                  ) : (
                    <>📋 Copiar PIX Copia e Cola</>
                  )}
                </button>

                {pixCharge.provider === 'pagarme' || pixCharge.provider === 'pagbank' ? (
                  pixPaid ? (
                    <div className="bg-emerald-100 border-2 border-emerald-400 rounded-lg p-3 text-sm text-emerald-900 font-bold text-center">
                      ✓ Pagamento confirmado pelo {pixCharge.provider === 'pagarme' ? 'Pagar.me' : 'PagBank'}! Pode adicionar abaixo.
                    </div>
                  ) : (
                    <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs text-emerald-900">
                      <b>✓ Confirmação automática:</b> assim que o cliente pagar, o {pixCharge.provider === 'pagarme' ? 'Pagar.me' : 'PagBank'} avisa
                      o sistema e a venda finaliza sozinha.
                    </div>
                  )
                ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-900">
                    <b>⚠ Confirmação manual:</b> aguarde o cliente pagar, confirme no app do banco
                    e clique em <b>"Recebi"</b> abaixo pra finalizar.
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        {/* Botão "Adicionar essa forma" — quando tem método selecionado E ainda falta pagar */}
        {selected && !pago100 && (
          <button
            onClick={adicionarPagamento}
            disabled={
              addingPayment ||
              !valorParcial ||
              (needsBandeira && !bandeira) ||
              (selected === 'pix' && !pixCharge) ||
              (selected === 'crediario' && !customerCpf)
            }
            className="w-full px-3 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded text-base disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {addingPayment ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            {selected === 'pix' ? 'Recebi o PIX — adicionar' : 'Adicionar essa forma'}
          </button>
        )}

        {/* Botão "Finalizar venda" — quando pago = total */}
        {pago100 && (
          <button
            onClick={() => onConfirm('', undefined)}
            disabled={finalizing}
            className="w-full px-3 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded text-base disabled:opacity-40 flex items-center justify-center gap-2 animate-pulse"
          >
            {finalizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-5 h-5" />}
            Finalizar venda
          </button>
        )}

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

function FinalizedModal({ sale: initialSale, onNew }: { sale: Sale; onNew: () => void }) {
  const [sale, setSale] = useState<Sale>(initialSale);
  const [emitting, setEmitting] = useState(false);
  const [emitError, setEmitError] = useState<string | null>(null);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelMotivo, setCancelMotivo] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const isAuthorized = sale.nfceStatus === 'authorized';
  const isCancelled = sale.nfceStatus === 'cancelled' || !!sale.nfceCanceladaEm;
  const isRejected = sale.nfceStatus === 'rejected' || sale.nfceStatus === 'error';

  // Calcula janela de cancelamento (30min)
  const minutosDesdeEmissao = sale.nfceAutorizadaEm
    ? (Date.now() - new Date(sale.nfceAutorizadaEm).getTime()) / 60000
    : 999;
  const podeCancelar = isAuthorized && !isCancelled && minutosDesdeEmissao <= 30;
  const minutosRestantes = Math.max(0, Math.floor(30 - minutosDesdeEmissao));

  async function emitirNfce() {
    setEmitting(true);
    setEmitError(null);
    try {
      const r = await api<any>(`/pdv/sales/${sale.id}/nfce`, { method: 'POST' });
      // Recarrega venda pra puxar status atualizado
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      if (r?.status === 'rejected' || r?.status === 'error') {
        setEmitError(r?.motivo || r?.error || 'NFC-e rejeitada pela SEFAZ');
      }
    } catch (e: any) {
      setEmitError(e?.message || String(e));
    } finally {
      setEmitting(false);
    }
  }

  async function cancelarNfce() {
    if (cancelMotivo.trim().length < 15) {
      setCancelError('Justificativa precisa ter no mínimo 15 caracteres');
      return;
    }
    setCancelling(true);
    setCancelError(null);
    try {
      const r = await api<any>(`/pdv/sales/${sale.id}/nfce/cancel`, {
        method: 'POST',
        body: JSON.stringify({ justificativa: cancelMotivo.trim() }),
      });
      if (r?.success) {
        const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
        setSale(fresh);
        setShowCancelForm(false);
        setCancelMotivo('');
      } else {
        setCancelError(r?.motivo || r?.error || 'Falha ao cancelar');
      }
    } catch (e: any) {
      setCancelError(e?.message || String(e));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg w-full max-w-md my-8 overflow-hidden">
        <div className="px-4 py-3 bg-emerald-50 border-b text-center">
          <Check className="w-10 h-10 mx-auto text-emerald-600 mb-1" />
          <h2 className="font-bold text-lg text-emerald-900">Venda Finalizada</h2>
          <p className="text-xs text-emerald-700">
            {brl(sale.total)} · {sale.paymentMethod?.toUpperCase() || 'SPLIT'}
          </p>
        </div>
        <div className="p-4 space-y-3">
          {/* ─── Status NFC-e ─── */}
          {!sale.nfceStatus && (
            <div className="bg-slate-50 border border-slate-200 rounded p-3 text-center text-sm text-slate-600">
              <FileText className="w-6 h-6 mx-auto mb-1 text-slate-400" />
              NFC-e ainda não emitida
            </div>
          )}

          {isAuthorized && !isCancelled && (
            <div className="bg-emerald-50 border-2 border-emerald-300 rounded p-3 space-y-1">
              <div className="flex items-center gap-2 font-bold text-emerald-900 text-sm">
                <Check className="w-4 h-4" /> NFC-e {sale.nfceNumber} AUTORIZADA
              </div>
              {sale.nfceProtocolo && (
                <div className="text-xs text-emerald-800 font-mono">
                  Protocolo: {sale.nfceProtocolo}
                </div>
              )}
              {sale.nfceChave && (
                <div className="text-[10px] text-emerald-700 break-all font-mono">
                  Chave: {sale.nfceChave}
                </div>
              )}
              {podeCancelar && (
                <div className="text-xs text-amber-700 mt-1">
                  ⏱ Pode cancelar por mais {minutosRestantes} min
                </div>
              )}
            </div>
          )}

          {isCancelled && (
            <div className="bg-red-50 border-2 border-red-300 rounded p-3 space-y-1">
              <div className="flex items-center gap-2 font-bold text-red-900 text-sm">
                <X className="w-4 h-4" /> NFC-e {sale.nfceNumber} CANCELADA
              </div>
              {sale.nfceCancelamentoMotivo && (
                <div className="text-xs text-red-800 italic">
                  Motivo: {sale.nfceCancelamentoMotivo}
                </div>
              )}
            </div>
          )}

          {isRejected && (
            <div className="bg-red-50 border-2 border-red-300 rounded p-3 space-y-1">
              <div className="flex items-center gap-2 font-bold text-red-900 text-sm">
                <X className="w-4 h-4" /> NFC-e REJEITADA
              </div>
              {sale.nfceMotivo && (
                <div className="text-xs text-red-800">{sale.nfceMotivo}</div>
              )}
            </div>
          )}

          {/* ─── Ações NFC-e ─── */}
          {!isAuthorized && !isCancelled && (
            <button
              onClick={emitirNfce}
              disabled={emitting}
              className="w-full px-3 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white font-bold rounded flex items-center justify-center gap-2 text-base"
            >
              <FileText className="w-5 h-5" />
              {emitting ? 'Transmitindo SEFAZ…' : '🧾 EMITIR NFC-e'}
            </button>
          )}

          {emitError && (
            <div className="bg-red-50 border border-red-300 rounded p-2 text-xs text-red-800">
              <strong>Falhou:</strong> {emitError}
            </div>
          )}

          {podeCancelar && !showCancelForm && (
            <button
              onClick={() => setShowCancelForm(true)}
              className="w-full px-3 py-2 border-2 border-red-300 text-red-700 hover:bg-red-50 rounded flex items-center justify-center gap-2 text-sm font-bold"
            >
              <X className="w-4 h-4" />
              🚫 CANCELAR NFC-e
            </button>
          )}

          {showCancelForm && (
            <div className="bg-red-50 border-2 border-red-300 rounded p-3 space-y-2">
              <div className="text-xs font-bold text-red-900 uppercase">
                Motivo do cancelamento (15-255 chars)
              </div>
              <textarea
                value={cancelMotivo}
                onChange={(e) => setCancelMotivo(e.target.value.slice(0, 255))}
                placeholder="Ex: Cliente desistiu da compra após emissão"
                rows={3}
                className="w-full border border-red-300 rounded p-2 text-sm"
              />
              <div className="text-[10px] text-red-700 text-right">
                {cancelMotivo.trim().length}/255 (mín 15)
              </div>
              {cancelError && (
                <div className="text-xs text-red-800 bg-red-100 rounded p-1.5">
                  {cancelError}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowCancelForm(false);
                    setCancelMotivo('');
                    setCancelError(null);
                  }}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded text-sm"
                >
                  Voltar
                </button>
                <button
                  onClick={cancelarNfce}
                  disabled={cancelling || cancelMotivo.trim().length < 15}
                  className="flex-1 px-3 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white font-bold rounded text-sm"
                >
                  {cancelling ? 'Cancelando…' : 'Confirmar Cancelamento'}
                </button>
              </div>
            </div>
          )}

          {/* ─── Mini cupom ─── */}
          <div className="bg-slate-50 border border-dashed rounded p-3 text-xs font-mono space-y-1">
            <div className="text-center text-[10px] text-slate-500">
              {sale.storeName}
            </div>
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
          </div>

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


// ── EMPTY CART DASHBOARD ──────────────────────────────────────────────
// Quando o carrinho está vazio, em vez de mostrar só "Carrinho vazio",
// exibe um dashboard bonito com atalhos grandes touch-friendly e dicas
// pra vendedora bater o olho e saber o que fazer.
function EmptyCartDashboard({ onPixAvulso }: { onPixAvulso: () => void }) {
  return (
    <div className="space-y-3">
      {/* Hero card — call to action principal */}
      <div className="relative overflow-hidden bg-gradient-to-br from-rose-500 via-pink-500 to-fuchsia-600 rounded-2xl p-5 shadow-xl shadow-rose-300/40">
        {/* Padrão decorativo */}
        <div className="absolute -right-10 -top-10 w-40 h-40 bg-white/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -left-8 -bottom-8 w-32 h-32 bg-white/10 rounded-full blur-2xl pointer-events-none" />
        <div className="relative flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-white/20 backdrop-blur flex items-center justify-center shrink-0 ring-2 ring-white/30">
            <Barcode className="w-9 h-9 text-white" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-white font-black text-xl leading-tight">Pronto pra vender</div>
            <div className="text-white/90 text-sm font-medium">
              Bipe um produto acima ou use os atalhos abaixo
            </div>
          </div>
        </div>
      </div>

      {/* Grid 2×2 de atalhos GRANDES touch-friendly */}
      <div className="grid grid-cols-2 gap-3">
        <BigQuickAction
          onClick={onPixAvulso}
          icon={<DollarSign className="w-8 h-8" strokeWidth={2.5} />}
          label="PIX RÁPIDO"
          sub="Cobrança avulsa"
          fromColor="from-emerald-500"
          toColor="to-teal-600"
          shadowColor="shadow-emerald-300/50"
        />
        <BigQuickActionLink
          href="/minha-loja/consultar"
          icon={<Search className="w-8 h-8" strokeWidth={2.5} />}
          label="CONSULTAR"
          sub="Estoque rede"
          fromColor="from-sky-500"
          toColor="to-blue-600"
          shadowColor="shadow-sky-300/50"
        />
        <BigQuickActionLink
          href="/minha-loja/pdv/recebimentos"
          icon={<Receipt className="w-8 h-8" strokeWidth={2.5} />}
          label="RECEBIMENTOS"
          sub="Crediário"
          fromColor="from-rose-500"
          toColor="to-pink-600"
          shadowColor="shadow-rose-300/50"
        />
        <BigQuickActionLink
          href="/minha-loja/pdv/caixa"
          icon={<DollarSign className="w-8 h-8" strokeWidth={2.5} />}
          label="CAIXA"
          sub="Sangria · Z"
          fromColor="from-amber-500"
          toColor="to-orange-600"
          shadowColor="shadow-amber-300/50"
        />
      </div>

      {/* Dica de fluxo */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center shrink-0">
          <Sparkles className="w-5 h-5" />
        </div>
        <div className="text-xs text-slate-600 leading-snug">
          <span className="font-bold text-slate-800">Dica:</span> também dá pra
          buscar pela <span className="font-mono font-bold">REF</span> ou{' '}
          <span className="font-mono font-bold">EAN</span> no campo acima — o
          sistema reconhece automaticamente.
        </div>
      </div>
    </div>
  );
}

function BigQuickAction({
  onClick, icon, label, sub, fromColor, toColor, shadowColor,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  sub: string;
  fromColor: string;
  toColor: string;
  shadowColor: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`bg-gradient-to-br ${fromColor} ${toColor} hover:brightness-110 active:brightness-95 text-white rounded-2xl p-4 flex flex-col items-start gap-2 transition shadow-lg ${shadowColor} hover:shadow-xl hover:-translate-y-0.5 ring-1 ring-white/20`}
    >
      <div className="w-12 h-12 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center">
        {icon}
      </div>
      <div className="text-left">
        <div className="text-base font-black uppercase tracking-tight leading-none">{label}</div>
        <div className="text-xs opacity-90 font-semibold mt-1">{sub}</div>
      </div>
    </button>
  );
}

function BigQuickActionLink({
  href, icon, label, sub, fromColor, toColor, shadowColor,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  sub: string;
  fromColor: string;
  toColor: string;
  shadowColor: string;
}) {
  return (
    <Link
      href={href}
      className={`bg-gradient-to-br ${fromColor} ${toColor} hover:brightness-110 active:brightness-95 text-white rounded-2xl p-4 flex flex-col items-start gap-2 transition shadow-lg ${shadowColor} hover:shadow-xl hover:-translate-y-0.5 ring-1 ring-white/20`}
    >
      <div className="w-12 h-12 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center">
        {icon}
      </div>
      <div className="text-left">
        <div className="text-base font-black uppercase tracking-tight leading-none">{label}</div>
        <div className="text-xs opacity-90 font-semibold mt-1">{sub}</div>
      </div>
    </Link>
  );
}

// ── PIX AVULSO MODAL ──────────────────────────────────────────────────
// Cobrança PIX sem precisar criar venda no PDV. Útil pra cobrar cliente
// avulso (entrada, sinal, etc). Usa o próprio endpoint pix-charge da
// venda atual — se não houver, mostra mensagem.
function PixAvulsoModal({
  saleId,
  defaultValor,
  onClose,
}: {
  saleId: string | null;
  defaultValor?: number | null;
  onClose: () => void;
}) {
  // Pré-popula com o total da venda atual (se houver itens) — evita digitar
  // valor errado. Format brasileiro: 23,90 (vírgula como separador decimal).
  const [valor, setValor] = useState(
    defaultValor && defaultValor > 0
      ? defaultValor.toFixed(2).replace('.', ',')
      : '',
  );
  const [loading, setLoading] = useState(false);
  const [qr, setQr] = useState<{ qrImage?: string; brcode?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function gerar() {
    setError(null);
    const v = Number(valor.replace(/\./g, '').replace(',', '.'));
    if (!v || v <= 0) {
      setError('Valor inválido');
      return;
    }
    if (!saleId) {
      setError('Crie uma venda primeiro pra usar o PIX (botão "Nova venda")');
      return;
    }
    setLoading(true);
    try {
      const r = await api<any>(`/pdv/sales/${saleId}/pix-charge`, { method: 'POST' });
      setQr({ qrImage: r?.qrImage, brcode: r?.brcode });
    } catch (e: any) {
      setError(e?.message || 'Falha ao gerar PIX');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-black text-lg text-emerald-700 flex items-center gap-2">
            <DollarSign className="w-5 h-5" /> PIX Rápido
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        {!qr && (
          <>
            <div>
              <label className="text-xs uppercase font-bold text-slate-600 mb-1 block">
                Valor (R$)
              </label>
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                placeholder="0,00"
                className="w-full px-4 py-4 text-3xl font-bold tabular-nums text-emerald-700 border-2 border-emerald-200 rounded-xl focus:outline-none focus:ring-4 focus:ring-emerald-300 focus:border-emerald-400"
              />
            </div>

            {error && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 p-2 rounded text-sm">
                {error}
              </div>
            )}

            <button
              onClick={gerar}
              disabled={loading || !valor}
              className="w-full px-4 py-4 bg-gradient-to-br from-emerald-500 to-teal-600 hover:brightness-110 disabled:opacity-40 text-white font-black rounded-xl text-base shadow-lg shadow-emerald-300/40 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <DollarSign className="w-5 h-5" />}
              Gerar QR Code
            </button>
          </>
        )}

        {qr && (
          <div className="text-center space-y-3">
            {qr.qrImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.qrImage} alt="QR PIX" className="w-56 h-56 mx-auto border rounded-lg" />
            )}
            {qr.brcode && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Copia e Cola</div>
                <div className="bg-slate-100 rounded-lg p-2 text-[10px] font-mono break-all">
                  {qr.brcode}
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(qr.brcode!);
                    alert('Copiado!');
                  }}
                  className="mt-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg"
                >
                  Copiar código PIX
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="w-full px-4 py-3 border border-slate-300 rounded-lg text-sm font-bold"
            >
              Fechar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── STATS BAR ──────────────────────────────────────────────────────────
// Linha compacta de métricas do dia: vendas finalizadas, total vendido,
// ticket médio. Sempre visível abaixo do header. Recarrega quando a
// venda muda (ex: pós-finalização aparece nova métrica em segundos).
function StatsBar({ storeCode, salesVersion }: { storeCode?: string; salesVersion?: string }) {
  const [stats, setStats] = useState<{ count: number; total: number; ticketMedio: number } | null>(null);
  useEffect(() => {
    if (!storeCode) return;
    let cancel = false;
    api<{ count: number; total: number; ticketMedio: number }>(
      `/pdv/stats/today?storeCode=${encodeURIComponent(storeCode)}`,
    )
      .then((d) => { if (!cancel) setStats(d); })
      .catch(() => { /* silencioso — não polui UI por stat não carregar */ });
    return () => { cancel = true; };
  }, [storeCode, salesVersion]);

  if (!storeCode) return null;
  return (
    <div className="max-w-3xl mx-auto px-4 pb-2">
      <div className="flex gap-2 text-[11px]">
        <div className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
            <Check className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] uppercase font-bold text-slate-500 leading-none">Vendas hoje</div>
            <div className="text-base font-black text-slate-900 leading-tight tabular-nums">
              {stats?.count ?? '—'}
            </div>
          </div>
        </div>
        <div className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
            <DollarSign className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] uppercase font-bold text-slate-500 leading-none">Total</div>
            <div className="text-base font-black text-rose-700 leading-tight tabular-nums truncate">
              {stats ? brl(stats.total) : '—'}
            </div>
          </div>
        </div>
        <div className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-1.5 flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center shrink-0">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] uppercase font-bold text-slate-500 leading-none">Ticket médio</div>
            <div className="text-base font-black text-violet-700 leading-tight tabular-nums truncate">
              {stats && stats.count > 0 ? brl(stats.ticketMedio) : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SHORTCUT PILL: atalho colorido grande do header do PDV ───────────
function ShortcutPill({
  href,
  icon,
  label,
  sub,
  gradient,
  border,
  text,
  iconBg,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  sub: string;
  gradient: string;
  border: string;
  text: string;
  iconBg: string;
}) {
  return (
    <Link
      href={href}
      className={`bg-gradient-to-br ${gradient} hover:brightness-105 border ${border} ${text} rounded-2xl p-2.5 flex flex-col items-center gap-1 transition shadow-sm hover:shadow-md group`}
    >
      <div className={`w-9 h-9 rounded-full ${iconBg} text-white flex items-center justify-center shadow-md group-hover:scale-110 transition-transform`}>
        {icon}
      </div>
      <div className="text-center leading-tight">
        <div className="text-[11px] font-black uppercase tracking-wide">{label}</div>
        <div className="text-[9px] opacity-70 font-semibold">{sub}</div>
      </div>
    </Link>
  );
}
