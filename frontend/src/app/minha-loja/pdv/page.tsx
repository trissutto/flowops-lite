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
  AlertTriangle,
  Send, Mail, MessageSquare, FileText, RotateCcw, History, Percent,
  Clock, ChevronRight, Pause, DollarSign, ArrowRightLeft, Search, Sparkles,
  Receipt, Globe, Shuffle, Tag, Wallet,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { PdvToastProvider, usePdvToast, humanizeError } from '@/components/PdvToast';
import { HUB_TONES, type HubTone } from '@/components/HubCard';

type Sale = {
  id: string;
  storeCode: string;
  storeName: string;
  vendedorName: string | null;
  sellerId: string | null;
  sellerName: string | null;
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
const BANDEIRAS_CREDITO = ['MASTERCARD', 'VISANET', 'CIELO', 'HIPERCARD', 'AMEX'] as const;

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
 * Calcula parcelas IGUAIS com ajuste só na ÚLTIMA pra bater o total:
 *   total = R$ 155,20, n = 9 → 8× R$ 17,24 + última R$ 17,28
 *   total = R$ 153,10, n = 3 → 2× R$ 51,03 + última R$ 51,04
 *   total = R$ 100,00, n = 4 → 4× R$ 25,00 (caso exato — todas iguais)
 *
 * Regra:
 *   - iguais = round(total / n) com 2 casas decimais (centavos)
 *   - ultima = total - iguais × (n − 1)  (absorve diferença pra fechar)
 *
 * Quando n = 1: iguais = total, qtdIguais = 0, ultima = 0 (não usada).
 */
function calcularParcelas(total: number, n: number): {
  iguais: number;
  ultima: number;
  qtdIguais: number;
} {
  if (n <= 1) return { iguais: total, ultima: 0, qtdIguais: 0 };
  const iguais = Math.round((total / n) * 100) / 100;
  const ultima = Math.round((total - iguais * (n - 1)) * 100) / 100;
  return { iguais, ultima, qtdIguais: n - 1 };
}

export default function PdvPage() {
  return (
    <PdvToastProvider>
      <PdvPageInner />
    </PdvToastProvider>
  );
}

function PdvPageInner() {
  const { toast } = usePdvToast();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeCode, setStoreCode] = useState<string>('');
  const [sale, setSale] = useState<Sale | null>(null);
  const [loadingSale, setLoadingSale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scanInput, setScanInput] = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [showCustomer, setShowCustomer] = useState(false);
  const [showVendedora, setShowVendedora] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  // Pré-seleção de método + bandeira (usado pelos atalhos MASTERCARD/VISANET/REDESHOP/VISA ELECTRON)
  const [presetMethod, setPresetMethod] = useState<string | null>(null);
  const [presetBandeira, setPresetBandeira] = useState<string | null>(null);
  // Filtro de formas de pagamento — quando vendedora clica num botão direto
  // (PIX/CARTÃO/CRED. da sidebar), o modal abre mostrando SÓ aquela categoria.
  // Quando clica em "Finalizar", abre TUDO.
  const [paymentFilter, setPaymentFilter] = useState<'all' | 'pix' | 'cartao' | 'crediario'>('all');
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
    if (!showCustomer && !showVendedora && !showPayment && !showFinalized) {
      inputRef.current?.focus();
    }
  }, [sale, showCustomer, showVendedora, showPayment, showFinalized]);

  // Auto-abrir modal de vendedora REMOVIDO — agora vendedora é escolhida
  // a qualquer momento clicando no botão do header (cascata inline).
  // Política antiga forçava modal ao iniciar venda; comportamento novo dá
  // liberdade pra vendedora atender e atribuir comissão depois.

  // Listener global: qualquer tecla redireciona pro input + atalhos PDV
  useEffect(() => {
    if (!sale || sale.status !== 'open') return;
    if (showCustomer || showPayment || showFinalized) return;
    const handler = (e: KeyboardEvent) => {
      // ── ATALHOS GLOBAIS (funcionam mesmo com input em foco) ──
      // F1 → foca o input de bipagem
      if (e.key === 'F1') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      // F2 → abre tela de desconto da venda inteira
      if (e.key === 'F2') {
        e.preventDefault();
        if (sale.items?.length > 0) {
          setShowDiscount({ kind: 'sale' });
        }
        return;
      }
      // F4 → finalizar venda (se carrinho tem itens)
      if (e.key === 'F4') {
        e.preventDefault();
        if (sale.items?.length > 0 && sale.total > 0) {
          setShowPayment(true);
        }
        return;
      }
      // ESC → cancelar venda só quando carrinho VAZIO (segurança)
      if (e.key === 'Escape') {
        if (sale.items?.length === 0) {
          // Carrinho vazio: ESC é atalho seguro pra "limpar/sair"
          // (não chama cancelSale aqui pra evitar perder venda em digitação)
        }
        return;
      }

      // ── Auto-focus em qualquer tecla quando NADA estiver focado ──
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
    // Atalho item manual: vendedora digita "0" → abre modal pra lançar
    // produto livre (descrição + valor) sem precisar achar no Giga.
    if (sku === '0') {
      setScanInput('');
      setShowManualItem(true);
      return;
    }
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
      // Feedback explícito quando aplica desconto manual
      if (patch.desconto != null) {
        const item = fresh.items.find((i) => i.id === itemId);
        if (item) {
          if (patch.desconto > 0) {
            toast('success', `Desconto aplicado · ${brl(item.desconto)}`, item.descricao || item.ref || item.sku);
          } else {
            toast('info', 'Desconto removido', item.descricao || item.ref || item.sku);
          }
        }
      }
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
    }
  };

  // ── Aplicar desconto na venda inteira (extra, soma com descontos de item) ──
  const setSaleDiscount = async (desconto: number) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({ desconto }),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      if (desconto > 0) {
        toast('success', `Desconto da venda · ${brl(desconto)}`, `Total: ${brl(fresh.total)}`);
      } else {
        toast('info', 'Desconto da venda removido', `Total: ${brl(fresh.total)}`);
      }
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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
  // ── Modal de Desconto (% ou R$) — pode ser pra venda inteira ou item ──
  const [showDiscount, setShowDiscount] = useState<
    | null
    | { kind: 'sale' }
    | { kind: 'item'; itemId: string; bruto: number; atual: number }
  >(null);
  // ── Modal Item Manual (digitar produto livre) ──
  const [showManualItem, setShowManualItem] = useState(false);
  // ── Modal Simulador de Parcelamento Cartão (mostra cliente quanto fica cada parcela) ──
  const [showSimular, setShowSimular] = useState(false);
  // ── Banner de campanha promocional (colapsado por padrão pra não poluir tela) ──
  const [promoExpanded, setPromoExpanded] = useState(false);
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
        toast('warning', 'Venda não está mais aberta', 'Pode ter sido finalizada ou cancelada');
        return;
      }
      setSale(s);
      try {
        localStorage.setItem(`lurds_pdv_sale_${storeCode}`, s.id);
      } catch { /* noop */ }
      setShowOpenList(false);
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
    }
  };

  const removeItem = async (itemId: string) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/items/${itemId}`, { method: 'DELETE' });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
    }
  };

  // ── Vendedora ──
  const saveVendedora = async (data: { codigo: string; nome: string }) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/vendedora`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      setShowVendedora(false);
      toast('success', 'Vendedora identificada', data.nome);
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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
      toast('success', 'Cliente identificado', data.name || data.cpf);
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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
      toast('info', 'Venda cancelada', 'Carrinho limpo — pronta pra próxima');
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header — fundo violet escuro com texto branco. Mesmo estilo do
          /minha-loja/realinhamento pra unificar identidade visual. */}
      <header className="sticky top-0 z-20 bg-gradient-to-r from-violet-800 via-violet-700 to-fuchsia-700 border-b border-violet-900/40 shadow-md">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/minha-loja"
            className="text-white/80 hover:text-white transition shrink-0"
            aria-label="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>

          {/* LOGO compacta */}
          <Link
            href="/minha-loja"
            className="flex items-center gap-2 shrink-0 group"
            title="Início"
          >
            <div className="relative w-11 h-11 bg-white/95 rounded-full p-1 shadow-md">
              <Image
                src="/lurds-logo.png"
                alt="Lurd's Plus Size"
                fill
                sizes="44px"
                className="object-contain"
                priority
              />
            </div>
          </Link>

          {/* Título + venda */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-black text-white leading-none tracking-tight drop-shadow">
                PDV
              </h1>
              {sale?.storeCode && (
                <span className="text-[11px] font-mono font-bold text-violet-900 bg-amber-300 px-2 py-0.5 rounded-md shadow-sm">
                  {sale.storeCode}
                </span>
              )}
            </div>
            <p className="text-[11px] text-white/85 truncate font-medium mt-0.5">
              {sale
                ? (() => {
                    const totalQty = (sale.items || []).reduce((s: number, it: any) => s + (Number(it.qty) || 0), 0);
                    return `Venda #${sale.id.slice(-6).toUpperCase()} · ${totalQty} ${totalQty === 1 ? 'peça' : 'peças'} no carrinho`;
                  })()
                : 'Carregando…'}
            </p>
          </div>

          {/* Botão Pausadas — vendas em aberto pra retomar (só aparece se tiver) */}
          {openCount > 0 && (
            <button
              onClick={() => setShowOpenList(true)}
              className="relative text-xs px-3 py-2.5 rounded-xl flex items-center gap-1.5 font-bold bg-amber-400 hover:bg-amber-300 text-amber-950 ring-2 ring-amber-200/50 shrink-0 shadow-md transition"
              title={`${openCount} venda(s) pausada(s)`}
            >
              <Pause className="w-4 h-4" />
              <span className="hidden sm:inline">Pausadas</span>
              <span className="bg-amber-600 text-white text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1.5">
                {openCount}
              </span>
            </button>
          )}

          {/* Botão Vendedora — quem está atendendo essa venda */}
          <button
            onClick={() => setShowVendedora(true)}
            disabled={!sale || sale.status !== 'open'}
            className={`text-xs px-3 py-2.5 rounded-xl flex items-center gap-1.5 font-bold transition disabled:opacity-50 shrink-0 shadow-md ${
              sale?.sellerName
                ? 'bg-emerald-400 hover:bg-emerald-300 text-emerald-950 ring-2 ring-emerald-200/50'
                : 'bg-white/90 hover:bg-white text-rose-700 ring-2 ring-rose-300/50 animate-pulse'
            }`}
            title={sale?.sellerName ? `Trocar vendedora (atual: ${sale.sellerName})` : 'Identificar vendedora'}
          >
            <Sparkles className="w-4 h-4" />
            <span className="hidden sm:inline truncate max-w-[100px]">
              {sale?.sellerName ? sale.sellerName.split(' ')[0] : 'Vendedora'}
            </span>
          </button>

          {/* Botão Cliente — destaca-se sobre o roxo do header */}
          <button
            onClick={() => setShowCustomer(true)}
            disabled={!sale || sale.status !== 'open'}
            className={`text-xs px-3 py-2.5 rounded-xl flex items-center gap-1.5 font-bold transition disabled:opacity-50 shrink-0 shadow-md ${
              sale?.customerCpf
                ? 'bg-amber-400 hover:bg-amber-300 text-violet-900 ring-2 ring-amber-200/50'
                : 'bg-white hover:bg-amber-50 text-violet-800'
            }`}
            title="Identificar cliente"
          >
            <User className="w-4 h-4" />
            <span className="hidden sm:inline truncate max-w-[100px]">
              {sale?.customerCpf ? sale.customerName?.split(' ')[0] || 'Cliente' : 'Identificar'}
            </span>
          </button>
        </div>
      </header>

      {/* CONTAINER PRINCIPAL: main (esquerda) + sidebar (direita) */}
      <div className="flex-1 max-w-7xl mx-auto w-full flex gap-4 px-4 pt-4 pb-44">

      <main className="flex-1 min-w-0 space-y-3">
        {error && (
          <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 p-3 rounded-xl text-sm flex items-start gap-2 shadow-sm">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-rose-600" />
            <div>
              <div className="font-bold">{error.includes('não encontrad') ? 'Produto não encontrado' : 'Algo deu errado'}</div>
              <div className="text-xs mt-0.5 text-rose-700">{error}</div>
            </div>
          </div>
        )}

        {/* Input bipagem — FULL-WIDTH (estilo mockup) com botão grande à direita */}
        {sale?.status === 'open' && (
          <>
          <form
            onSubmit={handleScan}
            className="bg-white rounded-2xl border border-slate-200 px-4 py-2.5 shadow-md flex items-center gap-3 w-full"
          >
            <Barcode className="w-5 h-5 text-slate-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              placeholder="Bipe ou digite SKU / nome do produto…"
              disabled={scanLoading}
              className="flex-1 min-w-0 px-2 py-2 text-lg font-bold border-0 focus:outline-none disabled:bg-slate-50 placeholder:text-slate-400 placeholder:font-normal text-slate-900"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={!scanInput || scanLoading}
              className="px-5 py-3 text-white font-bold rounded-xl flex items-center disabled:opacity-40 transition shrink-0 shadow-md"
              style={{ background: `linear-gradient(135deg, ${HUB_TONES.purple.from}, ${HUB_TONES.purple.to})` }}
            >
              {scanLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
            </button>
          </form>

          </>
        )}

        {/* Carrinho */}
        {loadingSale ? (
          <div className="text-center py-10 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin inline-block" />
          </div>
        ) : sale && sale.items?.length > 0 ? (
          <div className="bg-white rounded-lg border overflow-hidden">
            {/* Seletor de campanha — só aparece se TEM campanha ativa OU foi
                expandido explicitamente. Quando "Nenhuma", mostra só botão sutil
                pra ativar (não polui a tela quando não tá em uso). */}
            {(sale.activePromotion || promoExpanded) ? (
              <button
                type="button"
                onClick={() => setPromoExpanded((v) => !v)}
                className="w-full px-3 py-2 bg-fuchsia-50/50 border-b border-fuchsia-100 flex items-center justify-between gap-2 hover:bg-fuchsia-50 transition"
              >
                <div className="flex items-center gap-2 text-[11px] font-bold text-fuchsia-800">
                  <span>🎁</span>
                  <span className="uppercase tracking-wider">Campanha:</span>
                  <span className="font-black">
                    {sale.activePromotion === 'YEAR_BASED' ? 'Por ano' :
                     sale.activePromotion === 'FOUR_FOR_THREE' ? '4 LEVA 3' :
                     <span className="text-slate-500 font-medium">Nenhuma</span>}
                  </span>
                </div>
                <ChevronRight className={`w-3.5 h-3.5 text-fuchsia-700 transition-transform ${promoExpanded ? 'rotate-90' : ''}`} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setPromoExpanded(true)}
                className="w-full px-3 py-1.5 bg-slate-50 border-b border-slate-100 text-[10px] text-slate-500 hover:text-fuchsia-700 hover:bg-fuchsia-50/50 transition flex items-center justify-center gap-1.5"
              >
                🎁 <span>Aplicar campanha promocional</span>
              </button>
            )}
            {promoExpanded && (
            <div className="px-3 py-2 bg-fuchsia-50/30 border-b border-fuchsia-100">
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
            )}
            {/* Cabeçalho de colunas — agora com coluna de THUMBNAIL antes da DESC */}
            <div className="px-3 py-2 bg-slate-100 border-b border-slate-200 grid grid-cols-[80px_56px_1fr_80px_90px_110px_56px] gap-2 text-[10px] uppercase tracking-wider font-bold text-slate-600">
              <div>SKU</div>
              <div></div>
              <div>Produto</div>
              <div className="text-center">Qtd</div>
              <div className="text-right">R$ Unit</div>
              <div className="text-right">R$ Total</div>
              <div className="text-center">Ações</div>
            </div>
            <div className="px-3 py-1.5 bg-violet-50 border-b border-violet-100 text-[11px] text-violet-700 font-bold flex items-center gap-1.5">
              <ShoppingCart className="w-3 h-3" /> Itens da venda · {(() => { const t = sale.items.reduce((s: number, it: any) => s + (Number(it.qty) || 0), 0); return `${t} ${t === 1 ? 'peça' : 'peças'}`; })()}
            </div>
            <div className="divide-y">
              {sale.items.map((it) => {
                const bruto = it.precoUnit * it.qty;
                return (
                <div
                  key={it.id}
                  className="px-3 py-2 grid grid-cols-[80px_56px_1fr_80px_90px_110px_56px] gap-2 items-center hover:bg-violet-50/40 transition"
                >
                  {/* SKU/EAN */}
                  <div className="font-mono text-[11px] text-slate-700 truncate" title={it.ean || it.sku}>
                    {it.ean || it.sku}
                  </div>

                  {/* THUMBNAIL — busca foto do WooCommerce; fallback avatar */}
                  <ProductThumb sku={it.sku} refCode={it.ref} />

                  {/* DESCRIÇÃO — REF + COR/TAM + descrição em UMA LINHA, truncada */}
                  <div className="min-w-0 flex items-center gap-2">
                    <div className="font-mono text-xs text-slate-900 truncate flex-1 min-w-0">
                      <span className="font-bold">{it.ref || it.sku}</span>
                      {it.cor && <span className="ml-1.5 text-slate-500">{it.cor}</span>}
                      {it.tamanho && <span className="ml-1 text-slate-500">/{it.tamanho}</span>}
                      {it.descricao && (
                        <span className="ml-2 text-slate-500 font-sans font-normal">· {it.descricao}</span>
                      )}
                    </div>
                    {it.promoTag && (
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                          it.promoTag.includes('4 LEVA 3')
                            ? 'bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-300'
                            : it.promoTag === 'MANUAL'
                            ? 'bg-rose-100 text-rose-800 border border-rose-300'
                            : 'bg-amber-100 text-amber-800 border border-amber-300'
                        }`}
                        title={`Desconto: ${brl(it.desconto)}`}
                      >
                        {it.promoTag === 'MANUAL' ? '✏️ MANUAL' : `🎁 ${it.promoTag}`}
                      </span>
                    )}
                  </div>

                  {/* QTD — input editável direto, sem botões */}
                  <div className="flex items-center justify-center">
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={it.qty}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        if (!isNaN(n) && n >= 1 && n <= 99 && n !== it.qty) {
                          updateItem(it.id, { qty: n });
                        }
                      }}
                      disabled={sale.status !== 'open'}
                      className="w-14 h-9 text-center font-black tabular-nums text-base text-slate-900 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-300 focus:border-rose-400 disabled:bg-slate-50 disabled:opacity-60"
                    />
                  </div>

                  {/* VAL UNITÁRIO */}
                  <div className="text-right text-sm tabular-nums text-slate-700 font-semibold">
                    {brl(it.precoUnit)}
                  </div>

                  {/* VAL TOTAL — verde forte, fonte grande */}
                  <div className="text-right">
                    <div className="font-black text-emerald-700 tabular-nums text-base">{brl(it.total)}</div>
                    {it.desconto > 0 && (
                      <div className="text-[10px] text-slate-400 line-through tabular-nums">{brl(bruto)}</div>
                    )}
                  </div>

                  {/* AÇÕES — % desconto + 🗑 remover. Compactos pra não roubar espaço. */}
                  {sale.status === 'open' ? (
                    <div className="flex items-center justify-center gap-0.5">
                      <button
                        onClick={() =>
                          setShowDiscount({ kind: 'item', itemId: it.id, bruto, atual: it.desconto || 0 })
                        }
                        className={`w-6 h-6 rounded flex items-center justify-center transition active:scale-95 ${
                          it.desconto > 0 && it.promoTag === 'MANUAL'
                            ? 'bg-amber-500 text-white hover:bg-amber-600'
                            : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                        }`}
                        title={
                          it.desconto > 0 && it.promoTag === 'MANUAL'
                            ? `Desconto manual: ${brl(it.desconto)} (clique pra alterar)`
                            : 'Aplicar desconto neste item (% ou R$)'
                        }
                      >
                        <Percent className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => removeItem(it.id)}
                        className="w-6 h-6 rounded bg-rose-100 text-rose-700 hover:bg-rose-200 flex items-center justify-center transition active:scale-95"
                        title="Remover item"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ) : <div />}
                </div>
                );
              })}
            </div>
          </div>
        ) : sale?.status === 'open' ? (
          <div className="text-center py-16 px-6 bg-white rounded-2xl border-2 border-dashed border-slate-200">
            <div className="w-20 h-20 mx-auto rounded-full bg-rose-50 border-2 border-rose-200 flex items-center justify-center mb-4">
              <ShoppingCart className="w-10 h-10 text-rose-400" />
            </div>
            <div className="text-lg font-bold text-slate-700 mb-1">Carrinho vazio</div>
            <div className="text-sm text-slate-500">
              Bipe o primeiro produto pra começar a venda
            </div>
          </div>
        ) : null}
      </main>

      {/* SIDEBAR DIREITA — ações do PDV em modo COMPACT (linha única, w-52).
          Paleta reduzida: só rose/teal/sky/slate pra primárias.
          Secundárias usam outline branca pra não competir visualmente.
          Em mobile (<lg) vira faixa horizontal com scroll no topo. */}
      <aside className="w-60 shrink-0 hidden lg:flex flex-col gap-2 sticky top-20 self-start max-h-[calc(100vh-6rem)] overflow-y-auto pr-1">

        {/* ─── RESUMO DA VENDA ───────────────────────────────────────────── */}
        {sale?.status === 'open' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
            <div className="text-[10px] font-black uppercase tracking-wider text-violet-700 mb-2">
              Resumo da venda
            </div>
            <div className="space-y-1 text-xs">
              {(() => {
                const totalQty = (sale.items || []).reduce((s: number, it: any) => s + (Number(it.qty) || 0), 0);
                return (
                  <div className="flex justify-between items-center bg-violet-50 border-2 border-violet-300 rounded-lg px-3 py-2.5">
                    <span className="text-violet-700 uppercase text-xs font-black tracking-wide">Peças</span>
                    <span className="text-3xl font-black text-violet-700 tabular-nums">{totalQty}</span>
                  </div>
                );
              })()}
              <div className="flex justify-between items-center">
                <span className="text-slate-600 uppercase text-[10px] tracking-wide">Subtotal</span>
                <span className="font-bold text-slate-800 tabular-nums">{brl(sale.subtotal)}</span>
              </div>
              {(() => {
                const descontoItens = sale.items.reduce((s, i) => s + (i.desconto || 0), 0);
                const totalDesc = descontoItens + (sale.desconto || 0);
                if (totalDesc <= 0) return null;
                return (
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 uppercase text-[10px] tracking-wide">Descontos</span>
                    <span className="font-bold text-rose-600 tabular-nums">− {brl(totalDesc)}</span>
                  </div>
                );
              })()}
            </div>
            <div className="border-t border-dashed border-slate-300 mt-2 pt-2 flex justify-between items-baseline">
              <span className="text-[11px] font-black uppercase tracking-wider text-slate-700">Total</span>
              <span className="text-xl font-black text-emerald-600 tabular-nums">{brl(sale.total)}</span>
            </div>
          </div>
        )}

        {/* ALERTAS — Pausadas migrou pro header, Realinhar foi pra Ações do PDV */}

        {/* PAGAMENTOS migraram pra BARRA HORIZONTAL fixa acima do footer
           (procurar "PaymentBar — barra inferior" abaixo). Mantido aqui só
           o comentário pra não confundir quem busca por "Formas de pagamento". */}

        {/* ─── AÇÕES DO PDV ──────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
          <div className="text-[10px] font-black uppercase tracking-wider text-violet-700 mb-2">
            Ações do PDV
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Link
              href="/minha-loja/consultar"
              className="bg-white hover:bg-slate-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200"
            >
              <Search className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-[10px] font-bold text-slate-700">Consultar</span>
            </Link>
            <Link
              href="/minha-loja/pdv/devolucao"
              className="bg-white hover:bg-slate-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200"
            >
              <ArrowRightLeft className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-[10px] font-bold text-slate-700">Trocar</span>
            </Link>
            <Link
              href="/minha-loja/pdv/caixa"
              className="bg-white hover:bg-slate-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200"
            >
              <DollarSign className="w-3.5 h-3.5 text-slate-600" />
              <span className="text-[10px] font-bold text-slate-700">Caixa</span>
            </Link>
            <Link
              href="/minha-loja/pdv/fechamento"
              className="bg-white hover:bg-violet-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200 hover:border-violet-300"
              title="Fechamento diário com totais por forma de pgto"
            >
              <Wallet className="w-3.5 h-3.5 text-violet-600" />
              <span className="text-[10px] font-bold text-slate-700">Fechamento</span>
            </Link>
            <Link
              href="/minha-loja/pdv/recebimentos"
              className="bg-white hover:bg-rose-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200 hover:border-rose-300"
              title="Receber/baixar parcelas de crediário"
            >
              <Receipt className="w-3.5 h-3.5 text-rose-600" />
              <span className="text-[10px] font-bold text-slate-700 leading-tight text-center">Baixa Crediário</span>
            </Link>
            <button
              onClick={() => setShowSimular(true)}
              disabled={!sale?.total || sale.total <= 0}
              className="bg-white hover:bg-teal-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200 hover:border-teal-300 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <CreditCard className="w-3.5 h-3.5 text-teal-600" />
              <span className="text-[10px] font-bold text-slate-700">Simular</span>
            </button>
            <Link
              href="/minha-loja"
              className="relative bg-white hover:bg-violet-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200 hover:border-violet-300"
            >
              <Globe className="w-3.5 h-3.5 text-violet-600" />
              <span className="text-[10px] font-bold text-slate-700">Pedidos</span>
              {pedidosSitePending > 0 && (
                <span className="absolute -top-1.5 -right-1.5 bg-violet-600 text-white text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1.5">
                  {pedidosSitePending}
                </span>
              )}
            </Link>
            <Link
              href="/minha-loja/pdv/notas"
              className="bg-white hover:bg-blue-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200 hover:border-blue-300"
              title="NFC-es emitidas (cancelar/reimprimir)"
            >
              <FileText className="w-3.5 h-3.5 text-blue-600" />
              <span className="text-[10px] font-bold text-slate-700 leading-tight text-center">NFC-es</span>
            </Link>
            <Link
              href="/minha-loja/pdv/marcados"
              className="bg-white hover:bg-purple-50 rounded-lg py-2 px-1.5 flex flex-col items-center gap-1 transition border border-slate-200 hover:border-purple-300"
              title="Marcados (provar em casa) — clientes classe A"
            >
              <Tag className="w-3.5 h-3.5 text-purple-600" />
              <span className="text-[10px] font-bold text-slate-700 leading-tight text-center">Marcados</span>
            </Link>
          </div>

          {/* REALINHAR — botão wide abaixo do grid (linha separada, com badge) */}
          <Link
            href="/minha-loja/realinhamento"
            className={`mt-2 relative w-full rounded-lg py-2.5 px-3 flex items-center justify-between gap-2 transition border ${
              realignPending > 0
                ? 'bg-rose-50 hover:bg-rose-100 border-rose-300 text-rose-800'
                : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-700'
            }`}
            title="Realinhamento de estoque"
          >
            <span className="flex items-center gap-2 text-xs font-bold">
              <Shuffle className={`w-3.5 h-3.5 ${realignPending > 0 ? 'text-rose-600' : 'text-slate-500'}`} />
              Realinhar
            </span>
            {realignPending > 0 && (
              <span className="bg-rose-500 text-white text-[10px] font-black rounded-full min-w-[24px] h-[22px] flex items-center justify-center px-1.5">
                {realignPending}
              </span>
            )}
          </Link>
        </div>

      </aside>

      </div>{/* fim do flex main+sidebar */}

      {/* MOBILE BAR — em telas <lg, mostra ações em scroll horizontal acima do footer */}
      <div className="lg:hidden fixed bottom-[88px] left-0 right-0 z-10 px-3">
        <div className="max-w-4xl mx-auto bg-white/95 backdrop-blur border border-slate-200 rounded-2xl p-2 shadow-lg flex gap-2 overflow-x-auto">
          <PdvMobilePill tone="rose"   href="/minha-loja/pdv/recebimentos" icon={Receipt}    label="Crediário" />
          <PdvMobilePill tone="amber"  onClick={() => setShowSimular(true)} disabled={!sale?.total || sale.total <= 0} icon={CreditCard} label="Simular" />
          <PdvMobilePill tone="sky"    href="/minha-loja/consultar"        icon={Search}     label="Estoque" />
          <PdvMobilePill tone="purple" href="/minha-loja"                  icon={Globe}      label="Site" badge={pedidosSitePending} />
          <PdvMobilePill tone="green"  href="/minha-loja/pdv/caixa"        icon={DollarSign} label="Caixa" />
          <PdvMobilePill tone="orange" href="/minha-loja/pdv/devolucao"    icon={ArrowRightLeft} label="Trocar" />
          <PdvMobilePill tone="slate"  onClick={() => setShowOpenList(true)} disabled={openCount === 0} icon={Pause} label="Pausa" badge={openCount} />
          <PdvMobilePill tone="orange" href="/minha-loja/realinhamento"    icon={Shuffle}    label="Realin." badge={realignPending} />
        </div>
      </div>

      {/* ─── PaymentBar — barra inferior com 3 grupos de pagamento ─────────
         Posicionada fixed acima do footer principal. Aparece só quando a
         venda tem itens (>0) — evita poluir tela vazia. Cada botão dispara
         o PaymentModal já com método+bandeira preset (vai direto pra parcelas
         em crédito ou confirmação em débito; PIX/CREDIÁRIO/DINHEIRO abrem
         no modo certo). */}
      {sale?.status === 'open' && (sale.items?.length ?? 0) > 0 && (sale.total || 0) > 0 && (() => {
        const venderCredito = (band: string) => {
          setPresetMethod('credito');
          setPresetBandeira(band);
          setPaymentFilter('cartao');
          setShowPayment(true);
        };
        const venderDebito = (band: string) => {
          setPresetMethod('debito');
          setPresetBandeira(band);
          setPaymentFilter('cartao');
          setShowPayment(true);
        };
        const venderOutro = (m: string) => {
          if (m === 'pix') { setPaymentFilter('pix'); setShowPayment(true); return; }
          if (m === 'crediario') { setPaymentFilter('crediario'); setShowPayment(true); return; }
          if (m === 'dinheiro') { setPresetMethod('dinheiro'); setPaymentFilter('all'); setShowPayment(true); return; }
        };
        const PayBtn = ({
          onClick, brand, label, hoverColor,
        }: {
          onClick: () => void;
          brand?: string;
          label?: React.ReactNode;
          hoverColor: string;
        }) => (
          <button
            onClick={onClick}
            className={`bg-white rounded-lg px-2 py-1.5 flex items-center justify-center transition border border-slate-200 hover:shadow-md h-11 min-w-[60px] ${hoverColor}`}
            title={brand || (typeof label === 'string' ? label : '')}
          >
            {brand ? <BandeiraLogo brand={brand} /> : label}
          </button>
        );
        return (
          <div className="fixed bottom-[100px] sm:bottom-[88px] left-0 right-0 z-10 px-3 pointer-events-none">
            <div className="max-w-6xl mx-auto bg-white/95 backdrop-blur border border-slate-200 rounded-2xl shadow-xl p-2 pointer-events-auto flex items-stretch gap-2 overflow-x-auto">
              {/* GRUPO CRÉDITO */}
              <div className="flex flex-col gap-1 shrink-0">
                <span className="text-[9px] font-black uppercase tracking-wider text-violet-700 px-1">Crédito</span>
                <div className="flex gap-1.5">
                  <PayBtn onClick={() => venderCredito('MASTERCARD')} brand="MASTERCARD" hoverColor="hover:bg-orange-50 hover:border-orange-300" />
                  <PayBtn onClick={() => venderCredito('VISANET')}    brand="VISANET"    hoverColor="hover:bg-blue-50 hover:border-blue-300" />
                  <PayBtn onClick={() => venderCredito('CIELO')}      brand="CIELO"      hoverColor="hover:bg-cyan-50 hover:border-cyan-300" />
                  <PayBtn onClick={() => venderCredito('HIPERCARD')}  brand="HIPERCARD"  hoverColor="hover:bg-rose-50 hover:border-rose-300" />
                  <PayBtn onClick={() => venderCredito('AMEX')}       brand="AMEX"       hoverColor="hover:bg-blue-50 hover:border-blue-400" />
                </div>
              </div>

              <div className="w-px bg-slate-200 mx-0.5" />

              {/* GRUPO DÉBITO */}
              <div className="flex flex-col gap-1 shrink-0">
                <span className="text-[9px] font-black uppercase tracking-wider text-emerald-700 px-1">Débito</span>
                <div className="flex gap-1.5">
                  <PayBtn onClick={() => venderDebito('REDESHOP')}      brand="REDESHOP"      hoverColor="hover:bg-rose-50 hover:border-rose-300" />
                  <PayBtn onClick={() => venderDebito('VISA ELECTRON')} brand="VISA ELECTRON" hoverColor="hover:bg-blue-50 hover:border-blue-300" />
                  <PayBtn onClick={() => venderDebito('ELO')}           brand="ELO"           hoverColor="hover:bg-yellow-50 hover:border-yellow-400" />
                </div>
              </div>

              <div className="w-px bg-slate-200 mx-0.5" />

              {/* GRUPO OUTROS */}
              <div className="flex flex-col gap-1 shrink-0">
                <span className="text-[9px] font-black uppercase tracking-wider text-slate-600 px-1">Outros</span>
                <div className="flex gap-1.5">
                  <PayBtn
                    onClick={() => venderOutro('pix')}
                    label={
                      <span className="flex items-center gap-1">
                        <QrCode className="w-4 h-4 text-teal-600" />
                        <span className="text-xs font-black text-teal-700 tracking-wide">PIX</span>
                      </span>
                    }
                    hoverColor="hover:bg-teal-50 hover:border-teal-300"
                  />
                  <PayBtn
                    onClick={() => venderOutro('dinheiro')}
                    label={
                      <span className="flex items-center gap-1">
                        <Banknote className="w-4 h-4 text-emerald-600" />
                        <span className="text-xs font-black text-emerald-700 tracking-wide">DINHEIRO</span>
                      </span>
                    }
                    hoverColor="hover:bg-emerald-50 hover:border-emerald-300"
                  />
                  <PayBtn
                    onClick={() => venderOutro('crediario')}
                    label={
                      <span className="flex items-center gap-1">
                        <Receipt className="w-4 h-4 text-amber-600" />
                        <span className="text-xs font-black text-amber-700 tracking-wide">CREDIÁRIO</span>
                      </span>
                    }
                    hoverColor="hover:bg-amber-50 hover:border-amber-300"
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Footer fixo: TOTAL GIGANTE + Finalizar destaque máximo */}
      {sale?.status === 'open' && (
        <footer className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-slate-200 shadow-2xl z-10">
          <div className="max-w-4xl mx-auto px-4 py-3">
            {/* Linha de detalhamento: subtotal + economia agregada (descontos itens + sale.desconto extra) */}
            {(() => {
              const descontoItens = sale.items.reduce((s, i) => s + (i.desconto || 0), 0);
              const economiaTotal = descontoItens + (sale.desconto || 0);
              if (economiaTotal <= 0) return null;
              return (
                <div className="flex items-center justify-between gap-4 text-xs mb-2 px-1 pb-2 border-b border-slate-100">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-slate-500">
                      Subtotal <span className="tabular-nums font-semibold text-slate-700 ml-1">{brl(sale.subtotal)}</span>
                    </span>
                    <span className="text-emerald-700 font-bold flex items-center gap-1">
                      🎁 Economia <span className="tabular-nums">−{brl(economiaTotal)}</span>
                    </span>
                    {descontoItens > 0 && (sale.desconto || 0) > 0 && (
                      <span className="text-[10px] text-slate-400">
                        ({brl(descontoItens)} itens + {brl(sale.desconto)} venda)
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-slate-400">
                    {(() => { const t = sale.items.reduce((s: number, it: any) => s + (Number(it.qty) || 0), 0); return `${t} ${t === 1 ? 'peça' : 'peças'}`; })()}
                  </span>
                </div>
              );
            })()}

            {/* Linha principal: ações com LABEL + TOTAL grande + FINALIZAR GIGANTE */}
            <div className="flex items-center gap-3">
              {/* Cancelar venda — botão branco com LABEL */}
              <button
                onClick={cancelSale}
                className="px-4 py-3 bg-white hover:bg-rose-50 border-2 border-rose-300 text-rose-600 hover:text-rose-700 rounded-xl flex items-center gap-2 font-bold text-sm transition shrink-0 shadow-sm"
                title="Cancelar venda"
              >
                <X className="w-4 h-4" />
                <span className="hidden sm:inline">Cancelar venda</span>
              </button>

              {/* Desconto geral — botão branco com LABEL */}
              <button
                onClick={() => setShowDiscount({ kind: 'sale' })}
                className="px-4 py-3 bg-white hover:bg-amber-50 border-2 border-slate-200 hover:border-amber-300 text-slate-700 hover:text-amber-700 rounded-xl flex items-center gap-2 font-bold text-sm transition shrink-0 shadow-sm"
                title="Aplicar desconto na venda toda"
              >
                <Percent className="w-4 h-4" />
                <span className="hidden sm:inline">Desconto geral</span>
              </button>

              {/* TOTAL GIGANTE — destaque máximo, ocupa espaço central */}
              <div className="flex-1 px-2 min-w-0 text-center">
                <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold leading-none">Total a pagar</div>
                <div className="text-3xl sm:text-5xl font-black text-emerald-600 tabular-nums leading-none mt-1 truncate">
                  {brl(sale.total)}
                </div>
              </div>

              {/* PIX RÁPIDO — escondido em telas menores, mostra só em XL */}
              <button
                onClick={() => setShowPixAvulso(true)}
                disabled={!sale.items?.length || sale.total <= 0}
                className="hidden xl:flex px-3 py-3.5 text-white font-bold rounded-xl items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed text-sm transition shrink-0"
                style={{ background: `linear-gradient(135deg, ${HUB_TONES.teal.from}, ${HUB_TONES.teal.to})` }}
                title="Cobrar via PIX agora (Pagar.me/Stone)"
              >
                <DollarSign className="w-5 h-5" />
                <span>PIX</span>
              </button>

              {/* FINALIZAR — botão verde gigante (CTA primário) */}
              <button
                onClick={() => { setPaymentFilter('all'); setShowPayment(true); }}
                disabled={!sale.items?.length || sale.total <= 0}
                className="px-4 sm:px-6 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white font-black rounded-xl flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed text-base sm:text-lg shadow-md shadow-emerald-200 transition shrink-0"
                title="Finalizar venda"
              >
                <Check className="w-5 h-5" />
                <span className="hidden sm:inline">Finalizar</span>
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

      {/* Modal Vendedora */}
      {showVendedora && sale && (
        <VendedoraModal
          atual={sale.sellerName || ''}
          storeCode={sale.storeCode}
          onClose={() => setShowVendedora(false)}
          onSave={saveVendedora}
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
          methodFilter={paymentFilter}
          presetMethod={presetMethod}
          presetBandeira={presetBandeira}
          onClose={() => { setShowPayment(false); setPaymentFilter('all'); setPresetMethod(null); setPresetBandeira(null); }}
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

      {/* Modal Desconto — % ou R$ sincronizados, editável pra arredondar.
          Pra venda inteira: base = subtotal LÍQUIDO (já descontados itens) — porque
          o desconto da venda é EXTRA por cima dos descontos individuais.
          Pra item: base = bruto da linha (precoUnit × qty). */}
      {showDiscount && sale && (
        <DiscountModal
          base={
            showDiscount.kind === 'sale'
              ? sale.items.reduce((s, i) => s + i.total, 0)
              : showDiscount.bruto
          }
          atual={showDiscount.kind === 'sale' ? (sale.desconto || 0) : showDiscount.atual}
          label={showDiscount.kind === 'sale' ? 'extra da venda' : 'deste item'}
          onClose={() => setShowDiscount(null)}
          onApply={(valor) => {
            if (showDiscount.kind === 'sale') {
              setSaleDiscount(valor);
            } else {
              updateItem(showDiscount.itemId, { desconto: valor });
            }
            setShowDiscount(null);
          }}
        />
      )}

      {/* Modal Item Manual — digitado quando produto não passa */}
      {showManualItem && sale && (
        <ManualItemModal
          saleId={sale.id}
          onClose={() => setShowManualItem(false)}
          onAdded={async () => {
            const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
            setSale(fresh);
            setShowManualItem(false);
            toast('success', 'Item manual adicionado', 'Confira descrição e valor no carrinho');
            setTimeout(() => inputRef.current?.focus(), 50);
          }}
        />
      )}

      {/* Modal Simulador de Parcelamento Cartão */}
      {showSimular && sale && sale.total > 0 && (
        <SimularParcelasModal
          total={sale.total}
          onClose={() => setShowSimular(false)}
        />
      )}

      {/* Modal PIX Rápido (cobrança avulsa) */}
      {showPixAvulso && (
        <PixAvulsoModal
          saleId={sale?.id || null}
          defaultValor={sale?.total && sale.total > 0 ? sale.total : null}
          onClose={() => setShowPixAvulso(false)}
          onPaid={async ({ valor, txid }) => {
            // Pagar.me confirmou pagamento → registra como payment da venda
            // e auto-finaliza se cobrir o total. Se não, deixa parcial e a
            // vendedora finaliza manualmente depois.
            if (!sale?.id) return;
            try {
              await api(`/pdv/sales/${sale.id}/payments`, {
                method: 'POST',
                body: JSON.stringify({
                  method: 'pix',
                  valor,
                  details: { pixTxid: txid, pixChave: 'Pagar.me' },
                }),
              });
              const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
              setSale(fresh);
              const totalPago = (fresh.payments || []).reduce((s, p) => s + (p.valor || 0), 0);
              if (Math.abs(totalPago - fresh.total) < 0.01) {
                // Cobriu o total: dispara auto-flow (imprime + abre nova venda)
                autoFlowRef.current = true;
                finalizeSale('');
              } else {
                toast(
                  'info',
                  'Pagamento parcial registrado',
                  `Falta ${brl(Math.max(0, fresh.total - totalPago))} pra fechar`,
                );
              }
            } catch (e: any) {
              const h = humanizeError(e);
              toast('error', `Erro ao registrar pagamento: ${h.title}`, h.hint);
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// VendedoraModal — busca funcionária na tabela `funcionarios` do Giga.
// Aparece ao clicar no botão "Vendedora" do header (e idealmente automático
// ao abrir venda nova). Necessário pra atribuir comissão.
// ─────────────────────────────────────────────────────────────────────────
function VendedoraModal({
  atual,
  storeCode,
  onClose,
  onSave,
}: {
  atual: string;
  storeCode?: string;
  onClose: () => void;
  onSave: (d: { codigo: string; nome: string }) => void;
}) {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<Array<{ codigo: string; nome: string; loja?: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [tabelaOk, setTabelaOk] = useState<boolean | null>(null);
  const [lojaFiltered, setLojaFiltered] = useState(false);

  // Filtro por loja: passa o storeCode da venda atual pra trazer só
  // funcionários daquela loja. Se a tabela `funcionarios` não tiver coluna
  // de loja, o backend ignora o filtro e retorna todos.
  const lojaParam = storeCode ? `&loja=${encodeURIComponent(storeCode)}` : '';

  // Carrega lista inicial sem filtro de nome (top 20 da loja, por nome)
  useEffect(() => {
    (async () => {
      setSearching(true);
      try {
        const r = await api<{ results: typeof results; table?: string; lojaFiltered?: boolean }>(
          `/pdv/funcionarios-search?q=&limit=20${lojaParam}`,
        );
        setResults(r.results || []);
        setTabelaOk(r.results && r.results.length > 0);
        setLojaFiltered(!!r.lojaFiltered);
      } catch {
        setTabelaOk(false);
      } finally {
        setSearching(false);
      }
    })();
  }, [lojaParam]);

  // Refaz busca com debounce ao digitar
  useEffect(() => {
    if (searchTerm.length < 2 && searchTerm.length > 0) return;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api<{ results: typeof results; lojaFiltered?: boolean }>(
          `/pdv/funcionarios-search?q=${encodeURIComponent(searchTerm)}&limit=30${lojaParam}`,
        );
        setResults(r.results || []);
        setLojaFiltered(!!r.lojaFiltered);
      } catch {/* ignora */} finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchTerm, lojaParam]);

  return (
    <>
      {/* Backdrop transparente — fecha ao clicar fora */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* Cascata ancorada no canto superior direito (perto do botão Vendedora do header) */}
      <div
        className="fixed top-16 right-2 sm:right-4 z-50 bg-white border-2 border-emerald-300 rounded-xl shadow-2xl w-[min(92vw,420px)] p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2 text-emerald-900">
            <Sparkles className="w-4 h-4" /> Quem está atendendo?
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        {atual && (
          <div className="flex items-center gap-2 text-[11px] bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-1.5 rounded">
            <span className="flex-1"><strong>Atual:</strong> {atual}</span>
            <button
              type="button"
              onClick={() => onSave({ codigo: '', nome: '' })}
              className="px-2 py-0.5 bg-rose-100 hover:bg-rose-200 text-rose-700 rounded text-[10px] font-bold border border-rose-200"
              title="Remover vendedora atual"
            >
              ✕ Trocar
            </button>
          </div>
        )}

        {/* Indicador de filtro: "mostrando funcionárias da loja X" */}
        {storeCode && lojaFiltered && (
          <div className="text-[10px] text-violet-700 bg-violet-50 border border-violet-200 px-2 py-1 rounded flex items-center gap-1">
            <span className="font-bold">Loja {storeCode}</span>
            <span className="text-violet-500">·</span>
            <span>filtro ativo</span>
          </div>
        )}
        {storeCode && !lojaFiltered && tabelaOk && (
          <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded">
            ⚠ Tabela de funcionários sem coluna de loja — mostrando todos
          </div>
        )}

        <div className="flex items-center gap-2 border-2 border-emerald-300 bg-emerald-50 rounded px-2 py-2 focus-within:border-emerald-500">
          <Search className="w-4 h-4 text-emerald-600 shrink-0" />
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Nome da vendedora…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
            autoFocus
            autoComplete="off"
          />
          {searching && <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />}
        </div>

        {tabelaOk === false && (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            Tabela <code>funcionarios</code> não encontrada no Giga. Digite o nome manualmente embaixo.
          </div>
        )}

        <div className="max-h-80 overflow-y-auto p-1">
          {results.length === 0 && !searching && (
            <div className="text-center text-xs text-slate-400 py-6">
              {searchTerm ? 'Nenhuma vendedora encontrada' : 'Carregando…'}
            </div>
          )}
          {results.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {results.map((f) => {
                const isAtual = atual && atual.toUpperCase().includes(f.nome.toUpperCase());
                const primeiroNome = f.nome.split(/\s+/)[0];
                return (
                  <button
                    key={f.codigo + f.nome}
                    type="button"
                    onClick={() => onSave({ codigo: f.codigo, nome: f.nome })}
                    title={`${f.nome}${f.codigo ? ' · cód ' + f.codigo : ''}`}
                    className={`text-center px-2 py-2.5 rounded-lg transition border-2 active:scale-95 ${
                      isAtual
                        ? 'bg-emerald-500 border-emerald-600 text-white shadow-md ring-2 ring-emerald-300'
                        : 'bg-white hover:bg-emerald-50 border-slate-200 hover:border-emerald-400 text-slate-800'
                    }`}
                  >
                    <div className={`w-8 h-8 mx-auto mb-1 rounded-full flex items-center justify-center text-sm font-bold ${
                      isAtual ? 'bg-white/20' : 'bg-emerald-100 text-emerald-700'
                    }`}>
                      {primeiroNome.charAt(0).toUpperCase()}
                    </div>
                    <div className="text-[11px] font-bold truncate leading-tight">{primeiroNome}</div>
                    {f.codigo && (
                      <div className={`text-[9px] ${isAtual ? 'text-white/80' : 'text-slate-400'}`}>
                        cód {f.codigo}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Fallback manual — útil se a vendedora ainda não foi cadastrada no Giga */}
        {tabelaOk === false && (
          <button
            onClick={() => {
              const nome = searchTerm.trim();
              if (!nome) return;
              onSave({ codigo: '', nome });
            }}
            disabled={searchTerm.trim().length < 3}
            className="w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded text-sm disabled:opacity-40"
          >
            Usar &ldquo;{searchTerm.trim() || '...'}&rdquo; manualmente
          </button>
        )}
      </div>
    </>
  );
}

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

  // ─── Typeahead: busca por CPF OR nome no Giga ───────────────────────────
  // Aceita: dígitos parciais (CPF) ou texto (nome). Debounce de 300ms.
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<Array<{
    codCliente: string; nome: string; cpf: string; cidade: string; telefone: string;
  }>>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  useEffect(() => {
    const term = searchTerm.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api<{ results: typeof results }>(`/pdv/customer-search?q=${encodeURIComponent(term)}&limit=20`);
        setResults(r.results || []);
        setShowResults(true);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  function pickResult(c: { codCliente: string; nome: string; cpf: string; telefone: string }) {
    // CLICK NO RESULTADO = JÁ IDENTIFICA. Não precisa clicar em "Salvar" depois.
    // Se o cliente não tem CPF no Giga, ainda salva nome+telefone — mas avisa.
    if (!c.cpf || c.cpf.length < 11) {
      // Sem CPF: salva mesmo assim (vendedora pode preencher manualmente depois),
      // mas avisa que o crediário não vai funcionar até cadastrar CPF no Giga.
      const ok = window.confirm(
        `${c.nome} não tem CPF cadastrado no Giga.\n\n` +
        `Posso identificar com nome só, mas pra crediário você precisa cadastrar o CPF no Giga primeiro.\n\nIdentificar mesmo assim?`,
      );
      if (!ok) return;
    }
    onSave({
      cpf: c.cpf || '',
      name: c.nome || '',
      email: '',
      phone: c.telefone || '',
    });
  }

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

        {/* TYPEAHEAD — busca rápida por CPF ou nome (puxa do Giga) */}
        <div className="relative">
          <div className="flex items-center gap-2 border-2 border-violet-300 bg-violet-50 rounded px-2 py-2 focus-within:border-violet-500">
            <Search className="w-4 h-4 text-violet-600 shrink-0" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onFocus={() => results.length > 0 && setShowResults(true)}
              placeholder="Buscar cliente por CPF ou nome…"
              className="flex-1 bg-transparent text-sm focus:outline-none"
              autoComplete="off"
            />
            {searching && <Loader2 className="w-4 h-4 animate-spin text-violet-500" />}
          </div>

          {showResults && results.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border-2 border-violet-200 rounded-lg shadow-xl max-h-72 overflow-y-auto z-10">
              {results.map((c) => {
                const semCpf = !c.cpf || c.cpf.length < 11;
                return (
                  <button
                    key={c.codCliente + c.cpf}
                    type="button"
                    onClick={() => pickResult(c)}
                    className={`w-full text-left px-3 py-2 hover:bg-violet-50 border-b border-slate-100 last:border-b-0 transition ${
                      semCpf ? 'opacity-60' : ''
                    }`}
                    title={semCpf ? 'Cliente sem CPF cadastrado — não consegue fazer crediário' : ''}
                  >
                    <div className="font-bold text-sm text-slate-800 truncate flex items-center gap-1.5">
                      {c.nome || '— sem nome —'}
                      {semCpf && (
                        <span className="text-[9px] bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded font-bold">SEM CPF</span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 flex gap-2 mt-0.5">
                      {c.cpf && <span>CPF {c.cpf}</span>}
                      {c.codCliente && <span>· cód {c.codCliente}</span>}
                      {c.cidade && <span>· {c.cidade}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {showResults && !searching && searchTerm.length >= 2 && results.length === 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl px-3 py-2 text-xs text-slate-500 z-10">
              Nenhum cliente encontrado. Preencha os campos abaixo manualmente.
            </div>
          )}
        </div>

        <div className="text-[10px] text-slate-400 text-center">— ou preencha manualmente —</div>

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
  methodFilter = 'all',
  presetMethod = null,
  presetBandeira = null,
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
  /** Filtra quais métodos aparecem na grid: 'all' = todos, 'pix' = só PIX,
   *  'cartao' = débito + crédito, 'crediario' = só crediário. */
  methodFilter?: 'all' | 'pix' | 'cartao' | 'crediario';
  /** Pré-seleção: pula a etapa de escolher método (atalhos MASTERCARD/VISANET/etc) */
  presetMethod?: string | null;
  /** Pré-seleção da bandeira (em conjunto com presetMethod) */
  presetBandeira?: string | null;
  onClose: () => void;
  onConfirm: (method: string, details?: any) => void;
  onLater: () => void;
  onPaymentsChange?: () => void;
  /** Sinaliza pro parent que entrou em fluxo automático (PIX confirmado) */
  onAutoFlowTriggered?: () => void;
}) {
  const { toast } = usePdvToast();
  // Lista de pagamentos parciais já adicionados
  const [payments, setPayments] = useState(initialPayments || []);
  const jaPago = payments.reduce((s, p) => s + p.valor, 0);
  const restante = Math.max(0, Math.round((total - jaPago) * 100) / 100);
  const pago100 = restante < 0.01;
  // Auto-seleciona quando filtro tem só 1 método (PIX, crediario) OU quando
  // veio um presetMethod dos atalhos rápidos (MASTERCARD/VISANET/REDESHOP/...).
  const initialSelected = presetMethod
    ? presetMethod
    : methodFilter === 'pix' ? 'pix'
    : methodFilter === 'crediario' ? 'crediario'
    : null;
  const [selected, setSelected] = useState<string | null>(initialSelected);
  const [bandeira, setBandeira] = useState<string | null>(presetBandeira);
  // Declarado AQUI (não mais embaixo) porque é usado em hooks/handlers acima
  // — TS reclama de TDZ se ficar declarado depois do primeiro uso.
  const needsBandeira = selected === 'debito' || selected === 'credito';
  const bandeiras =
    selected === 'debito'
      ? BANDEIRAS_DEBITO
      : selected === 'credito'
      ? BANDEIRAS_CREDITO
      : [];
  // Filtro EFETIVO de métodos exibidos. Começa com o prop methodFilter, mas
  // após o 1º pagamento parcial muda pra 'all' automaticamente — assim a
  // vendedora pode misturar formas (ex: PIX + dinheiro, CARTÃO + dinheiro).
  const [effectiveFilter, setEffectiveFilter] = useState<typeof methodFilter>(methodFilter);
  const [parcelas, setParcelas] = useState(1);
  const [recebido, setRecebido] = useState('');
  // Valor que vai cobrir essa forma de pagamento (default = restante)
  const [valorParcial, setValorParcial] = useState('');
  const [addingPayment, setAddingPayment] = useState(false);

  // ── Crediário ──
  // Entrada (pagamento avulso descontado do total antes de parcelar)
  const [credEntrada, setCredEntrada] = useState('');
  // Primeiro vencimento (formato YYYY-MM-DD), default +30d
  const [credVencto, setCredVencto] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [credObs, setCredObs] = useState('');
  // Info do cliente vinda do Giga + pendências (pra banner de inadimplência)
  const [credCustomerInfo, setCredCustomerInfo] = useState<{
    found: boolean;
    cliente?: { codCliente: string; nome: string | null; cpf: string };
    pendencias?: Array<{ vencimento: string; valor: number; diasAtraso: number }>;
    totalDevido?: number;
    totalAtraso?: number;
    qtdPendencias?: number;
    qtdAtrasadas?: number;
    message?: string;
  } | null>(null);
  const [credLoading, setCredLoading] = useState(false);

  // Busca info do cliente quando seleciona crediário OU quando troca o cliente.
  // BUG FIX: antes tinha "if (credCustomerInfo) return" que impedia re-busca
  // ao trocar de cliente — ficava preso no resultado anterior.
  useEffect(() => {
    if (selected !== 'crediario' || !customerCpf) return;
    let cancelled = false;
    setCredCustomerInfo(null); // limpa resultado antigo enquanto busca o novo
    setCredLoading(true);
    (async () => {
      try {
        const r = await api<any>(`/pdv/customer-info?cpf=${encodeURIComponent(customerCpf)}`);
        if (!cancelled) setCredCustomerInfo(r);
      } catch (e: any) {
        if (!cancelled) setCredCustomerInfo({ found: false, message: e?.message || 'Erro ao buscar cliente' });
      } finally {
        if (!cancelled) setCredLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, customerCpf]);

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

  // ── Adicionar pagamento (com auto-finalize quando completa) ──
  // Se o valor digitado fecha o total da venda (95% dos casos: 1 forma só),
  // automaticamente finaliza a venda na mesma ação — economiza 1 clique.
  // Se for split (valor < restante), volta pra escolher próxima forma.
  const adicionarPagamento = async () => {
    if (!selected) return;
    const valor = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.'));
    if (isNaN(valor) || valor <= 0) {
      toast('error', 'Valor inválido', 'Use só números (ex: 50,00)');
      return;
    }
    // Detecta se esse pagamento vai zerar o total → finaliza automaticamente
    const willComplete = Math.abs(valor - restante) < 0.01;
    if (valor > restante + 0.01) {
      toast('warning', 'Valor maior que o restante', `Falta apenas ${brl(restante)} pra fechar a venda`);
      return;
    }
    if (selected === 'crediario' && !customerCpf) {
      toast('warning', 'Crediário exige CPF', 'Identifique o cliente antes de fechar no crediário');
      return;
    }
    if (selected === 'crediario' && credCustomerInfo && !credCustomerInfo.found) {
      toast('error', 'Cliente não cadastrado no Giga', 'Cadastre antes de fechar no crediário');
      return;
    }
    if (selected === 'crediario' && !credVencto) {
      toast('warning', 'Defina o primeiro vencimento');
      return;
    }
    if (needsBandeira && !bandeira) {
      toast('warning', 'Escolha a bandeira', 'Visa, Master, Elo, Hipercard…');
      return;
    }
    if (selected === 'pix' && !pixCharge) {
      toast('info', 'Gerando QR PIX', 'Aguarde alguns segundos');
      return;
    }
    if (selected === 'dinheiro' && recebidoNum > 0 && recebidoNum < valor) {
      toast('warning', 'Valor recebido insuficiente', `Recebido ${brl(recebidoNum)} é menor que ${brl(valor)}`);
      return;
    }

    const details: any = {};
    if (selected === 'credito' || selected === 'crediario') {
      details.parcelas = parcelas;
      const calc = calcularParcelas(valor, parcelas);
      details.valorIguais = calc.iguais;
      details.qtdIguais = calc.qtdIguais;
      details.valorUltima = calc.ultima;
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
      // CREDIÁRIO com ENTRADA: divide em 2 pagamentos paralelos.
      //   1. Entrada como "dinheiro" (vai pro caixa do dia)
      //   2. Restante como "crediario" (parcelas vão pro Giga)
      // Sem entrada: só payment crediário do valor total.
      const entradaNum = selected === 'crediario'
        ? Math.max(0, Math.round((Number((credEntrada || '0').replace(/\./g, '').replace(',', '.')) || 0) * 100) / 100)
        : 0;
      const valorFinanciado = selected === 'crediario' ? Math.max(0, Math.round((valor - entradaNum) * 100) / 100) : valor;

      if (selected === 'crediario' && entradaNum > 0) {
        // 1) Cria pagamento da entrada como dinheiro
        const pEntrada = await api<any>(`/pdv/sales/${saleId}/payments`, {
          method: 'POST',
          body: JSON.stringify({
            method: 'dinheiro',
            valor: entradaNum,
            details: { recebido: entradaNum, troco: 0, isEntradaCrediario: true },
          }),
        });
        setPayments((prev) => [...prev, pEntrada]);
      }

      // Cria pagamento principal (valor restante se houve entrada, senão valor inteiro)
      const valorPayment = selected === 'crediario' ? valorFinanciado : valor;
      if (valorPayment > 0) {
        const newPayment = await api<any>(`/pdv/sales/${saleId}/payments`, {
          method: 'POST',
          body: JSON.stringify({ method: selected, valor: valorPayment, details }),
        });
        setPayments((prev) => [...prev, newPayment]);
      }

      // CRIA PARCELAS NO GIGA (só se for crediário) — escreve N linhas em movimento
      if (selected === 'crediario' && valorFinanciado > 0) {
        try {
          const r = await api<any>(`/pdv/sales/${saleId}/crediario`, {
            method: 'POST',
            body: JSON.stringify({
              parcelas,
              primeiroVencimento: credVencto,
              entrada: entradaNum,
              observacao: credObs || undefined,
            }),
          });
          toast(
            'success',
            `${parcelas}× parcela(s) criada(s) no Giga`,
            `Controle ${r.controle} · ${brl(valorFinanciado)} dividido em ${parcelas}×`,
          );
        } catch (e: any) {
          // Se falhar a criação no Giga, ainda mantém os pagamentos no PDV mas avisa
          const h = humanizeError(e);
          toast(
            'error',
            'Pagamento registrado, mas FALHOU criar parcelas no Giga',
            h.hint || h.title,
          );
        }
      }

      // Reset form pra próximo pagamento
      setSelected(null);
      setBandeira(null);
      setParcelas(1);
      setRecebido('');
      setValorParcial('');
      setPixCharge(null);
      setCredEntrada('');
      setCredObs('');
      setCredCustomerInfo(null);
      // Após 1º pagamento parcial: libera TODOS os métodos pra completar
      // a venda em outras formas (multi-pagamento). Assim a vendedora não
      // fica presa no filtro original (ex: clicou em PIX, pagou parte, e
      // agora precisa receber o resto em dinheiro/cartão).
      setEffectiveFilter('all');
      onPaymentsChange?.();
      // ── AUTO-FINALIZE ──
      // Se o pagamento atual zerou o restante (caso comum: pagamento em forma única),
      // finaliza a venda automaticamente sem exigir 2º clique. Pequeno delay deixa
      // o estado de payments propagar antes do finalize.
      if (willComplete) {
        setTimeout(() => {
          onConfirm('', undefined);
        }, 80);
      }
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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
      const h = humanizeError(e);
      toast('error', `Erro ao gerar PIX: ${h.title}`, h.hint);
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
      toast('warning', 'Não consegui copiar', 'Selecione e copie manualmente');
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

  // ATALHOS DE TECLADO no PaymentModal:
  //   Enter        → "Adicionar pagamento" (se tem método+valor) OU "Finalizar venda" (se pago100)
  //   1-9          → Seleciona parcelas (1× a 9×) — só se crédito + bandeira
  //   0            → 10×
  //   Esc          → Fecha modal (já tem padrão do navegador)
  // Foco: ignora se vendedora está digitando em <input> (deixa Enter no input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      // Enter finaliza ou adiciona pagamento
      if (e.key === 'Enter' && !isTyping) {
        e.preventDefault();
        if (pago100 && !finalizing) {
          onConfirm('', undefined);
        } else if (selected && !addingPayment && valorParcial && (!needsBandeira || bandeira)) {
          adicionarPagamento();
        }
        return;
      }

      // 1-9, 0 → parcelas (só se crédito + bandeira selecionados, sem foco em input)
      if (selected === 'credito' && bandeira && !isTyping && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        const n = e.key === '0' ? 10 : Number(e.key);
        if (n >= 1 && n <= 12) setParcelas(n);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pago100, finalizing, selected, addingPayment, valorParcial, needsBandeira, bandeira]);

  // Auto-finaliza quando ficou 100% pago + forma única + não-crediário.
  // (Crediário tem fluxo extra de impressão de promissória/carnê — vendedora
  // precisa da tela "Venda Finalizada" pra disparar a impressão.)
  // Caso PIX: autoAddRef era setado pelo polling. Generalizado pra TODOS
  // os métodos único — agiliza checkout em ~3 cliques (era 5-7).
  useEffect(() => {
    if (autoFinalizeRef.current) return;
    if (!pago100) return;
    if (finalizing || addingPayment) return;
    if (payments.length !== 1) return; // só auto-finaliza forma única
    const m = String(payments[0].method || '').toLowerCase();
    if (m === 'crediario') return; // crediário precisa imprimir promissória/carnê
    autoFinalizeRef.current = true;
    const t = setTimeout(() => {
      onConfirm('', undefined);
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pago100, finalizing, addingPayment, payments.length]);

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

  const canConfirm = useMemo(() => {
    if (!selected) return false;
    if (selected === 'crediario' && !customerCpf) return false;
    if (selected === 'dinheiro' && recebidoNum < total) return false;
    if (needsBandeira && !bandeira) return false;
    return true;
  }, [selected, bandeira, needsBandeira, recebidoNum, total, customerCpf]);

  const confirm = async () => {
    if (!selected) return;

    // ── Validações específicas pra CREDIÁRIO ──
    if (selected === 'crediario') {
      if (!customerCpf) {
        toast('warning', 'CPF obrigatório', 'Identifique o cliente antes');
        return;
      }
      if (credCustomerInfo && !credCustomerInfo.found) {
        toast('error', 'Cliente não cadastrado no Giga', 'Cadastre antes de fechar no crediário');
        return;
      }
      if (!credVencto) {
        toast('warning', 'Defina o primeiro vencimento');
        return;
      }
    }

    const details: any = {};
    if (selected === 'credito' || selected === 'crediario') {
      details.parcelas = parcelas;
      const calc = calcularParcelas(total, parcelas);
      details.valorIguais = calc.iguais;
      details.qtdIguais = calc.qtdIguais;
      details.valorUltima = calc.ultima;
      if (selected === 'crediario') {
        // Salva nos details pra o gerador de PDF de promissórias usar depois
        details.primeiroVencimento = credVencto;
        details.entrada = Math.max(0, Math.round((Number((credEntrada || '0').replace(/\./g, '').replace(',', '.')) || 0) * 100) / 100);
        details.observacao = credObs;
      }
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

    // ── CREDIÁRIO: gera parcelas no Giga ANTES de finalizar a venda ──
    // Mantém comportamento idempotente: se Giga falhar, NÃO finaliza a venda
    // (vendedora vê erro e pode tentar de novo). Diferente do split path que
    // tolera falha — aqui é fluxo direto.
    if (selected === 'crediario') {
      const entradaNum = details.entrada || 0;
      const valorFinanciado = Math.max(0, Math.round((total - entradaNum) * 100) / 100);
      if (valorFinanciado > 0) {
        try {
          const r = await api<any>(`/pdv/sales/${saleId}/crediario`, {
            method: 'POST',
            body: JSON.stringify({
              parcelas,
              primeiroVencimento: credVencto,
              entrada: entradaNum,
              observacao: credObs || undefined,
            }),
          });
          toast(
            'success',
            `${parcelas}× parcelas criadas no Giga`,
            `Controle ${r.controle} · ${brl(valorFinanciado)} dividido`,
          );
        } catch (e: any) {
          const h = humanizeError(e);
          toast('error', `Erro ao criar parcelas no Giga: ${h.title}`, h.hint || 'Tente novamente');
          return; // ABORTA finalização — vendedora pode tentar de novo
        }
      }
    }

    onConfirm(selected, details);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-2 sm:p-4"
      onClick={onClose}
    >
      {/* Modal: layout flex-col com header/body/footer separados.
         Footer sticky no FUNDO pra botão "Adicionar/Finalizar" SEMPRE aparecer
         (antes ficava cortado em telas baixas com 12 parcelas + card grande). */}
      <div
        className="bg-white rounded-t-2xl sm:rounded-lg w-full max-w-lg flex flex-col max-h-[95vh] sm:max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER fixo */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-slate-100 shrink-0">
          <h2 className="font-semibold flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> Pagamento
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        {/* BODY scrollável */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">

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

        {/* Botão MARCAR — sistema de "leva pra provar em casa".
            Só aparece se: cliente identificado + sem pagamentos adicionados ainda. */}
        {customerCpf && payments.length === 0 && !pago100 && (
          <MarcarComponent
            saleId={saleId}
            customerCpf={customerCpf}
            total={total}
            onMarked={() => {
              toast('success', 'Peças marcadas!', 'Cliente vai provar em casa');
              onClose();
              onPaymentsChange?.();
            }}
          />
        )}

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

        {/* Métodos só aparecem quando ainda há restante a pagar.
            FILTRO: quando vendedora abre o modal pelos botões da sidebar
            (PIX/CARTÃO/CRED.), mostra só os métodos correspondentes. */}
        {!pago100 && (
          <>
            <div className="text-[10px] uppercase font-semibold text-slate-500 flex items-center justify-between">
              <span>
                {effectiveFilter === 'pix' && 'Pagar com PIX'}
                {effectiveFilter === 'cartao' && 'Pagar com cartão'}
                {effectiveFilter === 'crediario' && 'Vender no crediário'}
                {effectiveFilter === 'all' && (payments.length > 0 ? 'Completar com outra forma' : 'Adicionar forma de pagamento')}
              </span>
              {/* Toggle: se filtrou por algo específico, permite expandir pra todas */}
              {effectiveFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setEffectiveFilter('all')}
                  className="text-[10px] font-bold text-violet-600 hover:underline normal-case"
                >
                  + outras formas
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {PAYMENT_METHODS
                .filter((p) => {
                  if (effectiveFilter === 'all') return true;
                  if (effectiveFilter === 'pix') return p.id === 'pix';
                  if (effectiveFilter === 'cartao') return p.id === 'debito' || p.id === 'credito';
                  if (effectiveFilter === 'crediario') return p.id === 'crediario';
                  return true;
                })
                .map((p) => {
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

        {/* Detalhes dinheiro — painel destaque estilo Wincred */}
        {selected === 'dinheiro' && (() => {
          // Calcula com base no valorParcial (não o total) — caso seja split,
          // o troco deve refletir o valor da forma, não da venda inteira.
          const valorFormaNum = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.')) || 0;
          const recebidoLocal = Number((recebido || '0').replace(/\./g, '').replace(',', '.')) || 0;
          const trocoLocal = recebidoLocal > valorFormaNum ? Math.round((recebidoLocal - valorFormaNum) * 100) / 100 : 0;
          const insuficiente = recebidoLocal > 0 && recebidoLocal < valorFormaNum;
          return (
            <div className="pt-2 border-t">
              <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs uppercase font-bold text-amber-900 tracking-wide">Valor a receber</span>
                  <span className="text-xl font-black text-amber-900 tabular-nums">{brl(valorFormaNum)}</span>
                </div>
                <div>
                  <label className="text-xs uppercase font-bold text-amber-900 mb-1 block">
                    Valor recebido (opcional — pra calcular troco)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={recebido}
                    onChange={(e) => setRecebido(e.target.value)}
                    placeholder={valorFormaNum.toFixed(2).replace('.', ',')}
                    className="w-full px-3 py-3 text-2xl font-bold text-emerald-700 tabular-nums bg-white border-2 border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-500"
                    autoFocus
                  />
                </div>
                {/* Troco — destaque MASSIVO em verde quando há troco */}
                {trocoLocal > 0 && (
                  <div className="bg-emerald-600 text-white rounded-lg p-3 flex items-center justify-between shadow-md">
                    <span className="text-sm font-bold uppercase tracking-wide">Troco</span>
                    <span className="text-3xl font-black tabular-nums">{brl(trocoLocal)}</span>
                  </div>
                )}
                {insuficiente && (
                  <div className="bg-rose-100 border border-rose-300 text-rose-800 rounded-lg p-2 text-xs font-bold flex items-center gap-2">
                    Faltam {brl(valorFormaNum - recebidoLocal)}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* CREDIÁRIO — banner pendências + entrada + primeiro vencimento */}
        {selected === 'crediario' && customerCpf && (
          <div className="space-y-2 pt-2 border-t">
            {credLoading && (
              <div className="text-xs text-slate-500 flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Buscando cliente no Giga…
              </div>
            )}
            {credCustomerInfo && !credCustomerInfo.found && (
              <div className="bg-rose-50 border-2 border-rose-300 rounded-lg p-2.5 text-xs text-rose-900">
                <b>⚠️ Cliente não encontrado no Giga.</b> {credCustomerInfo.message}
                <br />
                Cadastre o cliente no Wincred antes de fechar a venda no crediário.
              </div>
            )}
            {credCustomerInfo?.found && credCustomerInfo.qtdPendencias === 0 && (
              <div className="bg-emerald-50 border border-emerald-200 rounded px-2.5 py-1.5 text-xs text-emerald-800 flex items-center gap-2">
                <Check className="w-3.5 h-3.5" />
                Cliente <b>{credCustomerInfo.cliente?.nome || '—'}</b> sem pendências.
              </div>
            )}
            {credCustomerInfo?.found && (credCustomerInfo.qtdPendencias || 0) > 0 && (
              <div className={`border-2 rounded-lg p-2.5 ${
                (credCustomerInfo.qtdAtrasadas || 0) > 0
                  ? 'bg-rose-50 border-rose-300'
                  : 'bg-amber-50 border-amber-300'
              }`}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className={`text-xs font-bold flex items-center gap-1.5 ${
                    (credCustomerInfo.qtdAtrasadas || 0) > 0 ? 'text-rose-800' : 'text-amber-800'
                  }`}>
                    <AlertTriangle className="w-4 h-4" />
                    {(credCustomerInfo.qtdAtrasadas || 0) > 0
                      ? `Cliente DEVENDO — ${credCustomerInfo.qtdAtrasadas}× vencidas`
                      : `Cliente tem ${credCustomerInfo.qtdPendencias} parcelas em aberto`}
                  </div>
                  <div className={`text-sm font-black tabular-nums ${
                    (credCustomerInfo.qtdAtrasadas || 0) > 0 ? 'text-rose-700' : 'text-amber-700'
                  }`}>
                    {brl(credCustomerInfo.totalDevido || 0)}
                  </div>
                </div>
                {(credCustomerInfo.totalAtraso || 0) > 0 && (
                  <div className="text-[11px] text-rose-700 font-semibold">
                    Atrasado: {brl(credCustomerInfo.totalAtraso || 0)}
                  </div>
                )}
                <div className="text-[10px] text-slate-600 mt-1 italic">
                  Você pode prosseguir com a venda — só um aviso.
                </div>
              </div>
            )}

            {/* Entrada + Primeiro vencimento lado a lado */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
                  Entrada (R$)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={credEntrada}
                  onChange={(e) => setCredEntrada(e.target.value)}
                  placeholder="0,00"
                  className="w-full px-3 py-2 text-base font-bold tabular-nums text-emerald-700 border-2 border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:border-emerald-400"
                />
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Vai como dinheiro/PIX paralelo
                </div>
              </div>
              <div>
                <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
                  Primeiro vencimento
                </label>
                <input
                  type="date"
                  value={credVencto}
                  onChange={(e) => setCredVencto(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-bold border-2 border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:border-emerald-400"
                />
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Próximas mantém o mesmo dia
                </div>
              </div>
            </div>

            {/* Atalhos rápidos: cliente quer pagar todo dia X */}
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wide">
                Atalho — pagar todo dia
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {[5, 10, 15, 20, 25].map((dia) => {
                  const corrent = credVencto ? new Date(credVencto + 'T00:00:00') : null;
                  const ativo = corrent && corrent.getDate() === dia;
                  return (
                    <button
                      key={dia}
                      type="button"
                      onClick={() => {
                        // Próxima ocorrência do dia X (se já passou no mês atual, vai pro próximo)
                        const hoje = new Date();
                        hoje.setHours(0, 0, 0, 0);
                        const alvo = new Date(hoje.getFullYear(), hoje.getMonth(), dia);
                        if (alvo <= hoje) alvo.setMonth(alvo.getMonth() + 1);
                        const yyyy = alvo.getFullYear();
                        const mm = String(alvo.getMonth() + 1).padStart(2, '0');
                        const dd = String(alvo.getDate()).padStart(2, '0');
                        setCredVencto(`${yyyy}-${mm}-${dd}`);
                      }}
                      className={`py-1.5 rounded-md text-xs font-bold border-2 transition ${
                        ativo
                          ? 'bg-emerald-600 border-emerald-700 text-white shadow-sm'
                          : 'bg-white border-slate-200 hover:border-emerald-300 hover:bg-emerald-50 text-slate-700'
                      }`}
                    >
                      Dia {String(dia).padStart(2, '0')}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Preview dos vencimentos das parcelas */}
            {credVencto && parcelas > 0 && (() => {
              const base = new Date(credVencto + 'T00:00:00');
              if (isNaN(base.getTime())) return null;
              const datas: string[] = [];
              for (let i = 0; i < Math.min(parcelas, 12); i++) {
                const d = new Date(base);
                d.setMonth(d.getMonth() + i);
                datas.push(d.toLocaleDateString('pt-BR'));
              }
              return (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 space-y-1">
                  <div className="text-[10px] uppercase font-bold text-emerald-700 tracking-wide">
                    Vencimentos das {parcelas} parcela{parcelas > 1 ? 's' : ''}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {datas.map((d, i) => (
                      <span key={i} className="text-[11px] font-bold tabular-nums bg-white border border-emerald-300 text-emerald-800 px-2 py-0.5 rounded">
                        {i + 1}× {d}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Observação livre na promissória */}
            <div>
              <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
                Observação (opcional)
              </label>
              <input
                type="text"
                value={credObs}
                onChange={(e) => setCredObs(e.target.value.slice(0, 100))}
                placeholder="Ex: Vendedora Manu · cliente confiança"
                className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:border-emerald-400"
              />
            </div>
          </div>
        )}

        {/* Parcelas (crédito ou crediário) — 1 a 12x sem juros.
           Layout: cada botão mostra Nx + VALOR DA PARCELA já calculado, pra
           vendedora cantar pro cliente sem pegar calculadora ("10x de R$ 23,90").
           Selecionado vira card GIGANTE embaixo. */}
        {(selected === 'credito' || selected === 'crediario') && (() => {
          // Base de cálculo: crediário desconta entrada antes de parcelar.
          const ent = selected === 'crediario'
            ? (Number((credEntrada || '0').replace(/\./g, '').replace(',', '.')) || 0)
            : 0;
          const baseTotal = Math.max(0, total - ent);
          return (
            <div className="space-y-2 pt-2 border-t">
              <label className="text-xs text-slate-600 uppercase font-semibold flex items-center justify-between">
                <span>Parcelas (sem juros)</span>
                {selected === 'crediario' && ent > 0 && (
                  <span className="normal-case text-slate-500 text-[10px]">
                    Financiando {brl(baseTotal)} (entrada {brl(ent)})
                  </span>
                )}
              </label>
              {/* CASCATA VERTICAL — 12 linhas compactas, sem rolagem lateral.
                  Cada linha: [Nx pílula] [parcela] [→]. Cabe inteira na tela.
                  Linha selecionada destaca com fundo verde. */}
              <div className="flex flex-col gap-1">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((p) => {
                  const calc = calcularParcelas(baseTotal, p);
                  const valorMostrar = calc.iguais;
                  const ativo = parcelas === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setParcelas(p)}
                      className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md transition-all border ${
                        ativo
                          ? 'bg-emerald-600 border-emerald-700 text-white shadow-sm'
                          : 'bg-white border-slate-200 hover:border-emerald-300 hover:bg-emerald-50 text-slate-700'
                      }`}
                    >
                      <span className={`inline-flex items-center justify-center min-w-[36px] h-6 px-1.5 rounded font-black text-xs tabular-nums ${
                        ativo ? 'bg-white/25 text-white' : 'bg-emerald-100 text-emerald-800'
                      }`}>{p}×</span>
                      <span className={`flex-1 text-left text-[11px] font-bold ${
                        ativo ? 'text-white/90' : 'text-slate-500'
                      }`}>
                        {p === 1 ? 'à vista' : 'sem juros'}
                      </span>
                      <span className={`text-sm font-black tabular-nums ${
                        ativo ? 'text-white' : 'text-emerald-700'
                      }`}>
                        {p === 1 ? brl(baseTotal) : brl(valorMostrar)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Card destaque compacto da seleção atual — vendedora bate o olho */}
              {(() => {
                const calc = calcularParcelas(baseTotal, parcelas);
                if (parcelas === 1) {
                  return (
                    <div className="bg-emerald-600 rounded-lg px-3 py-2 flex items-center justify-between text-white shadow-sm">
                      <span className="text-xs uppercase tracking-wider font-bold opacity-90">À vista</span>
                      <span className="text-xl font-black tabular-nums">{brl(baseTotal)}</span>
                    </div>
                  );
                }
                const todasIguais = calc.iguais === calc.ultima;
                return (
                  <div className="bg-emerald-600 rounded-lg px-3 py-2 text-white shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs uppercase tracking-wider font-bold opacity-90">Parcelado</span>
                      <span className="text-xl font-black tabular-nums">
                        {parcelas}× {brl(calc.iguais)}
                      </span>
                    </div>
                    <div className="text-[10px] opacity-80 text-right">
                      {!todasIguais && `${calc.qtdIguais}× ${brl(calc.iguais)} + última ${brl(calc.ultima)} · `}
                      Total {brl(baseTotal)} sem juros{ent > 0 ? ` · entrada ${brl(ent)}` : ''}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}

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

        {/* fim do BODY scrollável */}
        </div>

        {/* FOOTER fixo — botões SEMPRE visíveis */}
        <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 space-y-2 rounded-b-lg">
          {/* Botão CONTEXTUAL — "FINALIZAR" quando vai zerar o total (95% dos casos)
              ou "ADICIONAR PARCIAL" quando é split (valor < restante). 1 clique a menos. */}
          {selected && !pago100 && (() => {
            const valorAtualNum = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.')) || 0;
            const vaiFinalizar = valorAtualNum > 0 && Math.abs(valorAtualNum - restante) < 0.01;
            const labelMain = selected === 'pix' && !vaiFinalizar
              ? 'Recebi o PIX — adicionar parcial'
              : vaiFinalizar
                ? `FINALIZAR · ${brl(valorAtualNum)}`
                : `Adicionar parcial · ${brl(valorAtualNum)}`;
            return (
              <button
                onClick={adicionarPagamento}
                disabled={
                  addingPayment ||
                  !valorParcial ||
                  (needsBandeira && !bandeira) ||
                  (selected === 'pix' && !pixCharge) ||
                  (selected === 'crediario' && !customerCpf)
                }
                className={`w-full px-3 py-3 font-bold rounded text-base disabled:opacity-40 flex items-center justify-center gap-2 transition-colors ${
                  vaiFinalizar
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-md ring-2 ring-emerald-300/60'
                    : 'bg-amber-500 hover:bg-amber-600 text-white'
                }`}
              >
                {addingPayment ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-5 h-5" />
                )}
                {labelMain}
              </button>
            );
          })()}

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

          {/* Fechar depois — discreto, abaixo do principal */}
          <button
            onClick={onLater}
            disabled={finalizing}
            className="w-full px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 font-semibold rounded text-xs flex items-center justify-center gap-1.5"
            title="Pausar a venda — fica em aberto pra finalizar depois"
          >
            <Pause className="w-3.5 h-3.5" />
            Fechar depois (pausar)
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Input rápido pra ADICIONAR CPF na nota antes de emitir NFC-e.
 * Aparece só quando: NFC-e ainda NÃO foi emitida.
 *
 * Comportamento:
 *  - Se a venda já tem CPF: mostra "✓ CPF: XXX.XXX.XXX-XX [trocar]"
 *  - Se não tem: input "Digite o CPF do cliente (opcional)" + botão "Adicionar"
 *  - Aceita CPF com pontos/traço ou só números (limpa antes de salvar)
 *  - Após adicionar, atualiza a venda no parent via onUpdated
 */
function CpfNaNotaInput({ sale, onUpdated }: { sale: Sale; onUpdated: (s: Sale) => void }) {
  const { toast } = usePdvToast();
  const [editing, setEditing] = useState(false);
  const [cpfInput, setCpfInput] = useState('');
  const [saving, setSaving] = useState(false);

  // Formata CPF pra exibição: 28665529896 → 286.655.298-96
  const fmtCpf = (raw: string | null) => {
    if (!raw) return '';
    const d = String(raw).replace(/\D/g, '');
    if (d.length === 11) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
    return d;
  };

  async function salvarCpf() {
    const cpfLimpo = cpfInput.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      toast('error', 'CPF inválido', 'Digita os 11 dígitos do CPF');
      return;
    }
    setSaving(true);
    try {
      // Chama backend pra atualizar customerCpf da venda
      await api(`/pdv/sales/${sale.id}/customer`, {
        method: 'PATCH',
        body: JSON.stringify({ cpf: cpfLimpo }),
      });
      // Recarrega venda completa
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      onUpdated(fresh);
      setEditing(false);
      setCpfInput('');
      toast('success', 'CPF adicionado', 'Vai aparecer na NFC-e quando emitir');
    } catch (e: any) {
      toast('error', 'Falha ao salvar CPF', e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  // Já tem CPF + não está editando: mostra resumido
  if (sale.customerCpf && !editing) {
    return (
      <div className="bg-blue-50 border-2 border-blue-200 rounded p-2.5 flex items-center gap-2">
        <Check className="w-4 h-4 text-blue-700 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-blue-700 font-bold uppercase">CPF na nota</div>
          <div className="text-sm font-mono font-bold text-blue-900">{fmtCpf(sale.customerCpf)}</div>
          {sale.customerName && (
            <div className="text-[11px] text-blue-700 truncate">{sale.customerName}</div>
          )}
        </div>
        <button
          onClick={() => { setEditing(true); setCpfInput(sale.customerCpf || ''); }}
          className="text-xs text-blue-700 hover:underline px-2 py-1"
        >
          trocar
        </button>
      </div>
    );
  }

  // Não tem CPF e não está editando: botão pra adicionar
  if (!sale.customerCpf && !editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="w-full px-3 py-2 border-2 border-dashed border-blue-300 hover:border-blue-500 hover:bg-blue-50 text-blue-700 font-bold rounded flex items-center justify-center gap-2 text-sm"
      >
        + CPF na nota (opcional)
      </button>
    );
  }

  // Modo edição: input + botões
  return (
    <div className="bg-blue-50 border-2 border-blue-300 rounded p-3 space-y-2">
      <label className="text-xs font-bold text-blue-900 uppercase">CPF do cliente</label>
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={cpfInput}
          onChange={(e) => setCpfInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && salvarCpf()}
          placeholder="Só números ou com . e -"
          className="flex-1 border rounded px-3 py-2 text-base font-mono"
          autoFocus
          maxLength={14}
        />
        <button
          onClick={salvarCpf}
          disabled={saving || cpfInput.replace(/\D/g, '').length !== 11}
          className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-bold rounded text-sm"
        >
          {saving ? '…' : 'Salvar'}
        </button>
        <button
          onClick={() => { setEditing(false); setCpfInput(''); }}
          disabled={saving}
          className="px-2 py-2 text-slate-600 hover:bg-slate-100 rounded text-sm"
        >
          ✕
        </button>
      </div>
      <div className="text-[10px] text-blue-700">
        Aperta Enter pra salvar. CPF aparece na NFC-e impressa.
      </div>
    </div>
  );
}

/**
 * Componente "Marcar peças" — sistema de "leva pra provar em casa".
 * Aparece dentro do PaymentModal quando o cliente está identificado E
 * ainda não tem pagamentos adicionados. Valida no backend se o cliente
 * é classe A com limite, mostra info, e oferece o botão MARCAR.
 */
function MarcarComponent({
  saleId,
  customerCpf,
  total,
  onMarked,
}: {
  saleId: string;
  customerCpf: string;
  total: number;
  onMarked: () => void;
}) {
  const { toast } = usePdvToast();
  const [info, setInfo] = useState<{
    permitido: boolean;
    motivo?: string;
    cliente: { nome: string; classificacao: string; limiteTotal: number } | null;
    totalMarcadosAtivos: number;
    limiteDisponivel: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<typeof info>(`/pdv/marcados/cliente?cpf=${customerCpf}`)
      .then((r) => { if (!cancelled) setInfo(r as any); })
      .catch(() => { if (!cancelled) setInfo(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [customerCpf]);

  if (loading) {
    return (
      <div className="bg-purple-50 border border-purple-200 rounded p-3 text-xs text-purple-700 flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> Verificando se cliente pode marcar…
      </div>
    );
  }

  // Não tem permissão ou erro — esconde a opção
  if (!info || !info.permitido || total > info.limiteDisponivel) {
    if (info && !info.permitido) {
      // Mostra um aviso discreto pra vendedora saber por que não tem opção
      return (
        <details className="bg-slate-50 border rounded p-2 text-xs text-slate-600">
          <summary className="cursor-pointer font-bold">
            ℹ️ Cliente não pode marcar
          </summary>
          <div className="mt-1">{info.motivo}</div>
        </details>
      );
    }
    if (info && total > info.limiteDisponivel) {
      return (
        <details className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-800">
          <summary className="cursor-pointer font-bold">
            ⚠️ Valor excede limite de marcado
          </summary>
          <div className="mt-1">
            Limite: {brl(info.cliente?.limiteTotal || 0)} ·
            Em aberto: {brl(info.totalMarcadosAtivos)} ·
            Disponível: <b>{brl(info.limiteDisponivel)}</b>
            <div className="mt-1">Venda atual: <b>{brl(total)}</b> — passa do disponível.</div>
          </div>
        </details>
      );
    }
    return null;
  }

  async function marcar() {
    if (!confirm(
      `MARCAR ${brl(total)} pra ${info?.cliente?.nome}?\n\n` +
      `As peças vão ser registradas como "marcado" no Giga.\n` +
      `Estoque é baixado igual venda.\n` +
      `Cliente leva pra provar em casa.\n\n` +
      `Confirma?`,
    )) return;
    setMarking(true);
    try {
      const r = await api<{ ok: boolean; controle: number; totalItems: number }>(
        '/pdv/marcados/criar',
        { method: 'POST', body: JSON.stringify({ saleId }) },
      );
      if (r.ok) {
        onMarked();
      } else {
        toast('error', 'Falha ao marcar', 'Tente de novo');
      }
    } catch (e: any) {
      toast('error', 'Falha ao marcar', e?.message || String(e));
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="bg-purple-50 border-2 border-purple-300 rounded p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-xs font-bold uppercase text-purple-900">📋 Marcar (Provar em casa)</div>
          <div className="text-[11px] text-purple-700 mt-0.5">
            Cliente <b>{info.cliente?.nome}</b> · classe <b>{info.cliente?.classificacao}</b>
          </div>
          <div className="text-[10px] text-purple-600 mt-0.5">
            Limite disponível: <b>{brl(info.limiteDisponivel)}</b> (em aberto {brl(info.totalMarcadosAtivos)})
          </div>
        </div>
        <button
          onClick={marcar}
          disabled={marking}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white font-bold rounded text-sm flex items-center gap-1.5"
        >
          {marking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tag className="w-4 h-4" />}
          MARCAR {brl(total)}
        </button>
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
  const [printingCred, setPrintingCred] = useState(false);
  const { toast } = usePdvToast();

  // Detecta se a venda tem pagamento de crediário (mostra botões de impressão).
  // Cobre 2 caminhos: (1) split — payments[] tem method='crediario',
  // (2) confirmação direta — paymentMethod='crediario' no header da venda.
  const hasCrediario =
    sale.paymentMethod?.toLowerCase() === 'crediario' ||
    (sale.payments || []).some((p) => p.method === 'crediario');

  /**
   * Imprime promissórias + carnê (combinado) na impressora padrão.
   * Vendedora carrega 2 folhas brancas de promissória + 1 azul de carnê
   * antes de clicar.
   */
  async function imprimirCrediario(tipo: 'completo' | 'promissorias' | 'carne') {
    setPrintingCred(true);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('flowops_token') : null;
      if (!token) {
        toast('error', 'Sessão expirada', 'Faça login novamente');
        return;
      }
      const { API_URL } = await import('@/lib/api');
      const path =
        tipo === 'completo' ? 'credprint-pdf' :
        tipo === 'promissorias' ? 'promissorias-pdf' : 'carne-pdf';
      const r = await fetch(`${API_URL}/api/pdv/sales/${sale.id}/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(txt || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);

      // Tenta Electron silent print (PC desktop)
      const electron = (window as any).electronAPI;
      if (electron?.silentPrintUrl) {
        try {
          await electron.silentPrintUrl(url);
          toast('success', 'Enviado pra impressora', 'Confira a bandeja');
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          return;
        } catch (e) {
          console.warn('Electron print falhou, popup fallback:', e);
        }
      }
      // Fallback browser
      const w = window.open(url, 'lurds_cred_print', 'width=900,height=700');
      if (!w) {
        toast('warning', 'Popup bloqueado', 'Habilite popups OU baixa o PDF manual');
      } else {
        setTimeout(() => { try { w.focus(); w.print(); } catch {/*noop*/} }, 800);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
    } finally {
      setPrintingCred(false);
    }
  }

  const isAuthorized = sale.nfceStatus === 'authorized';
  const isCancelled = sale.nfceStatus === 'cancelled' || !!sale.nfceCanceladaEm;
  const isRejected = sale.nfceStatus === 'rejected' || sale.nfceStatus === 'error';

  // Calcula janela de cancelamento (30min)
  const minutosDesdeEmissao = sale.nfceAutorizadaEm
    ? (Date.now() - new Date(sale.nfceAutorizadaEm).getTime()) / 60000
    : 999;
  const podeCancelar = isAuthorized && !isCancelled && minutosDesdeEmissao <= 30;
  const minutosRestantes = Math.max(0, Math.floor(30 - minutosDesdeEmissao));

  /**
   * Imprime o cupom NFC-e (DANFE 80mm) na impressora ELGIN.
   *
   * Estratégia em camadas:
   *   1. QZ Tray (se configurado em /minha-loja/pdv/config-impressora)
   *      → imprime DIRETO na ELGIN, sem diálogo, zero clicks.
   *   2. Electron silentPrintHtml (se rodando no app desktop)
   *   3. Fallback: window.print() abre diálogo do navegador
   */
  async function imprimirDanfeNfce() {
    // ── Constantes da empresa (LURD'S / T.O. RISSUTTO EIRELI) ─────────
    const RAZAO_SOCIAL = "T.O. RISSUTTO EIRELI";
    const NOME_FANTASIA = "LURD'S PLUS SIZE";
    const CNPJ = "20.104.813/0001-39";

    // ── Itens do cupom: descrição + qty + unitário + subtotal ────────
    const itensHtml = sale.items.map((it, idx) => {
      const codigo = (it.ref || it.sku || '').toString().slice(0, 14);
      const desc = (it.descricao || it.ref || it.sku || '').toString().slice(0, 38);
      const cor = (it.cor || '').toString().slice(0, 10);
      const tam = (it.tamanho || '').toString().slice(0, 6);
      const variante = [cor, tam].filter(Boolean).join('/');
      const unit = (Number(it.total) || 0) / Math.max(1, Number(it.qty) || 1);
      return `
        <div class="item">
          <div class="item-line1">${idx + 1} ${codigo} ${desc}</div>
          ${variante ? `<div class="item-var">${variante}</div>` : ''}
          <div class="item-line2">
            <span>${it.qty} UN x ${brl(unit)}</span>
            <span>${brl(it.total)}</span>
          </div>
        </div>`;
    }).join('');

    // ── Data formatada ───────────────────────────────────────────────
    const dataAut = sale.nfceAutorizadaEm
      ? new Date(sale.nfceAutorizadaEm).toLocaleString('pt-BR')
      : new Date().toLocaleString('pt-BR');

    // ── QR Code da SEFAZ-SP (NFC-e) ──────────────────────────────────
    // Padrão: https://www.nfce.fazenda.sp.gov.br/qrcode?p=CHAVE|VERSAO|AMBIENTE|IDCSC|HASH
    // Como não temos o CSC aqui, geramos QR só com URL de consulta pela chave.
    const qrUrl = sale.nfceChave
      ? `https://www.nfce.fazenda.sp.gov.br/qrcode?chNFe=${sale.nfceChave}&nVersao=100&tpAmb=1`
      : '';
    const qrImgUrl = qrUrl
      ? `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodeURIComponent(qrUrl)}`
      : '';

    // ── Quantidade total de itens ────────────────────────────────────
    const qtdItens = sale.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>NFC-e ${sale.nfceNumber || ''}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  /* Preto puro em TUDO + fonte mais grossa pra impressora térmica */
  body {
    font-family: 'Courier New', monospace;
    font-size: 11px;
    font-weight: 600;  /* mais grosso que normal */
    width: 78mm;
    margin: 0;
    padding: 2mm;
    color: #000;
    line-height: 1.25;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .center { text-align: center; }
  .right { text-align: right; }
  .bold { font-weight: 900; }  /* extra-bold */
  .lg { font-size: 13px; font-weight: 900; }
  .xl { font-size: 15px; font-weight: 900; }
  .sm { font-size: 10px; }
  .xs { font-size: 9px; }
  .row { display: flex; justify-content: space-between; gap: 4px; color: #000; }
  .sep { border-top: 2px dashed #000; margin: 4px 0; }  /* 2px em vez de 1 */
  .sep-solid { border-top: 2px solid #000; margin: 4px 0; }
  .chave { font-size: 10px; font-weight: 900; word-break: break-all; line-height: 1.4; letter-spacing: 0.3px; color: #000; }
  .qr { display: block; margin: 6px auto; }
  .item { margin: 3px 0; }
  .item-line1 { font-weight: 900; font-size: 11px; color: #000; }
  .item-var { font-size: 10px; color: #000; padding-left: 12px; font-weight: 600; }
  .item-line2 { display: flex; justify-content: space-between; font-size: 11px; padding-left: 12px; font-weight: 700; color: #000; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; color: #000; }
</style></head><body>
  <!-- Cabeçalho da empresa -->
  <div class="center bold lg">${NOME_FANTASIA}</div>
  <div class="center xs">${RAZAO_SOCIAL}</div>
  <div class="center xs">CNPJ: ${CNPJ}</div>
  <div class="center xs">${sale.storeName || ''}</div>
  <div class="sep-solid"></div>

  <!-- Tipo de documento -->
  <div class="center bold sm">DANFE NFC-e</div>
  <div class="center xs">Documento Auxiliar da Nota Fiscal</div>
  <div class="center xs">Eletrônica para Consumidor Final</div>
  <div class="center xs">não permite aproveitamento de crédito de ICMS</div>
  <div class="sep"></div>

  <!-- Cabeçalho da tabela de itens -->
  <div class="row sm bold">
    <span>#  CÓDIGO  DESCRIÇÃO</span>
    <span>VL TOTAL</span>
  </div>
  <div class="row xs">
    <span>QTD x UNIT</span>
    <span></span>
  </div>
  <div class="sep"></div>

  <!-- Itens -->
  ${itensHtml}
  <div class="sep"></div>

  <!-- Totais -->
  <div class="row sm"><span>QTD. TOTAL DE ITENS</span><span>${qtdItens}</span></div>
  <div class="row bold lg"><span>VALOR TOTAL R$</span><span>${brl(sale.total)}</span></div>
  <div class="row sm"><span>FORMA PAGAMENTO</span><span>VALOR PAGO</span></div>
  <div class="row sm bold"><span>${(sale.paymentMethod || 'SPLIT').toUpperCase()}</span><span>${brl(sale.total)}</span></div>
  <div class="sep"></div>

  <!-- Tributos (Lei 12.741) -->
  <div class="center xs">Tributos totais incidentes (Lei Federal 12.741/2012):</div>
  <div class="center xs bold">R$ ${(sale.total * 0.0996).toFixed(2).replace('.', ',')} (Fonte: IBPT)</div>
  <div class="sep"></div>

  <!-- Identificação do consumidor -->
  ${sale.customerCpf
    ? `<div class="sm bold">CONSUMIDOR</div>
       <div class="sm">CPF: ${sale.customerCpf}${sale.customerName ? ` - ${sale.customerName}` : ''}</div>`
    : `<div class="sm bold">CONSUMIDOR NÃO IDENTIFICADO</div>`
  }
  <div class="sep"></div>

  <!-- Identificação da NFC-e -->
  <div class="center sm bold">NFC-e nº ${sale.nfceNumber || '—'} - Série ${(sale as any).nfceSerie || '1'}</div>
  <div class="center xs">Emissão: ${dataAut}</div>
  <div class="center xs">Via Consumidor</div>
  <div class="sep"></div>

  <!-- Chave de acesso -->
  <div class="center xs">Consulte pela Chave de Acesso em:</div>
  <div class="center xs bold">www.nfce.fazenda.sp.gov.br</div>
  <div class="chave center">${sale.nfceChave || ''}</div>
  <div class="sep"></div>

  <!-- QR Code -->
  ${qrImgUrl ? `<img src="${qrImgUrl}" class="qr" alt="QR Code NFC-e" width="180" height="180" />` : ''}

  <!-- Protocolo -->
  <div class="center xs">Protocolo de autorização:</div>
  <div class="center xs bold">${sale.nfceProtocolo || '—'}</div>
  <div class="sep"></div>

  <!-- Rodapé -->
  <div class="center sm bold">Obrigado pela preferência!</div>
  <div class="center xs">Volte sempre 💖</div>

  <script>
    // Espera o QR code carregar antes de imprimir
    window.onload = function() {
      var img = document.querySelector('img.qr');
      if (img && !img.complete) {
        img.onload = function() { setTimeout(function() { window.print(); }, 200); };
        img.onerror = function() { setTimeout(function() { window.print(); }, 200); };
      } else {
        setTimeout(function() { window.print(); }, 300);
      }
    };
  </script>
</body></html>`;

    // Abre popup com cupom + window.print() auto.
    // Vendedora escolhe ELGIN UMA VEZ no diálogo do Chrome → próximas vendas
    // o Chrome lembra a impressora e basta apertar Enter.
    const w = window.open('', 'nfce_print_' + sale.id, 'width=400,height=600');
    if (!w) {
      toast('warning', 'Popup bloqueado', 'Habilite popups pra esse site (ícone na barra de endereço do Chrome)');
      return;
    }
    w.document.write(html);
    w.document.close();
  }

  // Quando NFC-e fica autorizada (de não-autorizada → autorizada), imprime auto
  const lastPrintedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isAuthorized) return;
    if (!sale.nfceChave) return;
    // Só imprime UMA vez por chave (evita reimprimir se modal re-renderiza)
    if (lastPrintedRef.current === sale.nfceChave) return;
    lastPrintedRef.current = sale.nfceChave;
    // Pequeno delay pra garantir que o sale.nfceProtocolo já está populado
    setTimeout(() => imprimirDanfeNfce(), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, sale.nfceChave]);

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
              {/* Botão pra reimprimir cupom (caso popup tenha sido bloqueado
                  na primeira tentativa OU vendedora queira nova via) */}
              <button
                onClick={imprimirDanfeNfce}
                className="mt-2 w-full px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded flex items-center justify-center gap-2"
              >
                🖨️ Reimprimir cupom
              </button>
              <p className="text-[10px] text-emerald-700 text-center mt-1 leading-snug">
                Na 1ª venda do dia: escolhe <b>ELGIN</b> no diálogo. Chrome lembra → próximas vendas é só <b>Enter</b>.
              </p>
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

          {/* ─── Adicionar CPF na nota (só se ainda NÃO emitiu NFC-e) ─── */}
          {!isAuthorized && !isCancelled && (
            <CpfNaNotaInput sale={sale} onUpdated={(s) => setSale(s)} />
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

          {/* IMPRESSÃO CREDIÁRIO — só aparece se a venda tem pagamento crediário */}
          {hasCrediario && (
            <div className="bg-blue-50 border-2 border-blue-200 rounded p-3 space-y-2">
              <div className="text-xs font-bold text-blue-900 uppercase tracking-wider">
                🖨️ Imprimir crediário
              </div>
              <div className="text-[11px] text-blue-700">
                Carrega na impressora: <b>2 folhas brancas (promissória)</b> + <b>1 azul (carnê)</b> e clica abaixo.
              </div>
              <button
                onClick={() => imprimirCrediario('completo')}
                disabled={printingCred}
                className="w-full px-3 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-black rounded flex items-center justify-center gap-2 text-base"
              >
                {printingCred ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                Imprimir promissórias + carnê
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => imprimirCrediario('promissorias')}
                  disabled={printingCred}
                  className="px-2 py-2 bg-white hover:bg-blue-100 border-2 border-blue-300 disabled:opacity-50 text-blue-800 font-bold rounded text-xs flex items-center justify-center gap-1.5"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Só promissórias
                </button>
                <button
                  onClick={() => imprimirCrediario('carne')}
                  disabled={printingCred}
                  className="px-2 py-2 bg-white hover:bg-blue-100 border-2 border-blue-300 disabled:opacity-50 text-blue-800 font-bold rounded text-xs flex items-center justify-center gap-1.5"
                >
                  <FileText className="w-3.5 h-3.5" />
                  Só carnê
                </button>
              </div>
            </div>
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
  const { toast } = usePdvToast();
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
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
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

// ─── Logos das bandeiras (imagens oficiais em /public/bandeiras) ─────────
//
// Arquivos colocados pelo cliente em /frontend/public/bandeiras/:
//   MASTERCARD.png · CIELO.png · REDESHOP.png · VISA.webp
//   HIPERCARD.webp · AMERICAN.webp · ELO.webp
// VISANET e VISA ELECTRON reusam VISA.webp (mesma marca, label adicional).

const BANDEIRA_SRC: Record<string, string> = {
  MASTERCARD:       '/bandeiras/MASTERCARD.png',
  VISANET:          '/bandeiras/VISA.webp',
  'VISA ELECTRON':  '/bandeiras/VISA.webp',
  CIELO:            '/bandeiras/CIELO.png',
  HIPERCARD:        '/bandeiras/HIPERCARD.webp',
  AMEX:             '/bandeiras/AMERICAN.webp',
  REDESHOP:         '/bandeiras/REDESHOP.png',
  ELO:              '/bandeiras/ELO.webp',
};

function BandeiraLogo({ brand }: { brand: string }) {
  const src = BANDEIRA_SRC[brand];
  if (!src) {
    return <span className="text-xs font-bold text-slate-700">{brand}</span>;
  }
  // VISA ELECTRON usa logo VISA + sublabel ELECTRON pra distinguir do VISANET (crédito)
  if (brand === 'VISA ELECTRON') {
    return (
      <div className="flex flex-col items-center justify-center leading-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="Visa Electron" className="h-5 object-contain" />
        <span className="text-[8px] font-bold tracking-wider text-[#1A1F71] mt-0.5">
          ELECTRON
        </span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={brand}
      className="h-7 max-h-7 object-contain"
      loading="lazy"
    />
  );
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
// Cobrança PIX rápida da venda atual. Gera QR via Pagar.me/Stone e faz
// polling no /pagarme/pix/status/:saleId pra detectar pagamento confirmado
// SEM precisar a vendedora apertar "Recebi". Quando paid:
//   - Mostra tela "RECEBIDO!"
//   - Chama onPaid → parent registra pagamento + finaliza venda
//   - Auto-fecha em 1.5s
function PixAvulsoModal({
  saleId,
  defaultValor,
  onClose,
  onPaid,
}: {
  saleId: string | null;
  defaultValor?: number | null;
  onClose: () => void;
  /** Callback chamado quando webhook/polling confirma pagamento */
  onPaid?: (data: { valor: number; txid: string }) => void;
}) {
  const { toast } = usePdvToast();
  // Pré-popula com o total da venda atual (se houver itens) — evita digitar
  // valor errado. Format brasileiro: 23,90 (vírgula como separador decimal).
  const [valor, setValor] = useState(
    defaultValor && defaultValor > 0
      ? defaultValor.toFixed(2).replace('.', ',')
      : '',
  );
  const [loading, setLoading] = useState(false);
  const [qr, setQr] = useState<{ qrImage?: string; brcode?: string; txid?: string; valor?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);

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
      // Backend retorna { qrCodeDataUrl, payload, txid, valor, ... } — mapeia pros nomes do front.
      const qrImage = r?.qrCodeDataUrl || r?.qrImage;
      const brcode = r?.payload || r?.brcode;
      const txid = r?.txid;
      const valorBack = typeof r?.valor === 'number' ? r.valor : v;
      if (!qrImage && !brcode) {
        setError('Backend não retornou QR/payload. Verifique config PIX em /config/pagarme ou /config/pagbank.');
        return;
      }
      setQr({ qrImage, brcode, txid, valor: valorBack });
    } catch (e: any) {
      setError(e?.message || 'Falha ao gerar PIX');
    } finally {
      setLoading(false);
    }
  }

  // ── POLLING DE CONFIRMAÇÃO PAGAR.ME ──
  // A cada 1s pergunta /pagarme/pix/status/:saleId. O backend já consulta
  // ao vivo na Pagar.me se o status local ainda for pending — então não
  // depende do webhook. Quando paid, dispara onPaid + auto-fecha.
  useEffect(() => {
    if (!qr || paid || !saleId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api<{ found?: boolean; status: string; isPaid?: boolean }>(
          `/pagarme/pix/status/${saleId}`,
        );
        if (cancelled) return;
        if (r.isPaid || r.status === 'paid') {
          setPaid(true);
          toast('success', 'PIX RECEBIDO!', `${brl(qr.valor || 0)} confirmado pelo banco`);
          if (qr.txid && qr.valor) {
            onPaid?.({ valor: qr.valor, txid: qr.txid });
          }
          // Auto-fecha em 1.8s pra dar tempo da vendedora ver o feedback
          setTimeout(() => onClose(), 1800);
        }
      } catch {
        // silencioso — tenta de novo no próximo tick
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr, paid, saleId]);

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

        {/* TELA SUCESSO: PIX confirmado pelo Pagar.me */}
        {qr && paid && (
          <div className="text-center space-y-4 py-6">
            <div className="w-24 h-24 mx-auto rounded-full bg-emerald-500 flex items-center justify-center shadow-xl shadow-emerald-300/60 animate-pulse">
              <Check className="w-14 h-14 text-white" strokeWidth={3} />
            </div>
            <div>
              <div className="text-3xl font-black text-emerald-600 tracking-tight">RECEBIDO!</div>
              <div className="text-base text-slate-700 mt-1 font-bold tabular-nums">
                {brl(qr.valor || 0)}
              </div>
              <div className="text-xs text-slate-500 mt-1">Confirmado pelo banco</div>
            </div>
            <div className="text-xs text-slate-400 italic flex items-center justify-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Finalizando venda…
            </div>
          </div>
        )}

        {/* TELA QR (aguardando pagamento) */}
        {qr && !paid && (
          <div className="text-center space-y-3">
            {qr.qrImage && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.qrImage} alt="QR PIX" className="w-56 h-56 mx-auto border rounded-lg" />
            )}
            {/* Indicador de aguardando — conforto visual pra vendedora ver que o sistema TÁ MONITORANDO */}
            <div className="flex items-center justify-center gap-2 text-sm font-bold text-emerald-700">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
              Aguardando pagamento…
            </div>
            <div className="text-[11px] text-slate-500">
              A confirmação aparece automática quando o cliente pagar
            </div>
            {qr.brcode && (
              <div>
                <div className="text-xs text-slate-500 mb-1">Copia e Cola</div>
                <div className="bg-slate-100 rounded-lg p-2 text-[10px] font-mono break-all">
                  {qr.brcode}
                </div>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(qr.brcode!);
                    toast('success', 'Código PIX copiado', 'Cole no app do banco do cliente');
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

// ── PDV SIDEBAR CARD ──────────────────────────────────────────────────
// Card vertical da sidebar do PDV. Segue exatamente a paleta HUB_TONES
// (mesmas cores do /site, /loja, /retaguarda, /config) pra manter o sistema
// visualmente unificado. Suporta Link OU button (onClick), badge e pulse.
function PdvSidebarCard({
  tone,
  href,
  onClick,
  disabled,
  icon: Icon,
  subtitle,
  label,
  description,
  badge,
  pulse,
  compact,
}: {
  tone: HubTone;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  icon: LucideIcon;
  subtitle?: string;
  label: string;
  description?: string;
  badge?: number;
  pulse?: boolean;
  /** Compact: layout horizontal (icon esquerda, label direita) — pra ações secundárias */
  compact?: boolean;
}) {
  const t = HUB_TONES[tone];
  const baseClass = `relative overflow-hidden rounded-xl text-white shadow-sm hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 ${
    pulse ? 'ring-2 ring-rose-300 animate-pulse' : ''
  }`;
  const style = { background: `linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%)` };

  const inner = compact ? (
    // Compact: horizontal — ícone esquerda, label direita
    <div className="px-3 py-2.5 flex items-center gap-2.5">
      <Icon className="w-4 h-4 opacity-90 shrink-0" strokeWidth={2} />
      <span className="text-sm font-bold leading-none">{label}</span>
      {badge && badge > 0 && (
        <span className="ml-auto bg-white/95 text-slate-900 text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1.5 shadow">
          {badge}
        </span>
      )}
    </div>
  ) : (
    // Default: vertical estilo HubCard — icon top, subtitle, label, description
    <div className="px-3.5 py-3 flex flex-col gap-1">
      <div
        className="absolute -top-6 -right-6 w-20 h-20 rounded-full opacity-15 pointer-events-none"
        style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }}
      />
      <Icon className="w-5 h-5 opacity-90 relative" strokeWidth={1.7} />
      {subtitle && (
        <div className="text-[10px] font-bold tracking-wider uppercase opacity-90 relative">
          {subtitle}
        </div>
      )}
      <div className="text-base font-black leading-tight relative">{label}</div>
      {description && (
        <div className="text-[10px] opacity-85 leading-snug relative tabular-nums">{description}</div>
      )}
      {badge && badge > 0 && (
        <span className="absolute top-1.5 right-1.5 bg-white text-slate-900 text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1.5 shadow">
          {badge}
        </span>
      )}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className={baseClass} style={style}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${baseClass} text-left w-full`} style={style}>
      {inner}
    </button>
  );
}

// ── PDV MOBILE PILL ───────────────────────────────────────────────────
// Pílula compacta horizontal da bottom bar mobile. Usada no scroll
// horizontal acima do footer em telas pequenas (<lg).
function PdvMobilePill({
  tone,
  href,
  onClick,
  disabled,
  icon: Icon,
  label,
  badge,
}: {
  tone: HubTone;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  badge?: number;
}) {
  const t = HUB_TONES[tone];
  const cls = 'relative shrink-0 px-3 py-2 rounded-xl text-white font-bold text-xs flex items-center gap-1.5 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed';
  const style = { background: `linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%)` };
  const inner = (
    <>
      <Icon className="w-3.5 h-3.5" />
      {label}
      {badge && badge > 0 && (
        <span className="bg-white text-slate-900 text-[9px] font-black rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1">
          {badge}
        </span>
      )}
    </>
  );
  if (href) {
    return <Link href={href} className={cls} style={style}>{inner}</Link>;
  }
  return <button type="button" onClick={onClick} disabled={disabled} className={cls} style={style}>{inner}</button>;
}

// ── PRODUCT THUMB ─────────────────────────────────────────────────────
// Thumbnail do produto no carrinho do PDV. Busca a foto no WooCommerce
// via /pdv/product-image?sku=X (cache 1h no backend). Enquanto carrega,
// mostra avatar com inicial da REF. Se WC não tem foto, mantém o avatar.
const PRODUCT_IMG_CACHE = new Map<string, string | null>();
function ProductThumb({ sku, refCode }: { sku: string; refCode: string | null }) {
  const [url, setUrl] = useState<string | null | undefined>(
    PRODUCT_IMG_CACHE.has(sku) ? PRODUCT_IMG_CACHE.get(sku) : undefined,
  );
  useEffect(() => {
    if (!sku) return;
    if (PRODUCT_IMG_CACHE.has(sku)) {
      setUrl(PRODUCT_IMG_CACHE.get(sku));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ url: string | null }>(`/pdv/product-image?sku=${encodeURIComponent(sku)}`);
        if (!cancelled) {
          PRODUCT_IMG_CACHE.set(sku, r.url);
          setUrl(r.url);
        }
      } catch {
        if (!cancelled) {
          PRODUCT_IMG_CACHE.set(sku, null);
          setUrl(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sku]);

  const letter = (refCode || sku || '?').charAt(0).toUpperCase();

  if (url) {
    return (
      <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-100 border border-slate-200 shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={refCode || sku} className="w-full h-full object-cover" />
      </div>
    );
  }
  // Fallback: avatar gradiente com inicial
  return (
    <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-violet-400 to-fuchsia-500 flex items-center justify-center text-white font-black text-lg shadow-sm shrink-0">
      {letter}
    </div>
  );
}

// ── PDV OUTLINE PILL ──────────────────────────────────────────────────
// Pílula compacta outline pra ações secundárias da sidebar (Caixa, Trocar,
// Pausadas, Realinhar). Visual neutro (branco com borda slate) — não compete
// com os 4 cards coloridos primários. Suporta badge e flag de atenção.
function PdvOutlinePill({
  href,
  onClick,
  disabled,
  icon: Icon,
  label,
  badge,
  attention,
}: {
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  badge?: number;
  attention?: boolean;
}) {
  // Pílulas brancas com sombra forte pra "saltar" do fundo roxo do PDV
  const cls = `relative px-3 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-md ${
    attention
      ? 'bg-rose-100 border border-rose-300 text-rose-800 hover:bg-rose-200'
      : 'bg-white border border-white text-violet-900 hover:bg-amber-50'
  }`;
  const inner = (
    <>
      <Icon className={`w-4 h-4 ${attention ? 'text-rose-700' : 'text-violet-600'}`} />
      <span className="flex-1 text-left">{label}</span>
      {badge && badge > 0 && (
        <span className={`text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1.5 ${
          attention ? 'bg-rose-600 text-white' : 'bg-violet-700 text-white'
        }`}>
          {badge}
        </span>
      )}
    </>
  );
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  return <button type="button" onClick={onClick} disabled={disabled} className={cls}>{inner}</button>;
}

// ── SIMULADOR DE PARCELAMENTO CARTÃO ──────────────────────────────────
// Mostra pra cliente quanto fica cada parcela de 1× a 12×, SEMPRE SEM JUROS.
// Vendedora fala em voz alta pra cliente "fica 5× de R$ 31,04". A tela cabe
// todas as 12 parcelas em grade 2 colunas — sem scroll, sem configuração.
function SimularParcelasModal({
  total,
  onClose,
}: {
  total: number;
  onClose: () => void;
}) {
  const parcelas = Array.from({ length: 12 }, (_, idx) => idx + 1);
  const valorParcela = (n: number) => total / n;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl w-full max-w-md p-3 space-y-2 max-h-[95vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header compacto */}
        <div className="flex items-center justify-between">
          <h2 className="font-black text-base text-amber-700 flex items-center gap-1.5">
            <CreditCard className="w-4 h-4" /> Simular parcelamento
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        {/* Total da venda — referência compacta pra cliente */}
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center justify-between">
          <span className="text-[10px] text-emerald-700 font-bold uppercase tracking-wide">Total da venda</span>
          <span className="text-xl font-black text-emerald-700 tabular-nums">{brl(total)}</span>
        </div>

        {/* CASCATA SUPER COMPACTA — 12 linhas finas, cabem todas na tela sem scroll.
            Cada linha: [Nx pílula] [SEM JUROS / À VISTA] [valor]. Click copia pro WhatsApp. */}
        <div className="flex flex-col gap-1">
          {parcelas.map((n) => {
            const valor = valorParcela(n);
            return (
              <button
                key={n}
                type="button"
                onClick={() => {
                  const txt = n === 1
                    ? `À vista R$ ${valor.toFixed(2).replace('.', ',')}`
                    : `${n}× de R$ ${valor.toFixed(2).replace('.', ',')} sem juros`;
                  navigator.clipboard.writeText(txt).catch(() => {});
                }}
                title="Clique pra copiar texto pra WhatsApp"
                className="group flex items-center gap-2.5 bg-white hover:bg-amber-50 border border-slate-200 hover:border-amber-400 rounded-md px-2.5 py-1.5 transition"
              >
                <span className="inline-flex items-center justify-center min-w-[40px] h-7 px-1 rounded-md bg-amber-100 group-hover:bg-amber-200 font-black text-sm text-amber-800 tabular-nums shrink-0 transition">
                  {n}×
                </span>
                <span className="text-[10px] font-bold text-emerald-600 tracking-wide shrink-0 w-[60px] text-left">
                  {n === 1 ? 'À VISTA' : 'SEM JUROS'}
                </span>
                <span className="flex-1 text-right font-black text-base text-emerald-700 tabular-nums truncate">
                  {brl(valor)}
                </span>
                <span className="text-amber-500 opacity-0 group-hover:opacity-100 transition text-[10px] font-bold shrink-0 w-10 text-right">
                  copiar
                </span>
              </button>
            );
          })}
        </div>

        {/* Dica compacta */}
        <div className="text-center text-[10px] text-slate-400 italic">
          💡 Clique numa parcela pra copiar texto pro WhatsApp
        </div>
      </div>
    </div>
  );
}

// ── DISCOUNT MODAL ────────────────────────────────────────────────────
// Modal de desconto unificado — usado pra venda inteira e por item.
// Vendedora digita % e o R$ é calculado automaticamente. Pode editar o R$
// pra arredondar (ex: cálculo deu 9,34 e ela ajusta pra 9,00). Os 2 campos
// ficam SINCRONIZADOS: digitou em um, atualiza o outro.
function DiscountModal({
  base,
  atual,
  label,
  onClose,
  onApply,
}: {
  /** Valor bruto sobre o qual o desconto é aplicado (subtotal/preço bruto) */
  base: number;
  /** Desconto atual em R$ */
  atual: number;
  /** Texto descritivo: "venda inteira" / "deste item" */
  label: string;
  onClose: () => void;
  onApply: (valor: number) => void;
}) {
  const initialPct = base > 0 ? (atual / base) * 100 : 0;
  const [pctStr, setPctStr] = useState(initialPct ? initialPct.toFixed(1).replace('.', ',') : '');
  const [reaisStr, setReaisStr] = useState(atual ? atual.toFixed(2).replace('.', ',') : '');
  const [error, setError] = useState<string | null>(null);

  // Helpers de parsing
  const parseNum = (s: string) => {
    const n = Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  };

  // Quando muda %, recalcula R$
  const onPctChange = (v: string) => {
    setPctStr(v);
    setError(null);
    const pct = parseNum(v);
    if (pct == null) return;
    const reais = Math.max(0, Math.min(base, (base * pct) / 100));
    setReaisStr(reais.toFixed(2).replace('.', ','));
  };

  // Quando muda R$, recalcula %
  const onReaisChange = (v: string) => {
    setReaisStr(v);
    setError(null);
    const reais = parseNum(v);
    if (reais == null) return;
    const pct = base > 0 ? (reais / base) * 100 : 0;
    setPctStr(pct.toFixed(1).replace('.', ','));
  };

  const aplicar = () => {
    const reais = parseNum(reaisStr);
    if (reais == null || reais < 0) {
      setError('Valor inválido — use só números');
      return;
    }
    if (reais > base + 0.01) {
      setError(`Desconto maior que o valor bruto (${brl(base)})`);
      return;
    }
    onApply(Math.round(reais * 100) / 100);
  };

  const valorFinal = Math.max(0, base - (parseNum(reaisStr) || 0));

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-black text-lg text-amber-700 flex items-center gap-2">
            <Percent className="w-5 h-5" /> Aplicar desconto
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <div className="text-xs text-slate-500">
          Desconto {label} · Bruto <span className="font-bold tabular-nums text-slate-700">{brl(base)}</span>
        </div>

        {/* Inputs lado a lado: % | R$ */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
              Porcentagem
            </label>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                value={pctStr}
                onChange={(e) => onPctChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && aplicar()}
                placeholder="0"
                className="w-full px-3 py-3 pr-9 text-2xl font-bold tabular-nums text-amber-700 border-2 border-amber-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-300 focus:border-amber-400"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-amber-500 font-bold">%</span>
            </div>
          </div>
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
              Em reais (editável)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">R$</span>
              <input
                type="text"
                inputMode="decimal"
                value={reaisStr}
                onChange={(e) => onReaisChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && aplicar()}
                placeholder="0,00"
                className="w-full px-3 py-3 pl-10 text-2xl font-bold tabular-nums text-emerald-700 border-2 border-emerald-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:border-emerald-400"
              />
            </div>
          </div>
        </div>

        {/* Sugestões rápidas — atalhos comuns no PDV */}
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider self-center mr-1">Atalhos:</span>
          {[5, 10, 15, 20, 30, 50].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPctChange(String(p))}
              className="px-2.5 py-1 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 text-xs font-bold rounded-lg transition"
            >
              {p}%
            </button>
          ))}
        </div>

        {/* Preview do valor final */}
        <div className="bg-slate-50 rounded-xl p-3 flex items-center justify-between">
          <span className="text-xs text-slate-500 font-bold uppercase tracking-wide">Vai pagar</span>
          <span className="text-2xl font-black text-emerald-600 tabular-nums">{brl(valorFinal)}</span>
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 p-2 rounded text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onClose}
            className="px-4 py-3 border-2 border-slate-300 text-slate-700 font-bold rounded-xl hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            onClick={aplicar}
            className="px-4 py-3 text-white font-black rounded-xl shadow-md transition"
            style={{ background: `linear-gradient(135deg, ${HUB_TONES.amber.from}, ${HUB_TONES.amber.to})` }}
          >
            Aplicar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── MANUAL ITEM MODAL ─────────────────────────────────────────────────
// Quando o produto não passa pelo bipe (cadastro errado, EAN ausente, etc),
// vendedora digita "0" no input → abre este modal pra lançar item manual
// com descrição e valor livres. Não trava o caixa.
function ManualItemModal({
  saleId,
  onClose,
  onAdded,
}: {
  saleId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { toast } = usePdvToast();
  const [descricao, setDescricao] = useState('');
  const [valor, setValor] = useState('');
  const [qty, setQty] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseNum = (s: string) => {
    const n = Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  };

  const adicionar = async () => {
    setError(null);
    if (descricao.trim().length < 2) {
      setError('Descreva o produto (ex: "Brinco prata", "Camisa azul P")');
      return;
    }
    const v = parseNum(valor);
    if (v == null || v <= 0) {
      setError('Valor inválido — use só números (ex: 49,90)');
      return;
    }
    const q = Number(qty);
    if (!q || q < 1 || !Number.isInteger(q)) {
      setError('Quantidade deve ser número inteiro ≥ 1');
      return;
    }
    setSaving(true);
    try {
      await api(`/pdv/sales/${saleId}/items/manual`, {
        method: 'POST',
        body: JSON.stringify({ descricao: descricao.trim(), valor: v, qty: q }),
      });
      onAdded();
    } catch (e: any) {
      const h = humanizeError(e);
      setError(`${h.title}${h.hint ? ' · ' + h.hint : ''}`);
    } finally {
      setSaving(false);
    }
  };

  const total = (parseNum(valor) || 0) * (Number(qty) || 0);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-black text-lg text-rose-700 flex items-center gap-2">
            <FileText className="w-5 h-5" /> Item Manual
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[11px] text-amber-800 leading-snug">
          ⚠️ Use só quando o produto não passa pelo bipe. Não atualiza estoque no Gigasistemas.
        </div>

        <div>
          <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
            Descrição
          </label>
          <input
            type="text"
            autoFocus
            value={descricao}
            onChange={(e) => setDescricao(e.target.value.slice(0, 80))}
            onKeyDown={(e) => e.key === 'Enter' && document.getElementById('manual-valor')?.focus()}
            placeholder="Ex: Brinco prata · Camisa P azul"
            className="w-full px-3 py-3 text-base font-medium border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-300 focus:border-rose-400"
          />
          <div className="text-[10px] text-slate-400 text-right mt-0.5">
            {descricao.length}/80
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
              Valor unitário
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">R$</span>
              <input
                id="manual-valor"
                type="text"
                inputMode="decimal"
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && adicionar()}
                placeholder="0,00"
                className="w-full px-3 py-3 pl-10 text-xl font-bold tabular-nums text-emerald-700 border-2 border-emerald-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:border-emerald-400"
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
              Quantidade
            </label>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && adicionar()}
              className="w-full px-3 py-3 text-xl font-bold tabular-nums text-slate-800 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-300 focus:border-rose-400"
            />
          </div>
        </div>

        <div className="bg-slate-50 rounded-xl p-3 flex items-center justify-between">
          <span className="text-xs text-slate-500 font-bold uppercase tracking-wide">Total do item</span>
          <span className="text-2xl font-black text-emerald-600 tabular-nums">{brl(total)}</span>
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 p-2 rounded text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-3 border-2 border-slate-300 text-slate-700 font-bold rounded-xl hover:bg-slate-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={adicionar}
            disabled={saving}
            className="px-4 py-3 text-white font-black rounded-xl shadow-md transition disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ background: `linear-gradient(135deg, ${HUB_TONES.rose.from}, ${HUB_TONES.rose.to})` }}
          >
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />}
            Adicionar
          </button>
        </div>
      </div>
    </div>
  );
}
