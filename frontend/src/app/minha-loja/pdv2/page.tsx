'use client';

/**
 * /minha-loja/pdv2 — Frente de caixa — PDV V2 (VERSÃO DE TESTE).
 *
 * Cópia paralela de /minha-loja/pdv com melhorias de UX (atalhos F8/Del/F12,
 * flash na bipagem, guard de duplo clique, barra de atalhos). Subpáginas
 * (caixa, devolucao, recibo etc.) continuam apontando pras rotas ORIGINAIS
 * /minha-loja/pdv/...
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

import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowLeft, Loader2, X, Barcode, ArrowRight, Trash2, Plus, Minus,
  ShoppingCart, User, CreditCard, Banknote, QrCode, Check, AlertCircle,
  AlertTriangle,
  Send, Mail, MessageSquare, FileText, RotateCcw, History, Percent,
  Clock, ChevronRight, Pause, DollarSign, ArrowRightLeft, Search, Sparkles,
  Receipt, Globe, Shuffle, Tag, Wallet, ArrowUpRight, Printer,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { PdvToastProvider, usePdvToast, humanizeError } from '@/components/PdvToast';
import ValeTrocaModal from './ValeTrocaModal';
import { HUB_TONES, type HubTone } from '@/components/HubCard';
import StorePickOrderAlert from '@/components/StorePickOrderAlert';
import TrainingModeBanner from '@/components/TrainingModeBanner';
import TrainingModeButton from '@/components/TrainingModeButton';

/**
 * Helper pro backdrop dos modais:
 * Só fecha se o mousedown E o click final foram NO BACKDROP (não no conteúdo).
 *
 * Antes: arrastar pra selecionar texto e soltar o mouse fora do modal fechava
 * a janela e perdia tudo. Agora o backdrop é "smart" — drag de dentro pra fora
 * não conta como click.
 *
 * Uso:
 *   const close = useSmartBackdropClose(onClose);
 *   <div onMouseDown={close.onMouseDown} onClick={close.onClick}>...</div>
 */
function useSmartBackdropClose(onClose: () => void) {
  const startedOnBackdropRef = useRef(false);
  return {
    onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => {
      startedOnBackdropRef.current = e.target === e.currentTarget;
    },
    onClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && startedOnBackdropRef.current) {
        onClose();
      }
      startedOnBackdropRef.current = false;
    },
  };
}

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
  // Endereço (essencial pra venda online: WhatsApp/Instagram)
  customerCep?: string | null;
  customerEndereco?: string | null;
  customerNumero?: string | null;
  customerComplemento?: string | null;
  customerBairro?: string | null;
  customerCidade?: string | null;
  customerUf?: string | null;
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
  // Venda Online — WhatsApp/Instagram: pagamento já chegou na conta da loja.
  // PDV só registra a venda (histórico + comissão + estoque). Sem geração de
  // QR/cobrança, sem NFC-e automática. CPF obrigatório.
  { id: 'venda_online', label: 'Venda Online', icon: Globe },
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
      {/*
        Alerta de novo pedido do site (substitui notificação WhatsApp).
        Modal proeminente + som em loop + persistência localStorage.
        Funciona via WebSocket pick-order:new + polling fallback 20s.
      */}
      <StorePickOrderAlert />
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

  // ── BUSCA INLINE POR DESCRICAO ──
  // Quando vendedora digita texto (nao codigo de barras), aparece dropdown
  // com sugestoes do Giga em tempo real. Click adiciona ao carrinho.
  type ErpSearchHit = {
    CODIGO: string;
    REF: string;
    DESCRICAOCOMPLETA?: string;
    COR?: string | null;
    TAMANHO?: string | null;
    ESTOQUE?: number;       // legado — alias de qtyMyStore
    qtyMyStore?: number;    // estoque na loja do usuario
    qtyTotal?: number;      // estoque total da rede (todas lojas)
  };
  const [searchResults, setSearchResults] = useState<ErpSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);
  const [scanLoading, setScanLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // SKU pendente quando vendedora ainda nao foi escolhida — bipe fica em
  // espera. Apos saveVendedora, dispara handleScan automatico com esse SKU
  // (vendedora nao precisa voltar e clicar de novo na setinha).
  const pendingScanRef = useRef<string | null>(null);
  // PDV2: finalize pendente quando vendedora ainda nao foi escolhida.
  // A vendedora agora é exigida no ENCERRAMENTO da venda (nao no 1º bip,
  // pra liberar a cliente mais rapido). Apos saveVendedora, o finalize
  // é retomado automaticamente com os mesmos argumentos.
  const pendingFinalizeRef = useRef<{ paymentMethod: string; paymentDetails?: any } | null>(null);

  // ── AUTO-FIT: escala a UI inteira pro tamanho do monitor ──
  // Design-base: 1700px de largura. Monitor menor → zoom proporcional menor
  // (1366px → ~0.80); maior → até 1.1. Sem config por loja, recalcula em
  // resize. Abaixo de 1024px (tablet/celular) não aplica — breakpoints
  // responsivos do Tailwind assumem.
  const [uiZoom, setUiZoom] = useState(1);
  useEffect(() => {
    const calcZoom = () => {
      const w = window.innerWidth;
      if (w < 1024) { setUiZoom(1); return; }
      const z = Math.min(1.1, Math.max(0.7, w / 1700));
      setUiZoom(Math.round(z * 100) / 100);
    };
    calcZoom();
    window.addEventListener('resize', calcZoom);
    return () => window.removeEventListener('resize', calcZoom);
  }, []);

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
  // ── PDV2: overlay de ajuda de atalhos (F12 ou ?) ──
  const [showShortcuts, setShowShortcuts] = useState(false);
  // ── PDV2: flash visual no item recém-bipado (fundo verde ~600ms) ──
  const [lastAddedItemId, setLastAddedItemId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── Modal de Desconto (% ou R$) — venda inteira ou item ──
  // (PDV2: declarado AQUI — antes do handler global de teclado — pra evitar
  // TDZ ao referenciar showDiscount nas deps do useEffect de atalhos)
  const [showDiscount, setShowDiscount] = useState<
    | null
    | { kind: 'sale' }
    | { kind: 'item'; itemId: string; bruto: number; atual: number }
  >(null);
  // Ref SINCRONO pra guard de double-fire em finalizeSale (setFinalizing é
  // async — só vira true no proximo render, deixa janela pra 2a chamada
  // passar). Resetado no finally.
  const finalizingRef = useRef(false);

  // Quando true, o filho (PaymentModal) confirmou PIX automaticamente via webhook/polling.
  // Após finalizeSale, em vez de mostrar a tela "Venda finalizada", o PDV
  // imprime + abre nova venda direto (fluxo full-auto pra caixa não travar).
  const autoFlowRef = useRef(false);

  // ── Load lojas + DETERMINA STORE CORRETA ──
  // CRÍTICO: pra user role=store, o storeCode é FIXO no JWT (loja da vendedora).
  // Não pode usar localStorage stale — se outro user da loja X tiver usado o PC,
  // o localStorage pode ter store antigo e a vendedora atual ia vender pro
  // estoque/caixa errado. Pra admin/operator, deixa escolher pelo localStorage.
  useEffect(() => {
    (async () => {
      try {
        const [arr, me] = await Promise.all([
          api<Store[]>('/stores'),
          api<{ role: string; storeCode?: string | null }>('/auth/me').catch(() => null as any),
        ]);
        const ativas = arr.filter((s) => s.active).sort((a, b) => a.code.localeCompare(b.code));
        setStores(ativas);

        // 1) Se user é STORE, FORÇA loja dele (ignora localStorage)
        if (me?.role === 'store' && me?.storeCode) {
          const userStore = ativas.find((s) => s.code === me.storeCode);
          if (userStore) {
            setStoreCode(userStore.code);
            try { localStorage.setItem('lurds_pdv_store', userStore.code); } catch {}
            return;
          }
        }

        // 2) Admin/operator: restaura do localStorage se existir
        const saved = typeof window !== 'undefined' ? localStorage.getItem('lurds_pdv_store') : null;
        if (saved && ativas.find((s) => s.code === saved)) {
          setStoreCode(saved);
        } else if (ativas.length === 1) {
          setStoreCode(ativas[0].code);
        }
      } catch {
        setError('Erro ao carregar lojas');
      }
    })();
  }, []);

  // Salva store escolhida + abre venda
  useEffect(() => {
    if (!storeCode) return;
    try {
      localStorage.setItem('lurds_pdv_store', storeCode);
    } catch {
      /* noop */
    }

    // PRIORIDADE 1: venda vinda de /pdv/marcados (botao "Puxar pra venda").
    let retomarPuxado: string | null = null;
    try { retomarPuxado = localStorage.getItem('lurds_pdv_retomar_sale_id'); } catch {}
    if (retomarPuxado) {
      try { localStorage.removeItem('lurds_pdv_retomar_sale_id'); } catch {}
      api<Sale>(`/pdv/sales/${retomarPuxado}`)
        .then((s) => {
          if (s.status === 'open' && s.storeCode === storeCode) {
            setSale(s);
            try { localStorage.setItem(`lurds_pdv_sale_${storeCode}`, s.id); } catch {}
          } else {
            const lastSaleId = localStorage.getItem(`lurds_pdv_sale_${storeCode}`);
            if (lastSaleId) {
              api<Sale>(`/pdv/sales/${lastSaleId}`).then((sx) => {
                if (sx.status === 'open' && sx.storeCode === storeCode) setSale(sx);
                else { localStorage.removeItem(`lurds_pdv_sale_${storeCode}`); createNewSale(); }
              }).catch(() => { localStorage.removeItem(`lurds_pdv_sale_${storeCode}`); createNewSale(); });
            } else {
              createNewSale();
            }
          }
        })
        .catch(() => createNewSale());
      return;
    }

    // PRIORIDADE 2: venda OPEN salva no localStorage
    const lastSaleId = localStorage.getItem(`lurds_pdv_sale_${storeCode}`);
    if (lastSaleId) {
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

  // PDV2: o confirm() de "vendedora não escolhida" ao abrir pagamento foi
  // REMOVIDO — a vendedora agora é exigida no ENCERRAMENTO (gate no
  // finalizeSale), com retomada automática após escolher. Bipagem e
  // pagamento fluem sem interrupção pra liberar a cliente mais rápido.

  // Listener global: qualquer tecla redireciona pro input + atalhos PDV
  useEffect(() => {
    if (!sale || sale.status !== 'open') return;
    const anyModal =
      showCustomer || showPayment || showFinalized || showVendedora ||
      !!showDiscount || showShortcuts;
    const handler = (e: KeyboardEvent) => {
      // ── PDV2: Esc fecha modais — roda ANTES do early-return de modal
      // (no PDV v1 o listener inteiro era desativado com modal aberto) ──
      if (e.key === 'Escape') {
        if (showShortcuts) { e.preventDefault(); setShowShortcuts(false); return; }
        if (showDiscount) { e.preventDefault(); setShowDiscount(null); return; }
        if (showCustomer) { e.preventDefault(); setShowCustomer(false); return; }
        if (showVendedora) { e.preventDefault(); setShowVendedora(false); return; }
        // sem modal aberto → cai no comportamento original (bloco Escape abaixo)
      }
      // ── PDV2: F12 abre/fecha overlay de atalhos (funciona sempre) ──
      if (e.key === 'F12') {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      // Com modal aberto, demais atalhos ficam desativados (igual PDV v1)
      if (anyModal) return;
      // ── PDV2: ? também abre a ajuda (só fora de campos de texto) ──
      if (e.key === '?') {
        const ae = document.activeElement as HTMLElement | null;
        const editing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
        if (!editing) {
          e.preventDefault();
          setShowShortcuts(true);
          return;
        }
      }
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
      // F3 → tela de Caixa (sangria, suprimento, retiradas)
      if (e.key === 'F3') {
        e.preventDefault();
        window.location.href = '/minha-loja/pdv/caixa';
        return;
      }
      // F4 → tela de TROCA / Devolução (atalho rápido pro fluxo de troca)
      if (e.key === 'F4') {
        e.preventDefault();
        // Salva a venda em andamento pra que a troca seja ANEXADA nela (não cria
        // nova venda). Ler em /pdv/devolucao via localStorage.getItem.
        try {
          if (sale?.id) localStorage.setItem('lurds_pdv_attach_to_sale_id', JSON.stringify({ id: sale.id, ts: Date.now(), items: sale.items?.length || 0 }));
          else localStorage.removeItem('lurds_pdv_attach_to_sale_id');
        } catch {}
        window.location.href = '/minha-loja/pdv/devolucao';
        return;
      }
      // F6 → identificar/trocar cliente (CPF/nome)
      // Não usamos F5 porque o navegador reserva pra reload e preventDefault
      // não cancela em todos os browsers.
      if (e.key === 'F6') {
        e.preventDefault();
        setShowCustomer(true);
        return;
      }
      // F9 → escolher/trocar vendedora (atendente)
      if (e.key === 'F9') {
        e.preventDefault();
        setShowVendedora(true);
        return;
      }
      // F10 → consultar produto (estoque/preço/foto)
      if (e.key === 'F10') {
        e.preventDefault();
        window.location.href = '/minha-loja/consultar';
        return;
      }
      // ── PDV2: F8 → abrir tela de pagamento (só com itens no carrinho) ──
      if (e.key === 'F8') {
        e.preventDefault();
        if (sale.items?.length > 0) {
          setPaymentFilter('all');
          setShowPayment(true);
        }
        return;
      }
      // ── PDV2: Del → remove o ÚLTIMO item bipado do carrinho ──
      // Guard: se um campo de texto COM conteúdo está focado (qty, busca...),
      // deixa o Del agir no campo. Só remove item com input de bipe vazio /
      // nada editável em foco.
      if (e.key === 'Delete') {
        const ae = document.activeElement as HTMLElement | null;
        const editing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
        const scanVazio = ae === inputRef.current && !scanInput.trim();
        if (editing && !scanVazio) return;
        if (sale.items?.length > 0) {
          e.preventDefault();
          removeItem(sale.items[sale.items.length - 1].id);
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
    // PDV2: removeItem fica fora das deps de propósito — é recriada a cada
    // render e o handler já é re-registrado quando `sale` muda (captura fresca).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale, showCustomer, showPayment, showFinalized, showVendedora, showDiscount, showShortcuts, scanInput]);

  // ── PDV2: marca o item recém-adicionado pra dar flash verde (~600ms) ──
  // Detecta por diff: item NOVO (id que não existia) ou qty incrementada.
  const flashAddedItem = (prevItems: Sale['items'], freshItems: Sale['items']) => {
    const added =
      freshItems.find((i) => !prevItems.some((p) => p.id === i.id)) ||
      freshItems.find((i) => {
        const p = prevItems.find((pp) => pp.id === i.id);
        return !!p && i.qty > p.qty;
      });
    if (!added) return;
    setLastAddedItemId(added.id);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setLastAddedItemId(null), 600);
  };

  // ── Bipagem ──
  const handleScan = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!sale) return;
    const sku = scanInput.trim();
    if (!sku) return;
    // PDV2: gate de vendedora no 1º bipe REMOVIDO — vendedora é exigida
    // no ENCERRAMENTO da venda (gate no finalizeSale). Bipagem flui direto.
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
      // ── PDV2: flash verde no item recém-adicionado (novo OU qty incrementada) ──
      flashAddedItem(sale.items || [], fresh.items || []);
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

  // ── Adiciona peca direto por SKU (usado pelo dropdown de busca) ──
  const addBySku = useCallback(async (sku: string) => {
    if (!sale) return;
    // PDV2: gate de vendedora removido daqui — exigida só no finalizeSale.
    setShowResults(false);
    setSearchResults([]);
    setScanLoading(true);
    setError(null);
    try {
      await api(`/pdv/sales/${sale.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ skuOrEan: sku }),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      // ── PDV2: flash verde também quando adiciona pelo dropdown de busca ──
      flashAddedItem(sale.items || [], fresh.items || []);
      setSale(fresh);
      setScanInput('');
    } catch (e: any) {
      setError(e?.message || 'Erro ao adicionar');
    } finally {
      setScanLoading(false);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
    }
  }, [sale, toast]);

  // ── Effect: busca inline com debounce ──
  // Se digitar texto (com letra), busca por descricao no Giga.
  // Se digitar so numero pequeno (3-6 digitos = REF curta), tambem busca.
  // Numeros >=7 digitos (CODIGO Wincred / EAN) NAO acionam dropdown — sao bipados direto
  // (evita conflito: bipe de 7 dig usado pra abrir dropdown E enviar pro handleScan).
  useEffect(() => {
    const term = scanInput.trim();
    const hasLetter = /[a-zA-ZÀ-ÿ]/.test(term);
    const isShortNumeric = /^\d{3,6}$/.test(term);
    // 3+ chars com letra OU 3-6 digitos (REF) abrem busca
    if (term.length < 3 || (!hasLetter && !isShortNumeric)) {
      setSearchResults([]);
      setShowResults(false);
      setHighlightedIdx(-1);
      return;
    }
    const t = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await api<ErpSearchHit[]>(`/products/erp-search?q=${encodeURIComponent(term)}`);
        const arr = Array.isArray(res) ? res : [];
        setSearchResults(arr);
        setShowResults(arr.length > 0);
        setHighlightedIdx(arr.length > 0 ? 0 : -1);
      } catch {
        setSearchResults([]);
        setShowResults(false);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [scanInput]);

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

  // ── Links Pagar.me aguardando pagamento (widget global) ──
  // Polling a cada 15s lista vendas pausadas com Link Pagar.me. Quando
  // alguma vira paid, alerta sonoro + visual + a vendedora finaliza.
  const [onlinePending, setOnlinePending] = useState<Array<{
    saleId: string;
    saleCode: string;
    saleStatus: string;
    customerName: string | null;
    customerCpf: string | null;
    customerPhone: string | null;
    sellerName: string | null;
    total: number;
    pagarmeOrderId: string;
    paymentUrl: string | null;
    status: string;
    paidAt: string | null;
    createdAt: string;
  }>>([]);
  const [showOnlinePending, setShowOnlinePending] = useState(false);
  // Set dos saleIds já notificados — evita tocar som 2x pro mesmo pagamento
  const notifiedPaidRef = useRef<Set<string>>(new Set());
  const [showPixAvulso, setShowPixAvulso] = useState(false);
  const [showValeTroca, setShowValeTroca] = useState(false);
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
      // Não conta a venda ATUAL (que também é open) nem vendas FANTASMAS
      // (carrinho vazio — vendedora abriu o PDV e nao bipou nada, acumula).
      const others = list.filter((s) => s.id !== sale?.id && (s.items?.length || 0) > 0);
      setOpenCount(others.length);
    } catch {
      setOpenCount(0);
    }
  };
  useEffect(() => {
    if (storeCode) loadOpenCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCode, sale?.id]);

  // ── Polling Links Pagar.me pendentes (a cada 15s) ──
  // Quando o cliente paga, o webhook do Pagar.me atualiza o status no banco.
  // O polling pega esse status e dispara alerta sonoro + visual no header pra
  // vendedora finalizar a venda. Roda enquanto o PDV estiver aberto.
  const loadOnlinePending = async () => {
    if (!storeCode) return;
    try {
      const list = await api<typeof onlinePending>(
        `/pagarme/online-pending?storeCode=${storeCode}`,
      );
      setOnlinePending(Array.isArray(list) ? list : []);
      // Detecta novos paid e notifica (toca som + toast)
      for (const item of list) {
        if (item.status === 'paid' && !notifiedPaidRef.current.has(item.saleId)) {
          notifiedPaidRef.current.add(item.saleId);
          // Som de alerta — usa WebAudio pra garantir que toca
          try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = 880; // Lá agudo
            gain.gain.value = 0.3;
            osc.start();
            setTimeout(() => { osc.frequency.value = 1320; }, 150);
            setTimeout(() => { osc.stop(); ctx.close(); }, 450);
          } catch { /* sem som não bloqueia */ }
          toast(
            'success',
            `💰 Cliente pagou — ${item.customerName || 'Sem nome'}`,
            `Venda #${item.saleCode} (${brl(item.total)}) está pronta pra finalizar`,
          );
        }
      }
    } catch {
      // silencioso
    }
  };
  useEffect(() => {
    if (!storeCode) return;
    loadOnlinePending();
    const id = setInterval(loadOnlinePending, 15000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCode]);

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

      // AUTO-BIPE: se tem um SKU pendente (vendedora bipou antes de escolher
      // vendedora), faz o POST direto na API (sem passar pelo handleScan que
      // leria scanInput stale via closure). Vendedora nao precisa voltar pra
      // apertar a setinha — a peça entra direto no carrinho.
      const pending = pendingScanRef.current;
      if (pending) {
        pendingScanRef.current = null;
        setScanInput('');
        try {
          await api(`/pdv/sales/${sale.id}/items`, {
            method: 'POST',
            body: JSON.stringify({ skuOrEan: pending }),
          });
          const fresh2 = await api<Sale>(`/pdv/sales/${sale.id}`);
          setSale(fresh2);
          toast('success', 'Peça adicionada', `${pending} entrou no carrinho`);
        } catch (e: any) {
          const h = humanizeError(e);
          toast('error', `Falha ao adicionar ${pending}`, h.hint || h.title);
        }
        setTimeout(() => inputRef.current?.focus(), 50);
      }

      // PDV2: AUTO-FINALIZE — se o operador tentou fechar a venda sem
      // vendedora, o finalize ficou pendente; retoma agora automaticamente
      // (skipSellerGate: o `sale` na closure do finalizeSale ainda é o
      // stale sem sellerName — o backend já tem a vendedora gravada).
      const pendingFin = pendingFinalizeRef.current;
      if (pendingFin) {
        pendingFinalizeRef.current = null;
        await finalizeSale(pendingFin.paymentMethod, pendingFin.paymentDetails, { skipSellerGate: true });
      }
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
    }
  };

  // ── Cliente ──
  const saveCustomer = async (data: {
    cpf: string;
    name: string;
    email: string;
    phone: string;
    cep?: string;
    endereco?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
  }) => {
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
  const finalizeSale = async (paymentMethod: string, paymentDetails?: any, opts?: { skipSellerGate?: boolean }) => {
    if (!sale) return;
    // PDV2: vendedora OBRIGATÓRIA no ENCERRAMENTO (não no 1º bip).
    // Sem vendedora: salva o finalize pendente, abre o modal e retoma
    // automaticamente após a escolha (skipSellerGate evita loop na retomada).
    if (!sale.sellerName && !opts?.skipSellerGate) {
      pendingFinalizeRef.current = { paymentMethod, paymentDetails };
      toast('warning', 'Escolha a vendedora pra fechar a venda', 'Após confirmar, a venda finaliza automaticamente.');
      setShowVendedora(true);
      return;
    }
    // GUARD SINCRONO contra double-fire: ref muda IMEDIATAMENTE (antes do
    // setFinalizing(true) que so reflete no proximo render). Cobre o cenario
    // de auto-finalize via setTimeout(80ms) + click manual no botao Finalizar
    // disparando quase ao mesmo tempo — segundo disparo é ignorado aqui em
    // vez de chegar no backend e tomar 400 "Venda ja esta finalized".
    if (finalizingRef.current) {
      return;
    }
    finalizingRef.current = true;
    // GUARD: bloqueia finalize sem forma de pagamento. Modo SPLIT (paymentMethod
    // vazio) exige sale.payments com itens; modo direto exige paymentMethod.
    //
    // ANTI-RACE: payments sao POSTados pelo PaymentModal e refletem no backend
    // imediatamente, mas o state `sale.payments` no parent eh atualizado via
    // refetch assincrono (onPaymentsChanged). Se o user clica em "Finalizar
    // venda" rapido depois de adicionar a forma, o `sale.payments` ainda ta
    // stale -> guard dispara falso negativo. Refetch sale FRESCA antes de
    // checar pra evitar isso.
    if (!paymentMethod) {
      let payments = sale.payments || [];
      if (payments.length === 0) {
        try {
          const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
          payments = fresh.payments || [];
          if (payments.length > 0) {
            setSale(fresh);
          }
        } catch { /* segue com state local */ }
      }
      if (payments.length === 0) {
        toast('warning', 'Sem forma de pagamento', 'Escolha PIX, cartao, dinheiro, crediario ou vale-troca antes de finalizar.');
        setShowPayment(true);
        finalizingRef.current = false; // libera pra proximo finalize
        return;
      }
    }
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

      // PIX = NUNCA mostra tela de preview/finalizada. Vai direto pro recibo
      // + proxima venda. Cobre 3 cenarios:
      //   1. paymentMethod === 'pix' (PIX unico)
      //   2. autoFlowRef (PIX confirmado por webhook Pagar.me/PagBank)
      //   3. split onde TODOS os pagamentos sao PIX (multi-PIX)
      const wasAutoFlow = autoFlowRef.current;
      autoFlowRef.current = false;
      const isDirectPix = paymentMethod === 'pix';
      const allPaymentsPix = (fresh?.payments?.length ?? 0) > 0 &&
        (fresh.payments || []).every((p: any) => String(p.method).toLowerCase() === 'pix');
      const skipFinalizedScreen = wasAutoFlow || isDirectPix || allPaymentsPix;
      if (!skipFinalizedScreen) {
        setShowFinalized(true);
      }

      // ── Impressão automática de cupom: PIX ou DINHEIRO (em 2 vias) ──
      // Cartão/crediário/marcado/vale NÃO imprimem cupom auto.
      // Roteado via printer-router → vai SEMPRE pra impressora térmica
      // configurada em /minha-loja/pdv/config-impressora.
      const isDirectDinheiro = paymentMethod === 'dinheiro';
      const allPaymentsDinheiro = (fresh?.payments?.length ?? 0) > 0 &&
        (fresh.payments || []).every((p: any) => String(p.method).toLowerCase() === 'dinheiro');
      const shouldAutoPrintPix = isDirectPix || allPaymentsPix;
      const shouldAutoPrintDinheiro = isDirectDinheiro || allPaymentsDinheiro;
      if (shouldAutoPrintPix || shouldAutoPrintDinheiro) {
        try {
          const { routePrint } = await import('@/lib/printer-router');
          await routePrint({
            kind: 'cupom',
            url: `/minha-loja/pdv/recibo/${sale.id}?autoprint=1`,
          });
        } catch (printErr) {
          console.error('Falha ao imprimir recibo:', printErr);
        }
      }

      // PIX e fluxo AUTO: abre proxima venda em ~1.5s (sem tela de preview
      // no caminho — vendedora ja pode bipar proximo cliente direto).
      if (skipFinalizedScreen) {
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
      finalizingRef.current = false;
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
      <div className="min-h-screen bg-[#FAFAF7] flex items-center justify-center p-4">
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
    <div
      className="min-h-screen flex flex-col"
      style={{ background: '#0B0B0B', zoom: uiZoom }}
    >
      <TrainingModeBanner />
      {/* ── PDV2: banner fino fixo de VERSÃO DE TESTE ── */}
      <div className="sticky top-0 z-30 h-7 bg-[#D4AF37] text-black text-xs font-bold tracking-wide flex items-center justify-center gap-3 px-4 shadow-md">
        <span>PDV V2 — VERSÃO DE TESTE</span>
        <span className="opacity-40">·</span>
        <Link href="/minha-loja/pdv" className="text-black underline underline-offset-2 hover:text-[#161616]">
          voltar ao PDV atual
        </Link>
      </div>
      {/* Header — fundo violet escuro com texto branco. Mesmo estilo do
          /minha-loja/realinhamento pra unificar identidade visual.
          PDV2: sticky top-7 (28px) pra ficar logo abaixo do banner de teste. */}
      <header
        className="sticky top-7 z-20"
        style={{ background: '#0B0B0B' }}
      >
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href="/minha-loja"
            className="text-white/80 hover:text-white transition shrink-0"
            aria-label="Voltar"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>

          {/* LOGO Lurd's — maior (56px) pra dar identidade */}
          <Link
            href="/minha-loja"
            className="flex items-center gap-2 shrink-0 group"
            title="Início"
          >
            <div className="relative w-14 h-14 bg-white rounded-full p-1.5 shadow-md ring-2 ring-[#D4AF37]/50">
              <Image
                src="/lurds-logo.png"
                alt="Lurd's Plus Size"
                fill
                sizes="56px"
                className="object-contain"
                priority
              />
            </div>
          </Link>

          {/* Header reformulado — PROPOSTA A: cidade em destaque dourado */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-white/70 tracking-[0.15em] uppercase leading-none">
                PDV · LOJA
              </span>
              {sale?.storeCode && (
                <span className="text-[10px] font-mono font-bold text-black bg-[#D4AF37] px-1.5 py-0.5 rounded shadow-sm leading-none">
                  {sale.storeCode}
                </span>
              )}
            </div>
            <h1
              className="text-2xl sm:text-3xl font-black leading-none tracking-tight mt-1 truncate"
              style={{
                background: 'linear-gradient(90deg, #D4AF37 0%, #E5C158 100%)',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
              title={sale?.storeName || ''}
            >
              {sale?.storeName || 'Carregando…'}
            </h1>
            <p className="text-[11px] text-white/85 truncate font-medium mt-1">
              {sale
                ? (() => {
                    const totalQty = (sale.items || []).reduce((s: number, it: any) => s + (Number(it.qty) || 0), 0);
                    return `Venda #${sale.id.slice(-6).toUpperCase()} · ${totalQty} ${totalQty === 1 ? 'peça' : 'peças'} no carrinho`;
                  })()
                : ''}
            </p>
          </div>

          {/* Botão Pausadas — FIXO no header, sempre visível.
              Quando vazio: estilo cinza claro. Com pendentes: amarelo destacado.
              Permite vendedora abrir lista mesmo quando count=0 (caso bug ou
              precisa procurar venda específica que sumiu da sessão). */}
          <button
            onClick={() => setShowOpenList(true)}
            className={`relative text-xs px-3 py-2.5 rounded-xl flex items-center gap-1.5 font-bold shrink-0 shadow-md transition text-white bg-[#161616] border ${
              openCount > 0
                ? 'border-[#D4AF37] hover:bg-[#1f1f1f]'
                : 'border-[#2A2A2A] hover:border-[#D4AF37] hover:bg-[#1f1f1f]'
            }`}
            title={openCount > 0 ? `${openCount} venda(s) pausada(s)` : 'Nenhuma venda pausada agora — clique pra ver histórico recente'}
          >
            <Pause className="w-4 h-4 text-[#D4AF37]" />
            <span className="hidden sm:inline">Pausadas</span>
            <span className={`text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1.5 ${
              openCount > 0 ? 'bg-[#D4AF37] text-black' : 'bg-[#2A2A2A] text-white/70'
            }`}>
              {openCount}
            </span>
          </button>

          {/* Botão Links Online — Pagar.me aguardando/pago. Pisca em verde quando
              tem algum PAGO pra vendedora finalizar. Sempre visível pra fácil acesso. */}
          {(() => {
            const totalLinks = onlinePending.length;
            const paidCount = onlinePending.filter((p) => p.status === 'paid').length;
            if (totalLinks === 0) return null;
            const hasPaid = paidCount > 0;
            return (
              <button
                onClick={() => setShowOnlinePending(true)}
                className={`relative text-xs px-3 py-2.5 rounded-xl flex items-center gap-1.5 font-bold shrink-0 shadow-md transition ${
                  hasPaid
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-white ring-2 ring-emerald-300 animate-pulse'
                    : 'bg-[#161616] hover:bg-[#1f1f1f] text-white border border-[#2A2A2A] hover:border-[#D4AF37]'
                }`}
                title={
                  hasPaid
                    ? `${paidCount} pagamento(s) confirmado(s) — clique pra finalizar`
                    : `${totalLinks} link(s) aguardando pagamento`
                }
              >
                <span className="text-base leading-none">🔗</span>
                <span className="hidden sm:inline">
                  {hasPaid ? `${paidCount} PAGO${paidCount > 1 ? 'S' : ''}!` : 'Online'}
                </span>
                <span className={`text-[10px] font-black rounded-full min-w-[20px] h-[20px] flex items-center justify-center px-1.5 ${
                  hasPaid ? 'bg-white text-emerald-700' : 'bg-[#D4AF37] text-black'
                }`}>
                  {totalLinks}
                </span>
              </button>
            );
          })()}

          {/* Botão Vendedora — quem está atendendo · atalho F9 */}
          <button
            onClick={() => setShowVendedora(true)}
            disabled={!sale || sale.status !== 'open'}
            className={`text-xs px-3 py-2.5 rounded-xl flex items-center gap-1.5 font-bold transition disabled:opacity-50 shrink-0 shadow-md text-white bg-[#161616] border ${
              sale?.sellerName
                ? 'border-[#2A2A2A] hover:border-[#D4AF37] hover:bg-[#1f1f1f]'
                : 'border-[#D4AF37] hover:bg-[#1f1f1f] animate-pulse'
            }`}
            title={sale?.sellerName ? `Trocar vendedora (atalho F9) — atual: ${sale.sellerName}` : 'Identificar vendedora (atalho F9)'}
          >
            <Sparkles className="w-4 h-4 text-[#D4AF37]" />
            <span className="hidden sm:inline truncate max-w-[100px]">
              {sale?.sellerName ? sale.sellerName.split(' ')[0] : 'Vendedora'}
            </span>
            <kbd className="hidden md:inline-flex items-center justify-center text-[10px] font-mono bg-black text-[#D4AF37] border border-[#D4AF37]/40 rounded px-1.5 py-0.5">F9</kbd>
          </button>

          {/* Botão Cliente — atalho F5 */}
          <button
            onClick={() => setShowCustomer(true)}
            disabled={!sale || sale.status !== 'open'}
            className={`text-xs px-3 py-2.5 rounded-xl flex items-center gap-1.5 font-bold transition disabled:opacity-50 shrink-0 shadow-md text-white bg-[#161616] border ${
              sale?.customerCpf
                ? 'border-[#D4AF37] hover:bg-[#1f1f1f]'
                : 'border-[#2A2A2A] hover:border-[#D4AF37] hover:bg-[#1f1f1f]'
            }`}
            title="Identificar cliente (atalho F6)"
          >
            <User className="w-4 h-4 text-[#D4AF37]" />
            <span className="hidden sm:inline truncate max-w-[100px]">
              {sale?.customerCpf ? sale.customerName?.split(' ')[0] || 'Cliente' : 'Identificar'}
            </span>
            <kbd className="hidden md:inline-flex items-center justify-center text-[10px] font-mono bg-black text-[#D4AF37] border border-[#D4AF37]/40 rounded px-1.5 py-0.5">F6</kbd>
          </button>

          {/* Botão Modo Treinamento — só aparece quando NÃO está em treino.
              Quando está em treino, o banner global cobre. */}
          <TrainingModeButton className="text-xs px-3 py-2.5 rounded-xl flex items-center gap-1.5 font-bold shrink-0 shadow-md bg-[#161616] hover:bg-[#1f1f1f] text-[#D4AF37] border-2 border-[#D4AF37]" />
        </div>
      </header>

      {/* CONTAINER PRINCIPAL: main (esquerda) + sidebar (direita) */}
      <div className="flex-1 w-full max-w-[1700px] mx-auto flex gap-3 px-0 pt-0 pb-[240px] lg:pb-[230px] bg-[#FAFAF7]">

      {/* ─── SIDEBAR ESQUERDA — AÇÕES DO PDV (desktop) ─────────────────────
          Painel MARINHO/NAVY escuro (mesma cor do header — visual integrado).
          Botões QUADRADOS em grid 2 colunas: ícone em cima + label embaixo +
          atalho como chip no canto superior direito. Sticky logo abaixo do
          header (top-0 — encosta no header pra dar sensação de bloco único).
          Em mobile (<lg) some — PdvMobilePill horizontais continuam acima
          do footer pra mesma navegação. */}
      {sale?.status === 'open' && (
        <aside
          className="w-[210px] shrink-0 hidden lg:flex flex-col gap-2 sticky self-start"
          style={{
            top: '0',
            minHeight: '100vh',
            maxHeight: '100vh',
            overflowY: 'auto',
            background: '#0B0B0B',
          }}
        >
          <div className="p-2.5 pt-3 space-y-3">
            {/* SIDEBAR ESQUERDA — cards horizontais compactos */}
            <div className="space-y-1.5">
              <Link
                href="/minha-loja/consultar"
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                title="Consulta de produtos (F10)"
              >
                <Search className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Consulta Produtos</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Buscar produto, estoque</div>
                </div>
                <span className="text-[9px] font-mono font-bold bg-[#D4AF37] text-black px-1.5 py-0.5 rounded shrink-0">F10</span>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
              <Link
                href="/minha-loja/pdv/devolucao"
                onClick={() => {
                  try {
                    if (sale?.id) localStorage.setItem('lurds_pdv_attach_to_sale_id', JSON.stringify({ id: sale.id, ts: Date.now(), items: sale.items?.length || 0 }));
                    else localStorage.removeItem('lurds_pdv_attach_to_sale_id');
                  } catch {}
                }}
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                title="Trocas / Devolução (F4)"
              >
                <ArrowRightLeft className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Trocas</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Devolução / troca</div>
                </div>
                <span className="text-[9px] font-mono font-bold bg-[#D4AF37] text-black px-1.5 py-0.5 rounded shrink-0">F4</span>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
              <Link
                href="/minha-loja/pdv/marcados"
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                title="Marcados (provar em casa)"
              >
                <Tag className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Marcados</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Provar em casa</div>
                </div>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
              <button
                type="button"
                onClick={() => setShowSimular(true)}
                disabled={!sale?.total || sale.total <= 0}
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#161616] disabled:hover:border-[#2A2A2A] disabled:hover:translate-y-0 disabled:hover:shadow-none"
                title="Simular parcelamento"
              >
                <CreditCard className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Simular</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Simular parcelamento</div>
                </div>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </button>
              <Link
                href="/minha-loja/pdv/recebimentos"
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                title="Baixa de Crediário"
              >
                <Receipt className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Baixa Crediário</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Receber parcelas</div>
                </div>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
              <Link
                href="/minha-loja/pdv/caixa"
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                title="Retiradas, sangria, suprimento (F3)"
              >
                <DollarSign className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Retiradas</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Caixa, sangria</div>
                </div>
                <span className="text-[9px] font-mono font-bold bg-[#D4AF37] text-black px-1.5 py-0.5 rounded shrink-0">F3</span>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
              <Link
                href="/minha-loja/pdv/produtos-vendidos"
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                title="Conferir vendas + trocas do turno"
              >
                <Receipt className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Produtos Vendidos</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Vendas + trocas (conferir)</div>
                </div>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
              <Link
                href="/minha-loja/pdv/notas"
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                title="Notas Fiscais emitidas"
              >
                <FileText className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Notas Fiscais</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">NFC-es emitidas</div>
                </div>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
              <Link
                href="/minha-loja/pdv/config-impressora"
                className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
                title="Configurar impressoras térmica e A4"
              >
                <Printer className="w-5 h-5 text-[#D4AF37] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-black leading-tight">Impressoras</div>
                  <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Térmica + A4</div>
                </div>
                <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Link>
            </div>
          </div>
        </aside>
      )}


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
          <div className="relative w-full">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // Se tem item destacado no dropdown, escolhe ele. Senao bipe normal.
              if (showResults && highlightedIdx >= 0 && searchResults[highlightedIdx]) {
                addBySku(searchResults[highlightedIdx].CODIGO);
              } else {
                handleScan(e);
              }
            }}
            className="bg-white rounded-2xl border border-slate-200 px-4 py-2.5 shadow-md flex items-center gap-3 w-full"
          >
            <Barcode className="w-5 h-5 text-slate-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              onKeyDown={(e) => {
                if (!showResults || searchResults.length === 0) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHighlightedIdx((i) => Math.min(searchResults.length - 1, i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlightedIdx((i) => Math.max(0, i - 1));
                } else if (e.key === 'Escape') {
                  setShowResults(false);
                  setHighlightedIdx(-1);
                }
              }}
              onBlur={() => {
                // delay pra permitir click no item antes do dropdown fechar
                setTimeout(() => setShowResults(false), 150);
              }}
              onFocus={() => {
                if (searchResults.length > 0) setShowResults(true);
              }}
              placeholder="Bipe SKU/EAN ou digite parte do nome do produto…"
              disabled={scanLoading}
              className="flex-1 min-w-0 px-2 py-2 text-lg font-bold border-0 focus:outline-none disabled:bg-slate-50 placeholder:text-slate-400 placeholder:font-normal text-slate-900"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {searchLoading && (
              <Loader2 className="w-4 h-4 text-slate-400 animate-spin shrink-0" />
            )}
            <button
              type="submit"
              disabled={!scanInput || scanLoading}
              className="px-5 py-3 text-black font-bold rounded-xl flex items-center disabled:opacity-40 transition shrink-0 shadow-md"
              style={{ background: 'linear-gradient(135deg, #E5C158, #D4AF37)' }}
            >
              {scanLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
            </button>
          </form>

          {/* DROPDOWN DE BUSCA — aparece abaixo do input quando ha resultados */}
          {showResults && searchResults.length > 0 && (
            <div className="absolute z-30 left-0 right-0 mt-1 bg-white rounded-2xl border border-slate-200 shadow-xl max-h-[420px] overflow-y-auto">
              <div className="px-3 py-2 border-b border-slate-100 bg-slate-50 text-[10px] uppercase tracking-wider font-black text-slate-500 flex items-center justify-between">
                <span>{searchResults.length} resultado(s) — clique pra adicionar</span>
                <span className="text-[9px] font-normal">↑↓ navegar · Enter escolher · Esc fechar</span>
              </div>
              {searchResults.map((r, idx) => {
                const isHi = idx === highlightedIdx;
                const desc = (r.DESCRICAOCOMPLETA || '').trim();
                const corTam = [r.COR, r.TAMANHO].filter(Boolean).join(' / ');
                const qtyLoja = Number(r.qtyMyStore ?? r.ESTOQUE) || 0;
                const qtyRede = Number(r.qtyTotal ?? 0) || 0;
                return (
                  <button
                    key={`${r.CODIGO}-${idx}`}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); addBySku(r.CODIGO); }}
                    onMouseEnter={() => setHighlightedIdx(idx)}
                    className={`w-full px-3 py-2 flex items-center gap-3 text-left transition border-b border-slate-50 last:border-b-0 ${
                      isHi ? 'bg-[#FAF6E8]' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex flex-col items-center justify-center w-12 shrink-0">
                      <div className="font-mono text-[10px] text-slate-400">SKU</div>
                      <div className="font-mono font-bold text-[11px] text-slate-700">{r.CODIGO}</div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-black text-sm text-slate-900">{r.REF}</span>
                        {corTam && <span className="text-[10px] font-bold text-slate-500">{corTam}</span>}
                      </div>
                      {desc && (
                        <div className="text-xs text-slate-700 truncate font-semibold">{desc}</div>
                      )}
                    </div>
                    <div className="shrink-0 text-right flex items-center gap-3">
                      <div>
                        <div className="text-[9px] uppercase text-slate-400 font-bold">Sua loja</div>
                        <div className={`text-base font-black tabular-nums ${qtyLoja > 0 ? 'text-emerald-700' : 'text-rose-400'}`}>{qtyLoja}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase text-slate-400 font-bold">Rede</div>
                        <div className={`text-sm font-bold tabular-nums ${qtyRede > 0 ? 'text-slate-700' : 'text-slate-400'}`}>{qtyRede}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          </div>
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
                className="w-full px-3 py-2 bg-[#FAF6E8]/60 border-b border-[#E5E5E0] flex items-center justify-between gap-2 hover:bg-[#FAF6E8] transition"
              >
                <div className="flex items-center gap-2 text-[11px] font-bold text-[#8C7325]">
                  <span>🎁</span>
                  <span className="uppercase tracking-wider">Campanha:</span>
                  <span className="font-black">
                    {sale.activePromotion === 'YEAR_BASED' ? 'Liquida antigos 50%' :
                     sale.activePromotion === 'FOUR_FOR_THREE' ? '4 LEVA 3' :
                     <span className="text-slate-500 font-medium">Nenhuma</span>}
                  </span>
                </div>
                <ChevronRight className={`w-3.5 h-3.5 text-[#8C7325] transition-transform ${promoExpanded ? 'rotate-90' : ''}`} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setPromoExpanded(true)}
                className="w-full px-3 py-1.5 bg-slate-50 border-b border-slate-100 text-[10px] text-slate-500 hover:text-[#8C7325] hover:bg-[#FAF6E8]/60 transition flex items-center justify-center gap-1.5"
              >
                🎁 <span>Aplicar campanha promocional</span>
              </button>
            )}
            {promoExpanded && (
            <div className="px-3 py-2 bg-[#FAF6E8]/40 border-b border-[#E5E5E0]">
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
                      ? 'bg-[#D4AF37] text-black border-[#D4AF37]'
                      : 'bg-white text-[#8C7325] border-[#E5E5E0] hover:border-[#D4AF37]'
                  }`}
                >
                  Liquida antigos
                  <div className="text-[9px] font-normal">até 31/12/2023 = 50% off</div>
                </button>
                <button
                  onClick={() => setPromotion('FOUR_FOR_THREE')}
                  className={`text-xs py-1.5 px-1 rounded font-bold transition-colors border ${
                    sale.activePromotion === 'FOUR_FOR_THREE'
                      ? 'bg-[#0B0B0B] text-[#D4AF37] border-[#0B0B0B]'
                      : 'bg-white text-[#8C7325] border-[#E5E5E0] hover:border-[#D4AF37]'
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
                    <div className="mt-1.5 text-[11px] text-[#8C7325] bg-[#FAF6E8] rounded px-2 py-1 font-semibold">
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
            <div className="px-3 py-1.5 bg-[#FAF6E8] border-b border-[#E5E5E0] text-[11px] text-[#8C7325] font-bold flex items-center gap-1.5">
              <ShoppingCart className="w-3 h-3" /> Itens da venda · {(() => { const t = sale.items.reduce((s: number, it: any) => s + (Number(it.qty) || 0), 0); return `${t} ${t === 1 ? 'peça' : 'peças'}`; })()}
              <span className="ml-2 text-[9px] font-bold text-[#8C7325]/70 uppercase tracking-wider">↓ último bipado no topo</span>
            </div>
            <div className="divide-y">
              {/* LINHAS VIRTUAIS DE VALE-TROCA — quando o cliente aplica um vale
                  na venda, aparece como "produto devolvido" no carrinho com valor
                  negativo, deixando claro que o abatimento foi feito. Renderizado
                  ANTES dos items (no topo) com estilo diferenciado teal. */}
              {(sale.payments || []).filter((p: any) => p.method === 'vale_troca').map((p: any) => {
                let code = '';
                try {
                  const det = typeof p.details === 'string' ? JSON.parse(p.details) : p.details;
                  code = String(det?.creditoCode || '').trim();
                } catch { /* segue sem codigo */ }
                return (
                  <div
                    key={`vt-${p.id}`}
                    className="px-3 py-2 grid grid-cols-[80px_56px_1fr_80px_90px_110px_56px] gap-2 items-center bg-[#FAF6E8] border-l-4 border-[#D4AF37]"
                    title="Vale-troca aplicado — abate da venda"
                  >
                    <div className="font-mono text-[10px] text-[#8C7325] truncate">{code || 'VALE'}</div>
                    <div className="flex items-center justify-center text-[#8C7325] text-xl">↺</div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-black uppercase tracking-wide">DEVOLUÇÃO (vale-troca)</div>
                      <div className="text-[10px] text-[#8C7325] font-mono">{code}</div>
                    </div>
                    <div className="text-right text-[11px] text-slate-500">1×</div>
                    <div className="text-right text-[11px] text-slate-500 tabular-nums">−{brl(Number(p.valor) || 0)}</div>
                    <div className="text-right text-sm font-bold text-rose-700 tabular-nums">−{brl(Number(p.valor) || 0)}</div>
                    <button
                      onClick={async () => {
                        if (!confirm(`Remover vale-troca ${code}?\n\nO codigo TROCA volta a ficar disponivel.`)) return;
                        try {
                          await api(`/pdv/sales/${sale.id}/payments/${p.id}`, { method: 'DELETE' });
                          const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
                          setSale(fresh);
                          toast('success', 'Vale-troca removido', code);
                        } catch (e: any) {
                          toast('error', 'Falha ao remover vale', e?.message || '');
                        }
                      }}
                      className="text-rose-600 hover:text-rose-800 flex items-center justify-center"
                      title="Remover vale-troca"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
              {/* ORDEM INVERTIDA — último item bipado fica no topo pra vendedora
                  conferir o que acabou de passar. Slice + reverse não muta o array
                  original (sale.items continua na ordem original no estado). */}
              {[...sale.items].slice().reverse().map((it, idx) => {
                const isLast = idx === 0; // primeiro renderizado = último bipado
                const bruto = it.precoUnit * it.qty;
                return (
                <div
                  key={it.id}
                  className={`px-3 py-2 grid grid-cols-[68px_52px_1fr_56px_72px_96px_44px] gap-2 items-center transition-colors duration-500 ${
                    it.id === lastAddedItemId
                      ? 'bg-emerald-200/80 ring-2 ring-inset ring-emerald-500'
                      : isLast
                      ? 'bg-[#FAF6E8] shadow-[inset_3px_0_0_0_#D4AF37]'
                      : 'hover:bg-[#FAF6E8]/50'
                  }`}
                >
                  {/* SKU/EAN */}
                  <div className="font-mono text-[11px] text-slate-700 truncate" title={it.ean || it.sku}>
                    {it.ean || it.sku}
                  </div>

                  {/* THUMBNAIL — busca foto do WooCommerce; fallback avatar */}
                  <ProductThumb sku={it.sku} refCode={it.ref} />

                  {/* DESCRIÇÃO — REF como chip destacado + descrição em negrito.
                      Ordem: SKU (col 1) -> REF (chip) -> descrição. */}
                  <div className="min-w-0 flex items-center gap-2">
                    <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                      <span className="font-mono font-black text-[11px] bg-white text-slate-700 border border-[#E5E5E0] rounded px-1.5 py-0.5 shrink-0 tracking-wide">
                        {it.ref || it.sku}
                      </span>
                      {it.descricao && (
                        <span className="text-sm font-bold text-slate-900 truncate font-sans">{it.descricao}</span>
                      )}
                    </div>
                    {it.promoTag && (
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                          it.promoTag.includes('4 LEVA 3')
                            ? 'bg-[#0B0B0B] text-[#D4AF37] border border-[#0B0B0B]'
                            : it.promoTag === 'MANUAL'
                            ? 'bg-black text-[#D4AF37] border border-[#D4AF37]/50'
                            : 'bg-[#FAF6E8] text-[#8C7325] border border-[#D4AF37]/40'
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

                  {/* VAL TOTAL — preto forte, fonte grande */}
                  <div className="text-right">
                    <div className="font-black text-black tabular-nums text-base">{brl(it.total)}</div>
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
            <div className="w-20 h-20 mx-auto rounded-full bg-[#FAF6E8] border-2 border-[#E5E5E0] flex items-center justify-center mb-4">
              <ShoppingCart className="w-10 h-10 text-[#D4AF37]" />
            </div>
            <div className="text-lg font-bold text-slate-700 mb-1">Carrinho vazio</div>
            <div className="text-sm text-slate-500">
              Bipe o primeiro produto pra começar a venda
            </div>
          </div>
        ) : null}
      </main>

      {/* SIDEBAR DIREITA — RESUMO DA VENDA + GESTAO/RELATORIOS
          Mesmo estilo navy marinho da sidebar esquerda. Encosta no header
          (top-0) pra dar sensacao de bloco unico. Resumo no topo destacado
          em card branco; abaixo botoes em horizontal cinza gelo. */}
      {sale?.status === 'open' && (
      <aside
        className="w-[230px] shrink-0 hidden lg:flex flex-col gap-2 sticky self-start"
        style={{
          top: '0',
          minHeight: '100vh',
          maxHeight: '100vh',
          overflowY: 'auto',
          background: '#0B0B0B',
        }}
      >
        <div className="p-2.5 pt-3 space-y-3">

          {/* ─── RESUMO DA VENDA (card branco destacado) ─── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
            <div className="text-[10px] font-black uppercase tracking-wider text-[#8C7325] mb-2">
              Resumo da venda
            </div>
            <div className="space-y-1 text-xs">
              {(() => {
                const totalQty = (sale.items || []).reduce((s: number, it: any) => s + (Number(it.qty) || 0), 0);
                return (
                  <div className="flex justify-between items-center bg-[#FAF6E8] border-2 border-[#D4AF37] rounded-lg px-3 py-2.5">
                    <span className="text-[#8C7325] uppercase text-xs font-black tracking-wide">Peças</span>
                    <span className="text-3xl font-black text-black tabular-nums">{totalQty}</span>
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
              {/* Devoluções/Vale-troca já aplicados — mostra em vermelho negativo */}
              {(() => {
                const valeTrocaPago = (sale.payments || []).reduce(
                  (s: number, p: any) => p.method === 'vale_troca' ? s + (Number(p.valor) || 0) : s,
                  0,
                );
                if (valeTrocaPago <= 0.01) return null;
                return (
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600 uppercase text-[10px] tracking-wide">Devolução / Vale</span>
                    <span className="font-bold text-rose-600 tabular-nums">− {brl(valeTrocaPago)}</span>
                  </div>
                );
              })()}
            </div>
            {(() => {
              const valeTrocaPago = (sale.payments || []).reduce(
                (s: number, p: any) => p.method === 'vale_troca' ? s + (Number(p.valor) || 0) : s,
                0,
              );
              const liquido = Math.round((sale.total - valeTrocaPago) * 100) / 100;
              const ehCredito = liquido < -0.01;
              return (
                <div className="border-t border-dashed border-slate-300 mt-2 pt-2 flex justify-between items-baseline">
                  <span className="text-[11px] font-black uppercase tracking-wider text-[#8C7325]">
                    {ehCredito ? 'Sobra crédito' : 'A pagar'}
                  </span>
                  <span className={`text-xl font-black tabular-nums ${ehCredito ? 'text-rose-600' : 'text-black'}`}>
                    {ehCredito ? `− ${brl(Math.abs(liquido))}` : brl(liquido)}
                  </span>
                </div>
              );
            })()}
          </div>
          {/* fim do resumo da venda */}

          {/* SIDEBAR DIREITA — cards compactos */}
          <div className="space-y-1.5">
            <Link
              href="/minha-loja"
              className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
              title="Pedidos do site"
            >
              <Globe className="w-5 h-5 text-[#D4AF37] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black leading-tight">Pedidos Site</div>
                <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">E-commerce</div>
              </div>
              {pedidosSitePending > 0 && (
                <span className="bg-[#D4AF37] text-black text-[10px] font-black rounded-full min-w-[20px] h-5 flex items-center justify-center px-1.5 shrink-0">
                  {pedidosSitePending}
                </span>
              )}
              <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
            <Link
              href="/minha-loja/realinhamento"
              className={`group relative w-full text-left flex items-center gap-2.5 rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98] bg-[#161616] hover:bg-[#1C1C1C] border ${
                realignPending > 0
                  ? 'border-[#D4AF37] ring-2 ring-[#D4AF37]/30'
                  : 'border-[#2A2A2A] hover:border-[#D4AF37]'
              }`}
              title="Realinhamento de estoque"
            >
              <Shuffle className="w-5 h-5 text-[#D4AF37] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black leading-tight">Realinhar</div>
                <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Inter-lojas</div>
              </div>
              {realignPending > 0 && (
                <span className="bg-[#D4AF37] text-black text-[10px] font-black rounded-full min-w-[22px] h-5 flex items-center justify-center px-1.5 shrink-0">
                  {realignPending}
                </span>
              )}
              <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
            <Link
              href="/minha-loja/pdv/fechamento"
              className="group relative w-full text-left flex items-center gap-2.5 bg-[#161616] hover:bg-[#1C1C1C] border border-[#2A2A2A] hover:border-[#D4AF37] rounded-xl px-3 py-2 text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98]"
              title="Fechamento diário"
            >
              <Wallet className="w-5 h-5 text-[#D4AF37] shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-black leading-tight">Fechamento</div>
                <div className="text-[10px] text-[#9CA3AF] leading-tight mt-0.5">Fechamento diário</div>
              </div>
              <ArrowUpRight className="w-3 h-3 text-[#D4AF37]/60 absolute top-1.5 right-1.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
            </Link>
          </div>

        </div>
      </aside>
      )}

      </div>{/* fim do flex main+sidebar */}

      {/* MOBILE BAR — em telas <lg, mostra ações em scroll horizontal acima do footer */}
      <div className="lg:hidden fixed bottom-[220px] left-0 right-0 z-10 px-3">
        <div className="max-w-4xl mx-auto bg-white/95 backdrop-blur border border-slate-200 rounded-2xl p-2 shadow-lg flex gap-2 overflow-x-auto">
          <PdvMobilePill tone="rose"   href="/minha-loja/pdv/recebimentos" icon={Receipt}    label="Crediário" />
          <PdvMobilePill tone="amber"  onClick={() => setShowSimular(true)} disabled={!sale?.total || sale.total <= 0} icon={CreditCard} label="Simular" />
          <PdvMobilePill tone="sky"    href="/minha-loja/consultar"        icon={Search}     label="Estoque" />
          <PdvMobilePill tone="purple" href="/minha-loja"                  icon={Globe}      label="Site" badge={pedidosSitePending} />
          <PdvMobilePill tone="green"  href="/minha-loja/pdv/caixa"        icon={DollarSign} label="Caixa" />
          <PdvMobilePill tone="orange" href="/minha-loja/pdv/devolucao" onClick={() => { try { if (sale?.id) localStorage.setItem('lurds_pdv_attach_to_sale_id', JSON.stringify({ id: sale.id, ts: Date.now(), items: sale.items?.length || 0 })); else localStorage.removeItem('lurds_pdv_attach_to_sale_id'); } catch {} }} icon={ArrowRightLeft} label="Trocar" />
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
        // OPÇÃO A (consolidada): CRÉDITO/DÉBITO viram 1 botão grande cada —
        // a BANDEIRA é escolhida no PaymentModal (tela própria, botões
        // grandes). setPresetBandeira(null) evita bandeira stale de uso
        // anterior. Custo: 1 clique a mais no cartão; ganho: barra sem
        // scroll, botões 2x maiores, tudo visível em qualquer monitor.
        const venderCartao = (m: 'credito' | 'debito') => {
          setPresetMethod(m);
          setPresetBandeira(null);
          setPaymentFilter('cartao');
          setShowPayment(true);
        };
        const venderOutro = (m: string) => {
          if (m === 'pix') { setPaymentFilter('pix'); setShowPayment(true); return; }
          if (m === 'crediario') { setPaymentFilter('crediario'); setShowPayment(true); return; }
          if (m === 'dinheiro') { setPresetMethod('dinheiro'); setPaymentFilter('all'); setShowPayment(true); return; }
          if (m === 'venda_online') {
            // Exige CPF antes de abrir — venda online sempre identifica cliente
            if (!sale?.customerCpf) {
              toast('warning', 'Identifique a cliente primeiro', 'Venda online sempre exige CPF (F6)');
              setShowCustomer(true);
              return;
            }
            setPresetMethod('venda_online');
            setPaymentFilter('all');
            setShowPayment(true);
            return;
          }
        };
        // Botão GRANDE: ícone em cima + label embaixo, altura 64px, flex-1
        // (divide a barra por igual, sem scroll). `secondary` = MARCAR
        // (não é pagamento — borda tracejada pra diferenciar).
        const PayBtn = ({
          onClick, icon, label, secondary,
        }: {
          onClick: () => void;
          icon: React.ReactNode;
          label: string;
          secondary?: boolean;
        }) => (
          <button
            onClick={onClick}
            title={label}
            className={`flex-1 min-w-0 h-16 rounded-xl flex flex-col items-center justify-center gap-1 transition border-2 ${
              secondary
                ? 'bg-white border-dashed border-slate-300 hover:border-[#D4AF37] hover:bg-[#FAF6E8]'
                : 'bg-white border-slate-200 hover:border-[#D4AF37] hover:bg-[#FAF6E8] hover:shadow-md'
            }`}
          >
            {icon}
            <span className="text-[13px] font-black text-black tracking-wide leading-none whitespace-nowrap">{label}</span>
          </button>
        );
        return (
          <div className="fixed bottom-[130px] lg:bottom-[120px] left-0 right-0 z-20 px-3 pointer-events-none">
            <div className="max-w-6xl mx-auto bg-white/95 backdrop-blur border border-slate-200 rounded-2xl shadow-xl p-2 pointer-events-auto flex items-stretch gap-2">
              <PayBtn
                onClick={() => venderCartao('credito')}
                icon={<CreditCard className="w-6 h-6 text-[#8C7325]" />}
                label="CRÉDITO"
              />
              <PayBtn
                onClick={() => venderCartao('debito')}
                icon={<Wallet className="w-6 h-6 text-[#8C7325]" />}
                label="DÉBITO"
              />
              <PayBtn
                onClick={() => venderOutro('pix')}
                icon={<QrCode className="w-6 h-6 text-[#8C7325]" />}
                label="PIX"
              />
              <PayBtn
                onClick={() => venderOutro('dinheiro')}
                icon={<Banknote className="w-6 h-6 text-[#8C7325]" />}
                label="DINHEIRO"
              />
              <PayBtn
                onClick={() => venderOutro('crediario')}
                icon={<Receipt className="w-6 h-6 text-[#8C7325]" />}
                label="CREDIÁRIO"
              />
              <PayBtn
                onClick={() => setShowValeTroca(true)}
                icon={<Tag className="w-6 h-6 text-[#8C7325]" />}
                label="VALE"
              />
              {/* VENDA ONLINE — WhatsApp/Instagram. Pagamento JÁ recebido por
                  fora (PIX direto ou link externo). Só registra venda +
                  baixa estoque. Sem NFC-e automática. CPF obrigatório. */}
              <PayBtn
                onClick={() => venderOutro('venda_online')}
                icon={<Globe className="w-6 h-6 text-[#8C7325]" />}
                label="V.ONLINE"
              />
              {/* MARCAR — cliente leva pra provar em casa.
                      Exige cliente identificado (CPF) — senao abre modal de
                      cliente primeiro. O click executa o fluxo direto: chama
                      backend pra criar marcado + baixa estoque + fecha venda.
                      Backend valida classe A e limite — se nao puder, retorna
                      erro claro pra vendedora. */}
                  <PayBtn
                    onClick={async () => {
                      if (!sale.customerCpf) {
                        toast('warning', 'Identifique a cliente primeiro', 'CPF é obrigatorio pra marcar (provar em casa)');
                        setShowCustomer(true);
                        return;
                      }
                      if (!sale.items?.length) {
                        toast('warning', 'Carrinho vazio', 'Bipe as peças que a cliente vai levar pra provar');
                        return;
                      }
                      if (!confirm(
                        `MARCAR ${sale.items.length} peça(s) pra ${sale.customerName || 'cliente'}?\n\n` +
                        `Total: ${brl(sale.total)}\n\n` +
                        `As peças vão como "provar em casa" — baixa estoque + fica em aberto pra cliente devolver depois.\n\n` +
                        `Cliente precisa ser classe A com limite disponivel no Giga.`,
                      )) return;
                      const doMarcar = async (force: boolean) => {
                        const r = await api<any>('/pdv/marcados/criar', {
                          method: 'POST',
                          body: JSON.stringify({ saleId: sale.id, force }),
                        });
                        if (r.ok) {
                          toast(
                            'success',
                            `${r.totalItems || sale.items.length} peças marcadas!`,
                            `Controle ${r.controle || ''} · ${r.forced ? '⚠ FORÇADO (acima do limite) · ' : ''}Cliente vai provar em casa`,
                          );
                          setSale(null);
                          setTimeout(() => createNewSale(), 500);
                        } else {
                          toast('error', 'Falha ao marcar', r.error || 'Tente de novo');
                        }
                      };
                      try {
                        await doMarcar(false);
                      } catch (e: any) {
                        const msg = String(e?.message || '');
                        // Erro de limite estourado — oferece override
                        const isLimite = /limite dispon[ií]vel|em marca/i.test(msg);
                        if (isLimite) {
                          const ok = window.confirm(
                            `⚠ LIMITE DE MARCAÇÃO ESTOURADO\n\n${msg}\n\n` +
                            `Isso costuma acontecer quando a cliente tem marcações antigas no Giga ` +
                            `que nunca foram baixadas (peças que voltaram mas o flag MARCADO=SIM ficou).\n\n` +
                            `Quer MARCAR MESMO ASSIM?\n` +
                            `(Vai ficar registrado quem forçou — só faça se tiver certeza)`,
                          );
                          if (ok) {
                            try {
                              await doMarcar(true);
                            } catch (e2: any) {
                              const h2 = humanizeError(e2);
                              toast('error', 'Falha mesmo com override', h2.hint || h2.title);
                            }
                          }
                          return;
                        }
                        const h = humanizeError(e);
                        toast('error', 'Cliente nao pode marcar', h.hint || h.title);
                      }
                    }}
                    icon={<span className="text-xl leading-none">📋</span>}
                    label="MARCAR"
                    secondary
                  />
            </div>
          </div>
        );
      })()}

      {/* Footer fixo: TOTAL GIGANTE + Finalizar destaque máximo */}
      {sale?.status === 'open' && (
        <footer className="fixed bottom-0 left-0 right-0 bg-white border-t-2 border-[#D4AF37] shadow-2xl z-10">
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

              {/* PAUSAR venda — fica na fila pra retomar depois (botão amarelo
                  em destaque). Útil quando cliente está esperando (ex: foi
                  pegar mais peças) e a vendedora precisa atender outra. Só
                  habilita se já tem peça bipada. */}
              <button
                onClick={fecharDepois}
                disabled={!sale?.items?.length}
                className="px-4 py-3 bg-white hover:bg-[#FAF6E8] border-2 border-black text-black rounded-xl flex items-center gap-2 font-bold text-sm transition shrink-0 shadow-md disabled:opacity-40 disabled:cursor-not-allowed"
                title="Pausar venda (volta na lista Pausadas)"
              >
                <Pause className="w-4 h-4" />
                <span className="hidden sm:inline">Pausar</span>
              </button>

              {/* Desconto geral — botão branco com LABEL + atalho F2 */}
              <button
                onClick={() => setShowDiscount({ kind: 'sale' })}
                className="px-4 py-3 bg-white hover:bg-[#FAF6E8] border-2 border-black text-black rounded-xl flex items-center gap-2 font-bold text-sm transition shrink-0 shadow-sm"
                title="Aplicar desconto na venda toda (atalho F2)"
              >
                <Percent className="w-4 h-4" />
                <span className="hidden sm:inline">Desconto geral</span>
                <kbd className="hidden md:inline-flex items-center justify-center text-[10px] font-mono bg-black text-[#D4AF37] border border-black rounded px-1.5 py-0.5 ml-1">F2</kbd>
              </button>

              {/* TOTAL GIGANTE — destaque máximo, ocupa espaço central.
                  whitespace-nowrap (sem truncate) — valor grande NAO pode cortar.
                  Escala progressiva: vai diminuindo a fonte em telas estreitas
                  pra caber sempre, mesmo com R$ 9.999,99+
                  SHOW RESTANTE: desconta pagamentos ja feitos (vale-troca, etc)
                  pra vendedora ver de cara quanto FALTA cobrar. */}
              <div className="flex-1 px-2 min-w-[140px] text-center overflow-visible">
                {(() => {
                  const paid = (sale.payments || []).reduce((s: number, p: any) => s + (Number(p.valor) || 0), 0);
                  // SEM Math.max — se vale_troca > total das peças, mostra
                  // negativo (cliente ainda tem crédito sobrando). Atualiza em
                  // tempo real conforme bipa: -49,90 → -10,00 → +19,90.
                  const liquido = Math.round((sale.total - paid) * 100) / 100;
                  const ehCredito = liquido < -0.01;
                  const temPgtoParcial = paid > 0.01 && paid < sale.total - 0.01;
                  return (
                    <>
                      {temPgtoParcial && (
                        <div className="text-[10px] text-slate-500 font-bold leading-none mb-0.5">
                          {brl(sale.total)} · <span className="text-emerald-600">✓ {brl(paid)} pago</span>
                        </div>
                      )}
                      <div className="text-[10px] text-[#8C7325] uppercase tracking-widest font-bold leading-none">
                        {ehCredito ? 'Sobra crédito' : temPgtoParcial ? 'Falta a pagar' : 'Total a pagar'}
                      </div>
                      <div className={`text-4xl sm:text-5xl md:text-6xl xl:text-7xl font-black tabular-nums leading-none mt-1 whitespace-nowrap ${ehCredito ? 'text-rose-600' : 'text-black'}`}>
                        {ehCredito ? `− ${brl(Math.abs(liquido))}` : brl(liquido)}
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* FINALIZAR DIRETO — aparece SÓ quando a venda já está 100% paga
                  (ex: vale-troca cobriu todo o total numa TROCA PAR). Sem esse
                  botão, vendedora ficava travada sem saber onde clicar pra fechar.
                  Nos outros casos (precisa receber dinheiro/cartão/PIX), a vendedora
                  clica nos botões de forma de pagamento — esses abrem o modal. */}
              {sale && sale.items?.length > 0 && (() => {
                const paid = (sale.payments || []).reduce((s: number, p: any) => s + (Number(p.valor) || 0), 0);
                const restante = Math.round((sale.total - paid) * 100) / 100;
                const jaCoberto = sale.total >= 0 && Math.abs(restante) < 0.01 && paid > 0;
                if (!jaCoberto) return null;
                return (
                  <button
                    onClick={() => finalizeSale('')}
                    disabled={finalizing}
                    className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black rounded-xl flex items-center gap-2 text-base shrink-0 shadow-lg ring-4 ring-emerald-300/60 animate-pulse"
                    title="Venda já está 100% paga (vale-troca cobriu tudo). Clique pra finalizar."
                  >
                    {finalizing ? (
                      <Loader2 className="w-5 h-5 animate-spin" />
                    ) : (
                      <Check className="w-5 h-5" />
                    )}
                    {finalizing ? 'Finalizando...' : 'FINALIZAR'}
                  </button>
                );
              })()}

              {/* GERAR VALE DO SALDO — aparece quando vale_troca > total (cliente
                  tem credito sobrando e nao quer levar outra peca). Click:
                  ajusta o vale_troca payment pra cobrir so o necessario,
                  cria vale residual com a diferenca (90 dias), finaliza venda
                  e imprime o vale automatico. */}
              {sale && sale.items?.length > 0 && (() => {
                const paid = (sale.payments || []).reduce((s: number, p: any) => s + (Number(p.valor) || 0), 0);
                const valeAplicado = (sale.payments || [])
                  .filter((p: any) => String(p.method).toLowerCase() === 'vale_troca')
                  .reduce((s: number, p: any) => s + (Number(p.valor) || 0), 0);
                const liquido = Math.round((sale.total - paid) * 100) / 100;
                const sobraCredito = liquido < -0.01 && valeAplicado > 0;
                if (!sobraCredito) return null;
                const valorResidual = Math.abs(liquido);
                return (
                  <button
                    onClick={async () => {
                      if (!confirm(
                        `Gerar vale de R$ ${valorResidual.toFixed(2).replace('.', ',')} pra cliente usar depois?\n\n` +
                        `✓ O vale-troca atual será ajustado pra cobrir só ${brl(sale.total)}\n` +
                        `✓ O saldo R$ ${valorResidual.toFixed(2).replace('.', ',')} vira novo vale (90 dias)\n` +
                        `✓ Venda será finalizada e o vale impresso`
                      )) return;
                      try {
                        const r: any = await api('/pdv/devolucao/dividir-vale-residual', {
                          method: 'POST',
                          body: JSON.stringify({
                            saleId: sale.id,
                            customerCpf: sale.customerCpf || undefined,
                            customerName: sale.customerName || undefined,
                          }),
                        });
                        // Finaliza venda apos ajuste
                        await finalizeSale('');
                        // Imprime o vale
                        if (r?.creditoCode) {
                          const url = `/minha-loja/pdv/vale-troca/${encodeURIComponent(r.creditoCode)}?autoprint=1`;
                          try {
                            const { routePrint } = await import('@/lib/printer-router');
                            await routePrint({ kind: 'vale', url }).catch(() => {
                              window.open(url, `vale_${Date.now()}`, 'width=420,height=720');
                            });
                          } catch {
                            window.open(url, `vale_${Date.now()}`, 'width=420,height=720');
                          }
                        }
                      } catch (e: any) {
                        toast('error', 'Erro ao gerar vale', e?.message || String(e));
                      }
                    }}
                    disabled={finalizing}
                    className="px-5 py-3 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-black rounded-xl flex items-center gap-2 text-base shrink-0 shadow-lg ring-4 ring-rose-300/60 animate-pulse"
                    title={`Cria vale de R$ ${valorResidual.toFixed(2)} pra cliente usar depois`}
                  >
                    <span>💰</span>
                    <span>Gerar vale R$ {valorResidual.toFixed(2).replace('.', ',')}</span>
                  </button>
                );
              })()}
            </div>

            {/* ── PDV2: barra de atalhos discreta no rodapé ── */}
            <div className="text-center text-[10px] text-slate-400 font-semibold tracking-wide select-none pt-1.5 mt-2 border-t border-slate-100 flex items-center justify-center gap-x-2 gap-y-1 flex-wrap">
              {[['F1', 'Bipar'], ['F2', 'Desconto'], ['F4', 'Troca'], ['F6', 'Cliente'], ['F8', 'Pagamento'], ['F9', 'Vendedora'], ['F10', 'Consulta'], ['F12', 'Ajuda']].map(([k, lbl]) => (
                <span key={k} className="inline-flex items-center gap-1">
                  <kbd className="inline-flex items-center justify-center font-mono text-[9px] bg-black text-[#D4AF37] rounded px-1 py-0.5 leading-none">{k}</kbd>
                  <span className="text-slate-500">{lbl}</span>
                </span>
              ))}
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
            cep: sale.customerCep || '',
            endereco: sale.customerEndereco || '',
            numero: sale.customerNumero || '',
            complemento: sale.customerComplemento || '',
            bairro: sale.customerBairro || '',
            cidade: sale.customerCidade || '',
            uf: sale.customerUf || '',
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
          onClose={() => {
            // Fechou sem escolher → descarta finalize pendente (evita
            // finalize "fantasma" disparar numa escolha de vendedora futura)
            pendingFinalizeRef.current = null;
            setShowVendedora(false);
          }}
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
          customerPhone={sale.customerPhone}
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

      {/* Modal Links Online Pendentes — vendas com Link Pagar.me aguardando
          ou já pagas pra finalizar. Atendente decide quando finalizar. */}
      {showOnlinePending && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => setShowOnlinePending(false)}
        >
          <div
            className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="font-black text-lg flex items-center gap-2">
                <span>🔗</span>
                Pedidos Online Pendentes
                <span className="text-xs font-normal text-slate-500">
                  ({onlinePending.length} total · {onlinePending.filter((p) => p.status === 'paid').length} pago{onlinePending.filter((p) => p.status === 'paid').length !== 1 ? 's' : ''})
                </span>
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={loadOnlinePending}
                  className="text-xs px-2 py-1 bg-violet-100 hover:bg-violet-200 text-violet-700 font-bold rounded flex items-center gap-1"
                  title="Atualizar lista"
                >
                  <RefreshCw className="w-3 h-3" />
                  Atualizar
                </button>
                <button onClick={() => setShowOnlinePending(false)}>
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-3 space-y-2">
              {onlinePending.length === 0 ? (
                <div className="p-8 text-center text-slate-400">
                  Nenhum pedido online pendente nas últimas 48h.
                </div>
              ) : (
                onlinePending.map((p) => {
                  const isPaid = p.status === 'paid';
                  const isFailed = p.status === 'failed' || p.status === 'canceled';
                  const ageMin = Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 60000);
                  return (
                    <div
                      key={p.saleId}
                      className={`border-2 rounded-lg p-3 ${
                        isPaid
                          ? 'border-emerald-400 bg-emerald-50 shadow-lg'
                          : isFailed
                          ? 'border-rose-300 bg-rose-50 opacity-60'
                          : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="font-mono text-[10px] font-bold bg-slate-100 px-1.5 py-0.5 rounded">
                              #{p.saleCode}
                            </span>
                            {isPaid && (
                              <span className="bg-emerald-500 text-white text-[10px] font-black px-2 py-0.5 rounded animate-pulse">
                                ✓ PAGO
                              </span>
                            )}
                            {!isPaid && !isFailed && (
                              <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded">
                                ⏳ Aguardando
                              </span>
                            )}
                            {isFailed && (
                              <span className="bg-rose-200 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded">
                                ✗ {p.status}
                              </span>
                            )}
                            <span className="text-[10px] text-slate-500">
                              {ageMin < 60 ? `${ageMin}min` : `${Math.floor(ageMin / 60)}h${ageMin % 60}min`} atrás
                            </span>
                          </div>
                          <div className="font-bold text-sm text-slate-800 truncate">
                            {p.customerName || 'Sem nome'}
                          </div>
                          <div className="text-[11px] text-slate-500 flex gap-2 flex-wrap">
                            {p.customerCpf && <span>CPF {p.customerCpf}</span>}
                            {p.customerPhone && <span>· {p.customerPhone}</span>}
                            {p.sellerName && <span>· vend. {p.sellerName}</span>}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className={`text-lg font-black tabular-nums ${
                            isPaid ? 'text-emerald-700' : 'text-slate-700'
                          }`}>
                            {brl(p.total)}
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-1.5 flex-wrap">
                        {isPaid ? (
                          <button
                            onClick={async () => {
                              // AUTO-FINALIZA: cria payment 'venda_online' + chama finalize.
                              // Não abre PaymentModal (já tá pago — só registra e fecha).
                              if (!confirm(
                                `Finalizar venda #${p.saleCode} de ${p.customerName || 'cliente'} ` +
                                `(${brl(p.total)})?\n\nO pagamento já foi confirmado pela Pagar.me.`,
                              )) return;
                              try {
                                // 1) Cria PdvSalePayment como venda_online/pagarme_link
                                await api(`/pdv/sales/${p.saleId}/payments`, {
                                  method: 'POST',
                                  body: JSON.stringify({
                                    method: 'venda_online',
                                    valor: p.total,
                                    details: {
                                      tipo: 'pagarme_link',
                                      origem: 'whatsapp_instagram',
                                      pagarmeOrderId: p.pagarmeOrderId,
                                      paidByWebhook: true,
                                    },
                                  }),
                                });
                                // 2) Finaliza a venda (baixa estoque, grava Wincred, etc)
                                await api(`/pdv/sales/${p.saleId}/finalize`, {
                                  method: 'POST',
                                  body: JSON.stringify({}),
                                });
                                toast(
                                  'success',
                                  `✅ Venda #${p.saleCode} finalizada!`,
                                  `${brl(p.total)} · estoque baixado · Wincred OK`,
                                );
                                loadOnlinePending();
                                loadOpenCount();
                                // Fecha modal só se não tiver mais pendentes
                                const restantes = onlinePending.filter((o) => o.saleId !== p.saleId);
                                if (restantes.length === 0) setShowOnlinePending(false);
                              } catch (e: any) {
                                toast(
                                  'error',
                                  'Erro ao finalizar venda',
                                  e?.message || 'Tente reabrir manualmente.',
                                );
                              }
                            }}
                            className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded shadow-md"
                          >
                            ✅ FINALIZAR VENDA
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={async () => {
                                try {
                                  const r = await api<{ status: string; isPaid?: boolean }>(
                                    `/pagarme/pix/check/${p.pagarmeOrderId}`,
                                    { method: 'POST' },
                                  );
                                  if (r.isPaid || r.status === 'paid') {
                                    toast('success', 'Pago!', `${p.customerName} pagou`);
                                    loadOnlinePending();
                                  } else {
                                    toast('info', `Status: ${r.status}`, 'Ainda não pago');
                                  }
                                } catch (e: any) {
                                  toast('error', 'Erro', e?.message);
                                }
                              }}
                              className="flex-1 py-1.5 bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-bold rounded"
                            >
                              🔄 Conferir
                            </button>
                            {p.paymentUrl && (
                              <>
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(p.paymentUrl!);
                                    toast('success', 'Link copiado!');
                                  }}
                                  className="py-1.5 px-3 bg-violet-600 hover:bg-violet-700 text-white text-[11px] font-bold rounded"
                                >
                                  📋
                                </button>
                                <a
                                  href={`https://wa.me/${(p.customerPhone || '').replace(/\D/g, '') ? `55${(p.customerPhone || '').replace(/\D/g, '')}` : ''}?text=${encodeURIComponent(
                                    `Olá! Link pra pagamento (${brl(p.total)}):\n\n${p.paymentUrl}\n\nPIX ou cartão até 12x sem juros.`,
                                  )}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="py-1.5 px-3 bg-green-600 hover:bg-green-700 text-white text-[11px] font-bold rounded"
                                >
                                  📱
                                </a>
                              </>
                            )}
                            <button
                              onClick={async () => {
                                setShowOnlinePending(false);
                                await retomarVenda(p.saleId);
                              }}
                              className="py-1.5 px-3 bg-slate-600 hover:bg-slate-700 text-white text-[11px] font-bold rounded"
                              title="Reabrir essa venda"
                            >
                              Reabrir
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="p-3 border-t bg-slate-50 rounded-b-xl text-[11px] text-slate-600 text-center">
              ℹ Lista atualiza automaticamente a cada 15s. Pagamentos confirmados emitem alerta sonoro.
            </div>
          </div>
        </div>
      )}

      {/* ── PDV2: overlay de ajuda de atalhos (F12 / ?) ── */}
      {showShortcuts && <ShortcutsHelpModal onClose={() => setShowShortcuts(false)} />}

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

      {/* Modal Vale-Troca — bipa código TROCA-XXXX, valida e aplica como
          pagamento parcial. Se cobrir todo o restante, finaliza venda automático. */}
      {showValeTroca && sale && (
        <ValeTrocaModal
          saleId={sale.id}
          totalRestante={(() => {
            const pago = (sale.payments || []).reduce((s, p) => s + (p.valor || 0), 0);
            return Math.max(0, sale.total - pago);
          })()}
          onClose={() => setShowValeTroca(false)}
          onApplied={async () => {
            const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
            setSale(fresh);
            setShowValeTroca(false);
            const totalPago = (fresh.payments || []).reduce((s, p) => s + (p.valor || 0), 0);
            if (Math.abs(totalPago - fresh.total) < 0.01) {
              // Vale-troca cobriu TUDO — finaliza venda.
              // NOTA: NAO seta autoFlowRef=true (diferente de PIX) — vendedora
              // precisa ver a tela "Venda finalizada" pra conferir o vale aplicado,
              // imprimir recibo, etc. PIX presencial faz auto-flow porque cliente
              // ja foi embora; vale-troca a cliente esta na frente do balcao.
              finalizeSale('');
            } else {
              toast(
                'success',
                'Vale-troca aplicado',
                `Falta ${brl(Math.max(0, fresh.total - totalPago))} pra fechar`,
              );
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

  // PRIORIDADE 1: carrega WHITELIST de vendedoras ativas configuradas em
  // /retaguarda/vendedoras-ativas. Se tem config, usa SÓ ela (filtra local
  // sem hit no Wincred). Senão, fallback pra busca em funcionarios do Wincred.
  // Whitelist fica em estado separado pra evitar loop com `results` (busca live).
  const [whitelist, setWhitelist] = useState<typeof results | null>(null);
  const usingActiveList = (whitelist?.length ?? 0) > 0;

  useEffect(() => {
    if (!storeCode) return;
    let cancelled = false;
    (async () => {
      setSearching(true);
      try {
        const ativas = await api<Array<{ codigo: string; nome: string }>>(
          `/pdv/vendedoras-ativas?storeCode=${encodeURIComponent(storeCode)}`,
        );
        if (cancelled) return;
        if (ativas && ativas.length > 0) {
          // Tem config — guarda whitelist (não toca em `results` pra evitar loop)
          setWhitelist(ativas);
          setTabelaOk(true);
          setLojaFiltered(true);
          setSearching(false);
          return;
        }
        setWhitelist([]); // marca que tentou mas tava vazia
      } catch {
        if (!cancelled) setWhitelist([]);
      }

      // Fallback: busca direto em funcionarios do Wincred
      try {
        const r = await api<{ results: typeof results; table?: string; lojaFiltered?: boolean }>(
          `/pdv/funcionarios-search?q=&limit=20${lojaParam}`,
        );
        if (cancelled) return;
        setResults(r.results || []);
        setTabelaOk(r.results && r.results.length > 0);
        setLojaFiltered(!!r.lojaFiltered);
      } catch {
        if (!cancelled) setTabelaOk(false);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [lojaParam, storeCode]);

  // Refaz busca com debounce ao digitar — SÓ quando NÃO está usando whitelist.
  // (Em modo whitelist, o filtro é local via useMemo abaixo, sem setState — evita
  // loop infinito de re-render que dava "tremida" na tela.)
  useEffect(() => {
    if (usingActiveList) return; // whitelist filtra local — não faz fetch
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
  }, [searchTerm, lojaParam, usingActiveList]);

  // Lista renderizada: se em whitelist, filtra a whitelist local pelo searchTerm;
  // senão, usa results da busca live. useMemo = sem setState = sem loop.
  const visibleResults = useMemo(() => {
    if (usingActiveList && whitelist) {
      const term = searchTerm.trim().toLowerCase();
      if (!term) return whitelist;
      return whitelist.filter((f) => f.nome.toLowerCase().includes(term));
    }
    return results;
  }, [usingActiveList, whitelist, results, searchTerm]);

  // ─── Navegação por teclado (↑↓ Enter) ─────────────────────────────────
  // Cascata navegável: setas movem o highlight, Enter confirma. Reset ao
  // mudar a lista (ex.: novo filtro) pra evitar highlight em índice inválido.
  const [highlight, setHighlight] = useState(0);
  useEffect(() => {
    setHighlight(0);
  }, [visibleResults]);

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (visibleResults.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, visibleResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = visibleResults[highlight];
      if (pick) onSave({ codigo: pick.codigo, nome: pick.nome });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

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
          <div className="text-[10px] text-violet-700 bg-violet-50 border border-violet-200 px-2 py-1 rounded flex items-center gap-2 justify-between">
            <span className="flex items-center gap-1">
              <span className="font-bold">Loja {storeCode}</span>
              <span className="text-violet-500">·</span>
              <span>{usingActiveList ? 'whitelist ativa' : 'filtro de loja'}</span>
            </span>
            <Link
              href="/retaguarda/vendedoras-ativas"
              className="font-bold underline hover:text-violet-900"
              onClick={(e) => e.stopPropagation()}
            >
              ✎ editar lista
            </Link>
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
            onKeyDown={handleKey}
            placeholder="Nome da vendedora… (↑↓ Enter)"
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

        <div
          className="max-h-80 overflow-y-auto p-1"
          ref={(el) => {
            if (!el) return;
            const target = el.querySelector(`[data-vendedora-idx="${highlight}"]`) as HTMLElement | null;
            target?.scrollIntoView({ block: 'nearest' });
          }}
        >
          {visibleResults.length === 0 && !searching && (
            <div className="text-center text-xs text-slate-400 py-6">
              {searchTerm ? 'Nenhuma vendedora encontrada' : 'Carregando…'}
            </div>
          )}
          {visibleResults.length > 0 && (
            <ul className="flex flex-col gap-1" role="listbox" aria-label="Vendedoras">
              {visibleResults.map((f, idx) => {
                const isAtual = !!atual && atual.toUpperCase().includes(f.nome.toUpperCase());
                const isHighlight = idx === highlight;
                const primeiroNome = f.nome.split(/\s+/)[0];
                return (
                  <li key={f.codigo + f.nome} role="option" aria-selected={isHighlight} data-vendedora-idx={idx}>
                    <button
                      type="button"
                      onClick={() => onSave({ codigo: f.codigo, nome: f.nome })}
                      onMouseEnter={() => setHighlight(idx)}
                      title={`${f.nome}${f.codigo ? ' · cód ' + f.codigo : ''}`}
                      className={`w-full flex items-center gap-2 text-left px-2.5 py-2 rounded-lg transition border-2 active:scale-[0.98] ${
                        isHighlight
                          ? 'bg-emerald-500 border-emerald-600 text-white shadow ring-2 ring-emerald-300'
                          : isAtual
                            ? 'bg-emerald-50 border-emerald-400 text-emerald-900'
                            : 'bg-white hover:bg-emerald-50 border-slate-200 hover:border-emerald-300 text-slate-800'
                      }`}
                    >
                      <div className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${
                        isHighlight ? 'bg-white/20 text-white' : 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {primeiroNome.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-bold truncate leading-tight">{f.nome}</div>
                        {f.codigo && (
                          <div className={`text-[9px] ${isHighlight ? 'text-white/80' : 'text-slate-400'}`}>
                            cód {f.codigo}
                          </div>
                        )}
                      </div>
                      {isAtual && !isHighlight && (
                        <span className="text-[9px] font-bold bg-emerald-200 text-emerald-800 px-1.5 py-0.5 rounded">ATUAL</span>
                      )}
                      {isHighlight && (
                        <span className="text-[10px] font-bold text-white/90">↵</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
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
  initial: {
    cpf: string;
    name: string;
    email: string;
    phone: string;
    cep?: string;
    endereco?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
  };
  onClose: () => void;
  onSave: (d: {
    cpf: string;
    name: string;
    email: string;
    phone: string;
    cep?: string;
    endereco?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
  }) => void;
}) {
  const [cpf, setCpf] = useState(initial.cpf);
  const [name, setName] = useState(initial.name);
  const [email, setEmail] = useState(initial.email);
  const [phone, setPhone] = useState(initial.phone);
  // Endereço — essencial pra vendas online (WhatsApp/Insta). Section
  // expansível pra não poluir balcão.
  const [cep, setCep] = useState(initial.cep || '');
  const [endereco, setEndereco] = useState(initial.endereco || '');
  const [numero, setNumero] = useState(initial.numero || '');
  const [complemento, setComplemento] = useState(initial.complemento || '');
  const [bairro, setBairro] = useState(initial.bairro || '');
  const [cidade, setCidade] = useState(initial.cidade || '');
  const [uf, setUf] = useState(initial.uf || '');
  // Auto-expande se já tem algum dado de endereço preenchido
  const [showEndereco, setShowEndereco] = useState(
    !!(initial.cep || initial.endereco || initial.cidade),
  );
  const [cepLoading, setCepLoading] = useState(false);
  const [cepError, setCepError] = useState<string | null>(null);

  // ── ViaCEP lookup ─────────────────────────────────────────────────────
  // Chama API pública gratuita https://viacep.com.br quando CEP completo (8
  // dígitos). Preenche logradouro/bairro/cidade/UF — vendedora só completa
  // número e complemento.
  const lookupCep = async (cepRaw: string) => {
    const clean = cepRaw.replace(/\D/g, '');
    if (clean.length !== 8) return;
    setCepLoading(true);
    setCepError(null);
    try {
      const r = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
      const data = await r.json();
      if (data?.erro) {
        setCepError('CEP não encontrado');
        return;
      }
      // Só preenche se vendedora ainda não preencheu manualmente — não
      // sobrescreve dado já digitado
      if (!endereco) setEndereco(data.logradouro || '');
      if (!bairro) setBairro(data.bairro || '');
      if (!cidade) setCidade(data.localidade || '');
      if (!uf) setUf((data.uf || '').toUpperCase());
    } catch (e) {
      setCepError('Falha ao buscar CEP — preencha manualmente');
    } finally {
      setCepLoading(false);
    }
  };

  // ─── Typeahead: busca por CPF OR nome no Giga ───────────────────────────
  // Aceita: dígitos parciais (CPF) ou texto (nome). Debounce de 300ms.
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState<Array<{
    codCliente: string; nome: string; cpf: string; cidade: string; telefone: string;
  }>>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  // ─── PAINEL VIP: ficha do cliente quando CPF é válido ────────────────────
  // Chama /pdv/customer-resume pra trazer LTV, tier, cashback e direcionamento
  const [resume, setResume] = useState<any>(null);
  const [loadingResume, setLoadingResume] = useState(false);
  useEffect(() => {
    const digits = cpf.replace(/\D/g, '');
    if (digits.length !== 11) { setResume(null); return; }
    setLoadingResume(true);
    api<any>(`/pdv/customer-resume?cpf=${digits}`)
      .then((r) => setResume(r))
      .catch(() => setResume(null))
      .finally(() => setLoadingResume(false));
  }, [cpf]);

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

  const backdropClose = useSmartBackdropClose(onClose);
  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4"
      onMouseDown={backdropClose.onMouseDown}
      onClick={backdropClose.onClick}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-lg w-full max-w-md p-4 space-y-3" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
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

        {/* PAINEL VIP — ficha do cliente quando CPF válido */}
        {loadingResume && cpf.replace(/\D/g, '').length === 11 && (
          <div className="bg-slate-100 rounded-lg p-3 text-center text-xs text-slate-500 animate-pulse">
            Buscando ficha do cliente...
          </div>
        )}
        {resume?.found && resume.customer && (() => {
          const c = resume.customer;
          const cfg = resume.cashbackConfig || {};
          const ltvBrl = (c.ltvCents / 100).toFixed(2).replace('.', ',');
          const ticketBrl = (c.ticketMedioCents / 100).toFixed(2).replace('.', ',');
          const cashbackBrl = (c.cashbackBalanceCents / 100).toFixed(2).replace('.', ',');
          const diasUltima = c.lastOrderAt
            ? Math.floor((Date.now() - new Date(c.lastOrderAt).getTime()) / 86400000)
            : null;
          const tierColors: Record<string, string> = {
            bronze: 'bg-amber-100 text-amber-900 border-amber-400',
            prata: 'bg-slate-200 text-slate-800 border-slate-400',
            ouro: 'bg-yellow-100 text-yellow-900 border-yellow-500',
            diamante: 'bg-violet-100 text-violet-900 border-violet-500',
          };
          const podeUsarCashback = c.cashbackBalanceCents >= (cfg.minimoUsoReais ?? 20) * 100 && cfg.ativo;
          // Direcionamento pra vendedora
          const sugestoes: string[] = [];
          if (c.orderCount === 0) sugestoes.push('🆕 PRIMEIRA COMPRA — atenção VIP, ofereça cashback');
          else if (diasUltima !== null && diasUltima > 180) sugestoes.push(`⚠️ Cliente INATIVA há ${diasUltima} dias — reativação`);
          else if (diasUltima !== null && diasUltima < 30) sugestoes.push(`🔥 Cliente FREQUENTE (última há ${diasUltima}d)`);
          if (c.vipTier === 'diamante') sugestoes.push('💎 DIAMANTE — máxima prioridade');
          else if (c.vipTier === 'ouro') sugestoes.push('🥇 OURO — VIP');
          if (podeUsarCashback) sugestoes.push(`💰 Pode usar R$ ${cashbackBrl} de cashback (até ${cfg.usoMaxPct ?? 30}% da compra)`);
          if (c.bloqueado) sugestoes.push('🚫 CLIENTE BLOQUEADO no Giga — CUIDADO');
          if (c.negativado) sugestoes.push('⚠️ NEGATIVADO no SPC — sem crediário');

          return (
            <div className="border-2 border-violet-300 bg-gradient-to-br from-violet-50 to-pink-50 rounded-xl p-3 space-y-2">
              {/* Cabeçalho com tier + nome */}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-bold text-violet-900 text-sm">{c.name || 'Sem nome'}</div>
                  <div className="text-[10px] text-slate-500">{c.cpf}</div>
                </div>
                <span className={`px-2 py-0.5 text-[11px] font-black uppercase rounded border-2 ${tierColors[c.vipTier] || tierColors.bronze}`}>
                  {c.vipTier}
                </span>
              </div>

              {/* Métricas */}
              <div className="grid grid-cols-3 gap-1.5 text-center">
                <div className="bg-white rounded p-1.5 border border-slate-200">
                  <div className="text-[9px] uppercase text-slate-500">Compras</div>
                  <div className="font-black text-violet-700 text-sm">{c.orderCount}</div>
                </div>
                <div className="bg-white rounded p-1.5 border border-slate-200">
                  <div className="text-[9px] uppercase text-slate-500">LTV</div>
                  <div className="font-black text-violet-700 text-sm">R$ {ltvBrl}</div>
                </div>
                <div className="bg-white rounded p-1.5 border border-slate-200">
                  <div className="text-[9px] uppercase text-slate-500">Ticket</div>
                  <div className="font-black text-violet-700 text-sm">R$ {ticketBrl}</div>
                </div>
              </div>

              {/* Cashback destacado */}
              {c.cashbackBalanceCents > 0 && (
                <div className={`rounded-lg p-2 flex items-center justify-between ${podeUsarCashback ? 'bg-emerald-100 border-2 border-emerald-400' : 'bg-amber-100 border-2 border-amber-400'}`}>
                  <div>
                    <div className="text-[10px] uppercase font-bold text-emerald-900">💰 Cashback disponível</div>
                    <div className="font-black text-lg text-emerald-700">R$ {cashbackBrl}</div>
                    {!podeUsarCashback && (
                      <div className="text-[9px] text-amber-700">Mínimo R$ {cfg.minimoUsoReais ?? 20} pra usar</div>
                    )}
                  </div>
                  {c.cashbackExpiraEm && (
                    <div className="text-right text-[9px] text-slate-600">
                      Vence em<br />
                      <span className="font-bold">{new Date(c.cashbackExpiraEm).toLocaleDateString('pt-BR')}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Última compra */}
              {c.lastOrderAt && (
                <div className="text-[11px] text-slate-700">
                  📅 Última compra: <span className="font-bold">{new Date(c.lastOrderAt).toLocaleDateString('pt-BR')}</span>
                  {diasUltima !== null && <span className="text-slate-500"> ({diasUltima}d atrás)</span>}
                </div>
              )}

              {/* Direcionamento pra vendedora */}
              {sugestoes.length > 0 && (
                <div className="bg-white border border-violet-200 rounded p-2 space-y-1">
                  <div className="text-[9px] uppercase font-bold text-violet-700">💡 Direcionamento</div>
                  {sugestoes.map((s, i) => (
                    <div key={i} className="text-[11px] leading-tight">{s}</div>
                  ))}
                </div>
              )}

              {/* Botão ver ficha completa */}
              <button
                type="button"
                onClick={() => window.open(`/clientes-crm?openId=${c.id}`, '_blank')}
                className="w-full text-center text-[11px] font-bold text-violet-700 hover:text-violet-900 py-1 underline"
              >
                📋 Ver ficha completa do cliente →
              </button>
            </div>
          );
        })()}
        {resume && !resume.found && cpf.replace(/\D/g, '').length === 11 && (
          <div className="bg-sky-50 border border-sky-300 rounded p-2 text-[11px] text-sky-800">
            🆕 Cliente novo — não está no CRM ainda. Preencha os dados pra cadastrar.
          </div>
        )}

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

        {/* ENDEREÇO — section expansível. Essencial pra vendas online (WhatsApp/
            Instagram) onde a loja precisa enviar pelo correio. Lookup automático
            via ViaCEP quando CEP completo. */}
        <div className="border-t pt-2">
          <button
            type="button"
            onClick={() => setShowEndereco((v) => !v)}
            className="w-full flex items-center justify-between px-2 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 rounded"
          >
            <span className="flex items-center gap-2">
              📍 Endereço de entrega
              {!showEndereco && (cep || endereco || cidade) && (
                <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">PREENCHIDO</span>
              )}
            </span>
            <span className="text-xs text-slate-400">
              {showEndereco ? '▲ ocultar' : '▼ expandir'}
            </span>
          </button>

          {showEndereco && (
            <div className="space-y-2 mt-2">
              <div className="bg-cyan-50 border border-cyan-200 rounded p-2 text-[11px] text-cyan-800">
                Obrigatório pra <b>Venda Online</b> (vai pelo correio). Opcional no balcão.
              </div>

              {/* CEP + lookup ViaCEP */}
              <div className="flex gap-2">
                <div className="flex-1">
                  <input
                    value={cep}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 8);
                      setCep(v);
                      if (v.length === 8) lookupCep(v);
                    }}
                    placeholder="CEP (só números)"
                    maxLength={8}
                    inputMode="numeric"
                    className="w-full border rounded px-3 py-2 text-sm font-mono"
                  />
                </div>
                {cepLoading && (
                  <div className="flex items-center px-2">
                    <Loader2 className="w-4 h-4 animate-spin text-cyan-600" />
                  </div>
                )}
              </div>
              {cepError && (
                <div className="text-xs text-rose-600">{cepError}</div>
              )}

              <input
                value={endereco}
                onChange={(e) => setEndereco(e.target.value)}
                placeholder="Logradouro (rua/avenida)"
                className="w-full border rounded px-3 py-2 text-sm"
              />
              <div className="grid grid-cols-3 gap-2">
                <input
                  value={numero}
                  onChange={(e) => setNumero(e.target.value)}
                  placeholder="Nº"
                  className="border rounded px-3 py-2 text-sm"
                />
                <input
                  value={complemento}
                  onChange={(e) => setComplemento(e.target.value)}
                  placeholder="Complemento"
                  className="col-span-2 border rounded px-3 py-2 text-sm"
                />
              </div>
              <input
                value={bairro}
                onChange={(e) => setBairro(e.target.value)}
                placeholder="Bairro"
                className="w-full border rounded px-3 py-2 text-sm"
              />
              <div className="grid grid-cols-3 gap-2">
                <input
                  value={cidade}
                  onChange={(e) => setCidade(e.target.value)}
                  placeholder="Cidade"
                  className="col-span-2 border rounded px-3 py-2 text-sm"
                />
                <input
                  value={uf}
                  onChange={(e) => setUf(e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="UF"
                  maxLength={2}
                  className="border rounded px-3 py-2 text-sm font-mono uppercase"
                />
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => onSave({
            cpf, name, email, phone,
            cep, endereco, numero, complemento, bairro, cidade, uf,
          })}
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
  customerPhone,
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
  customerPhone?: string | null;
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

  // DINHEIRO: sincroniza valorParcial = min(recebido, restante) automaticamente.
  // Vendedora só precisa digitar quanto a cliente entregou — sistema calcula
  // sozinho quanto vai pagar dessa forma (limitado ao restante) e quanto sobra
  // de troco. Sem mexer no campo "Valor parcial" manualmente.
  useEffect(() => {
    if (selected !== 'dinheiro') return;
    const recNum = Number((recebido || '0').replace(/\./g, '').replace(',', '.')) || 0;
    if (recNum <= 0) return;
    const valorPgto = Math.min(recNum, restante);
    setValorParcial(valorPgto.toFixed(2).replace('.', ','));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recebido, selected]);
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

  // VENDA ONLINE — sub-tipo (PIX direto ou Link externo). Vendedora informa
  // só pra ter no histórico. Sem geração de cobrança, sem NFC-e automática.
  const [vendaOnlineTipo, setVendaOnlineTipo] = useState<'pix' | 'link' | 'pagarme_link' | null>(null);
  // Estado do Link Pagar.me gerado (URL + status)
  const [pagarmeLink, setPagarmeLink] = useState<{
    pagarmeOrderId: string;
    paymentUrl: string;
    expiresAt: string;
  } | null>(null);
  const [pagarmeLinkLoading, setPagarmeLinkLoading] = useState(false);
  const [pagarmeLinkPaid, setPagarmeLinkPaid] = useState(false);
  const [pagarmeLinkCopied, setPagarmeLinkCopied] = useState(false);

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
    // VENDA ONLINE — exige CPF do cliente + escolher PIX ou LINK
    if (selected === 'venda_online') {
      if (!customerCpf) {
        toast(
          'warning',
          'CPF obrigatório',
          'Venda online sempre identifica a cliente (F5).',
        );
        return;
      }
      if (!vendaOnlineTipo) {
        toast(
          'warning',
          'Escolha o tipo da venda online',
          'PIX direto / Link externo / Link Pagar.me.',
        );
        return;
      }
      // Link Pagar.me: exige link gerado E pago confirmado pelo webhook
      if (vendaOnlineTipo === 'pagarme_link') {
        if (!pagarmeLink) {
          toast(
            'warning',
            'Gere o link Pagar.me primeiro',
            'Clique em "Gerar Link Pagar.me" pra criar a URL pra cliente pagar.',
          );
          return;
        }
        if (!pagarmeLinkPaid) {
          toast(
            'warning',
            'Aguardando pagamento',
            'O sistema confirma automaticamente quando o cliente pagar.',
          );
          return;
        }
      }
    }
    // PIX: SEMPRE exige QR gerado (clique no botão "PIX"). Se for provider
    // Pagar.me/PagBank, exige TAMBÉM confirmação automática (pixPaid=true via
    // webhook/polling) — não deixa fechar venda "no escuro". Provider local
    // (chave celular) não tem webhook → vendedora confirma manualmente via
    // botão "Marcar como pago" (linha ~4063).
    if (selected === 'pix') {
      if (!pixCharge) {
        toast(
          'warning',
          'Gere o QR Code primeiro',
          'Clique no botão PIX pra gerar o QR Code. Sem QR, a venda não pode ser finalizada.',
        );
        return;
      }
      if (
        (pixCharge.provider === 'pagarme' || pixCharge.provider === 'pagbank') &&
        !pixPaid
      ) {
        toast(
          'warning',
          'Aguardando pagamento PIX',
          'O sistema confirma automaticamente quando o cliente pagar. Aguarde.',
        );
        return;
      }
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
      // BUG FIX: crediário precisa salvar a data escolhida pra impressão de
      // promissórias/carnê. Antes ficava só no endpoint /crediario (que grava
      // no Giga) — payment.details ficava sem, e o PDF caía no fallback D+30.
      if (selected === 'crediario') {
        details.primeiroVencimento = credVencto;
        details.entrada = Math.max(
          0,
          Math.round((Number((credEntrada || '0').replace(/\./g, '').replace(',', '.')) || 0) * 100) / 100,
        );
        details.observacao = credObs;
      }
    }
    if (selected === 'dinheiro') {
      const trocoP = recebidoNum > valor ? recebidoNum - valor : 0;
      details.recebido = recebidoNum || valor;
      details.troco = trocoP;
    }
    if (selected === 'pix') {
      // pixCharge é GARANTIDO existir aqui — bloqueio acima impede passar sem.
      // (Mantém else defensivo apenas pra log; nunca deveria executar.)
      if (pixCharge) {
        details.pixTxid = pixCharge.txid;
        details.pixChave = pixCharge.chave;
        details.pixProvider = pixCharge.provider;
        details.pixPaidByWebhook = pixPaid;
      } else {
        // (não deve cair aqui — bloqueio em adicionarPagamento garante pixCharge)
        details.pixManual = true;
      }
    }
    if (selected === 'venda_online') {
      // Só pra histórico — não dispara cobrança real
      details.tipo = vendaOnlineTipo; // 'pix' | 'link' | 'pagarme_link'
      details.origem = 'whatsapp_instagram';
      if (vendaOnlineTipo === 'pagarme_link' && pagarmeLink) {
        details.pagarmeOrderId = pagarmeLink.pagarmeOrderId;
        details.pagarmePaymentUrl = pagarmeLink.paymentUrl;
        details.paidByWebhook = pagarmeLinkPaid;
      }
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
      // PRIORIDADE de valor pro QR Code PIX:
      //  1. pixValor explicito (regenerar com valor especifico)
      //  2. valorParcial digitado pela vendedora (multi-pagamento — ex: 100 dinheiro + 400 PIX)
      //  3. restante (fallback — ja desconta vale-troca/pagamentos anteriores)
      //  4. total (fallback final pra nunca gerar PIX de 0)
      const valorDigitado = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.')) || 0;
      const valor =
        pixValor && pixValor > 0
          ? pixValor
          : valorDigitado > 0 && valorDigitado <= restante + 0.01
          ? valorDigitado
          : restante > 0
          ? restante
          : total;
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

  // ── AUTO-GERAR QR AO ABRIR MODAL EM PIX ──
  // Quando o modal abre já com selected='pix' (filtro PIX direto da sidebar
  // do PDV), gera o QR Code IMEDIATAMENTE — sem precisar a vendedora clicar
  // no botão "PIX". Roda 1x quando entra na tela. Se trocar de forma e voltar
  // pra PIX, o selectMethod já dispara generatePix sozinho.
  const autoPixTriggeredRef = useRef(false);
  useEffect(() => {
    if (autoPixTriggeredRef.current) return;
    if (selected !== 'pix') return;
    if (pixCharge || pixLoading) return;
    autoPixTriggeredRef.current = true;
    generatePix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

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
        const r = await api<{ status: string; isPaid?: boolean; isFailed?: boolean }>(endpoint);
        if (cancelled) return;
        if (r.status === 'paid') {
          setPixPaid(true);
        } else if (r.status === 'failed' || r.status === 'canceled' || r.isFailed) {
          // FIX CRÍTICO: PIX falhou na Pagar.me — alerta a vendedora e NÃO
          // finaliza a venda. Antes desse fix, status revertido pro failed
          // depois de webhook paid podia deixar a venda finalizada errada.
          toast(
            'error',
            'PIX falhou / cancelado',
            'A Pagar.me reportou erro no pagamento. NÃO finalize — peça pra cliente pagar de novo ou trocar de forma.',
          );
          // Limpa pra forçar nova geração de QR
          setPixCharge(null);
        }
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

  // ── Polling Link Pagar.me — confere status a cada 3s enquanto cliente
  //    ainda não pagou. Quando webhook do Pagar.me bater "paid", marca
  //    pagarmeLinkPaid=true e habilita o botão Finalizar. Reusa o mesmo
  //    endpoint do PIX (status é por saleId).
  useEffect(() => {
    if (!pagarmeLink || pagarmeLinkPaid) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api<{ status: string; isPaid?: boolean; isFailed?: boolean }>(
          `/pagarme/pix/status/${saleId}`,
        );
        if (cancelled) return;
        if (r.status === 'paid' || r.isPaid) {
          setPagarmeLinkPaid(true);
        } else if (r.status === 'failed' || r.status === 'canceled' || r.isFailed) {
          toast(
            'error',
            'Link falhou / cancelado',
            'Pagar.me reportou erro. Gere um novo link.',
          );
          setPagarmeLink(null);
        }
      } catch {
        // silencioso — polling tolerante
      }
    };
    tick();
    // Intervalo maior (3s) — link é assíncrono, cliente leva minutos pra pagar
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pagarmeLink, pagarmeLinkPaid, saleId, toast]);

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
  // BUG FIX: troco é sobre `restante` (o que falta cobrar), NÃO `total`.
  // Cenário: total R$ 150, vale-troca R$ 100 aplicado, restante R$ 50.
  // Cliente entrega R$ 100 em dinheiro → troco DEVE ser R$ 50, não R$ -50.
  const troco = selected === 'dinheiro' && recebidoNum > restante ? recebidoNum - restante : 0;

  // Reset bandeira ao trocar de método
  const selectMethod = (id: string) => {
    setSelected(id);
    setBandeira(null);
    setParcelas(1);
    setPixCharge(null);
    setPixPaid(false);
    setVendaOnlineTipo(null);
    if (id === 'pix') {
      generatePix();
    }
  };

  const canConfirm = useMemo(() => {
    if (!selected) return false;
    if (selected === 'crediario' && !customerCpf) return false;
    // BUG FIX: valida recebido contra `restante`, NÃO `total`. Com vale-troca
    // aplicado, cliente só precisa cobrir o que falta — não a venda inteira.
    if (selected === 'dinheiro' && recebidoNum < restante) return false;
    if (needsBandeira && !bandeira) return false;
    if (selected === 'venda_online' && (!customerCpf || !vendaOnlineTipo)) return false;
    return true;
  }, [selected, bandeira, needsBandeira, recebidoNum, restante, customerCpf, vendaOnlineTipo]);

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
    // BUG FIX: usa `restante` em vez de `total` pra parcelas — quando vale-troca
    // ou pagamentos parciais já abateram parte, parcelas devem ser sobre o que
    // FALTA cobrar, não sobre a venda inteira.
    const valorPraCobrar = restante > 0 ? restante : total;
    if (selected === 'credito' || selected === 'crediario') {
      details.parcelas = parcelas;
      const calc = calcularParcelas(valorPraCobrar, parcelas);
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
      // BUG FIX: financia sobre `restante`, NÃO `total`. Vale-troca/parciais
      // já abatidos não devem entrar no parcelamento.
      const valorFinanciado = Math.max(0, Math.round((valorPraCobrar - entradaNum) * 100) / 100);
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

  const backdropClose = useSmartBackdropClose(onClose);
  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-2 sm:p-4"
      onMouseDown={backdropClose.onMouseDown}
      onClick={backdropClose.onClick}
    >
      {/* Modal: layout flex-col com header/body/footer separados.
         Footer sticky no FUNDO pra botão "Adicionar/Finalizar" SEMPRE aparecer
         (antes ficava cortado em telas baixas com 12 parcelas + card grande). */}
      <div
        className="bg-white rounded-t-2xl sm:rounded-lg w-full max-w-lg sm:max-w-2xl flex flex-col max-h-[95vh] sm:max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* HEADER fixo */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-slate-100 shrink-0">
          <h2 className="font-semibold flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> Pagamento
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        {/* BODY scrollável */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-2 sm:py-3 space-y-2 sm:space-y-3 min-h-0">

        {/* Cabeçalho VISUAL: barra de progresso colorida por forma + valores grandes.
            Mostra de uma vez: quanto foi pago, quanto falta, e o split visual em
            fatias coloridas (cada forma de pagamento tem cor). Quando completa 100%,
            barra fica toda verde com check. */}
        <div className={`rounded-xl px-3 py-2 transition-colors ${pago100 ? 'bg-emerald-50 border border-emerald-300' : payments.length > 0 ? 'bg-amber-50 border border-amber-300' : 'bg-slate-50 border border-slate-200'}`}>
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wide">
              {pago100 ? '✓ Pago' : payments.length > 0 ? 'Falta pagar' : 'Total a pagar'}
            </span>
            <span className={`text-2xl font-black tabular-nums leading-none ${pago100 ? 'text-emerald-600' : payments.length > 0 ? 'text-rose-700' : 'text-slate-800'}`}>
              {pago100 ? brl(total) : brl(restante)}
            </span>
          </div>
          {/* Barra de progresso — fatias coloridas por forma de pagamento */}
          <div className="h-2.5 bg-slate-200 rounded-full overflow-hidden flex">
            {payments.map((p, i) => {
              const pct = (p.valor / total) * 100;
              const colorMap: Record<string, string> = {
                dinheiro: 'bg-emerald-500',
                pix: 'bg-cyan-500',
                credito: 'bg-violet-500',
                debito: 'bg-blue-500',
                crediario: 'bg-rose-500',
                vale_troca: 'bg-teal-500',
              };
              const cor = colorMap[p.method?.toLowerCase()] || 'bg-slate-500';
              return (
                <div
                  key={p.id || i}
                  className={`${cor} h-full transition-all`}
                  style={{ width: `${pct}%` }}
                  title={`${p.method} · ${brl(p.valor)}`}
                />
              );
            })}
          </div>
          {payments.length > 0 && !pago100 && (
            <div className="flex items-baseline justify-between mt-1.5 text-[11px]">
              <span className="text-slate-500">Total {brl(total)}</span>
              <span className="text-emerald-700 font-bold tabular-nums">{brl(jaPago)} já pago</span>
            </div>
          )}
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

        {/* Lista de pagamentos parciais — cada um com bolinha colorida igual barra */}
        {payments.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase font-semibold text-slate-500">
              Formas adicionadas ({payments.length})
            </div>
            {payments.map((p) => {
              const det = p.details ? JSON.parse(p.details) : {};
              const colorMap: Record<string, string> = {
                dinheiro: 'bg-emerald-500',
                pix: 'bg-cyan-500',
                credito: 'bg-violet-500',
                debito: 'bg-blue-500',
                crediario: 'bg-rose-500',
                vale_troca: 'bg-teal-500',
              };
              const cor = colorMap[p.method?.toLowerCase()] || 'bg-slate-500';
              const label = p.method === 'MULTIPLO' ? 'Múltiplo' : (p.method || '').toUpperCase();
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-2 bg-white border-2 border-slate-200 rounded-lg px-2.5 py-2"
                >
                  <span className={`w-3 h-3 rounded-full shrink-0 ${cor}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-bold text-slate-800">{label}</span>
                      {det.bandeira && (
                        <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                          {det.bandeira}
                        </span>
                      )}
                      {det.parcelas > 1 && (
                        <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                          {det.parcelas}× {brl(p.valor / det.parcelas)}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="font-black text-emerald-700 tabular-nums text-base">
                    {brl(p.valor)}
                  </span>
                  <button
                    onClick={() => removerPagamento(p.id)}
                    className="text-rose-500 hover:bg-rose-50 p-1 rounded shrink-0"
                    title="Remover"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
            {/* CTA grande: vai escolher próxima forma */}
            {!pago100 && (
              <div className="bg-violet-50 border-2 border-violet-300 rounded-lg px-3 py-2 flex items-center gap-2 mt-2">
                <span className="text-violet-700 font-black text-sm">↓</span>
                <span className="text-xs font-bold text-violet-900">
                  Escolha como pagar os {brl(restante)} restantes
                </span>
              </div>
            )}
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
                {effectiveFilter === 'all' && (payments.length > 0 ? `2ª forma — pagar os ${brl(restante)} que faltam` : 'Escolha a forma de pagamento')}
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
                const disabled =
                  (p.id === 'crediario' && !customerCpf) ||
                  (p.id === 'venda_online' && !customerCpf);
                // Venda online tem visual diferente (teal) pra destacar
                const isVendaOnline = p.id === 'venda_online';
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => !disabled && selectMethod(p.id)}
                    disabled={disabled}
                    className={`px-3 py-2 rounded-lg border-2 text-sm font-bold transition-colors flex items-center justify-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed ${
                      isSelected
                        ? isVendaOnline
                          ? 'border-teal-600 bg-teal-50 text-teal-800'
                          : 'border-emerald-600 bg-emerald-50 text-emerald-800'
                        : isVendaOnline
                        ? 'border-teal-300 bg-teal-50/40 text-teal-700 hover:border-teal-400'
                        : 'border-slate-200 hover:border-slate-300 text-slate-600'
                    }`}
                    title={
                      disabled
                        ? p.id === 'crediario'
                          ? 'Crediário exige CPF do cliente'
                          : 'Venda online exige CPF do cliente (F5)'
                        : ''
                    }
                  >
                    <Icon className="w-4 h-4" />
                    {p.label}
                  </button>
                );
              })}
            </div>

            {/* Input de valor parcial — SEMPRE visivel quando ha metodo selecionado.
                Antes ficava oculto no 1o pagamento e gerava bug: vendedora confirmava
                o valor TOTAL achando que era o que o cliente pagou em PIX/dinheiro. */}
            {selected && (() => {
              const valorAtualNum = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.')) || 0;
              const isParcial = valorAtualNum > 0 && valorAtualNum < restante - 0.01;
              const restanteApos = Math.max(0, restante - valorAtualNum);
              return (
                <div className={`pt-2 mt-2 border-t-2 ${isParcial ? 'border-amber-300' : 'border-slate-100'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] text-slate-700 uppercase font-bold">
                      Quanto cobrar com {selected.toUpperCase()}?
                    </label>
                    <span className="text-[10px] text-slate-500">
                      Restante: <b className="text-slate-800">{brl(restante)}</b>
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={valorParcial}
                      onChange={(e) => setValorParcial(e.target.value)}
                      placeholder={restante.toFixed(2).replace('.', ',')}
                      className={`flex-1 border-2 rounded px-3 py-2 text-base font-mono font-bold ${
                        isParcial ? 'border-amber-400 bg-amber-50' : 'border-slate-300'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setValorParcial(restante.toFixed(2).replace('.', ','))}
                      className="px-3 py-2 text-xs bg-emerald-100 hover:bg-emerald-200 rounded font-bold text-emerald-700 whitespace-nowrap"
                      title="Preencher com o restante"
                    >
                      = TUDO
                    </button>
                    <button
                      type="button"
                      onClick={() => setValorParcial((restante / 2).toFixed(2).replace('.', ','))}
                      className="px-3 py-2 text-xs bg-slate-100 hover:bg-slate-200 rounded font-bold text-slate-700 whitespace-nowrap"
                      title="Dividir restante por 2"
                    >
                      ½
                    </button>
                  </div>
                  {isParcial && (
                    <div className="mt-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 flex items-center gap-1">
                      <span>⚠️</span>
                      <span>Pagamento parcial — vai sobrar <b>{brl(restanteApos)}</b> pra cobrar em outra forma</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {/* Sub-bandeiras (débito/crédito) */}
        {needsBandeira && (
          <div className="space-y-2 pt-2 border-t">
            <label className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider">Bandeira</label>
            <div className={`grid gap-2 ${bandeiras.length === 4 ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {bandeiras.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBandeira(b)}
                  className={`py-2 px-2 rounded-lg border-2 transition-all flex items-center justify-center min-h-[44px] ${
                    bandeira === b
                      ? 'border-emerald-600 bg-emerald-50 shadow-md'
                      : 'border-slate-200 hover:border-slate-300 bg-white'
                  }`}
                >
                  <BandeiraLogo brand={b} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* VENDA ONLINE — sub-tipo PIX direto ou Link externo (só registro,
            sem geração de cobrança real). Aviso explícito + 2 botões grandes. */}
        {selected === 'venda_online' && (
          <div className="space-y-3 pt-2 border-t">
            <div className="bg-teal-50 border border-teal-300 rounded-lg p-3 text-xs text-teal-900">
              <div className="font-bold flex items-center gap-1.5 mb-1">
                <Globe className="w-3.5 h-3.5" />
                Venda Online — sem gerar cobrança
              </div>
              <div className="text-teal-800 leading-snug">
                Pagamento já chegou na conta da loja (WhatsApp/Instagram).
                PDV só registra venda, vendedora e cliente. <b>Não emite NFC-e</b>.
                Estoque é baixado normalmente.
              </div>
            </div>
            <label className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider">
              Como foi feita a venda online?
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => { setVendaOnlineTipo('pix'); setPagarmeLink(null); }}
                className={`py-3 px-2 rounded-lg border-2 font-bold text-xs flex flex-col items-center gap-1 transition-all ${
                  vendaOnlineTipo === 'pix'
                    ? 'border-teal-600 bg-teal-100 text-teal-900 shadow-md'
                    : 'border-slate-200 hover:border-teal-300 bg-white text-slate-700'
                }`}
              >
                <QrCode className="w-5 h-5" />
                PIX direto
                <span className="text-[9px] font-normal text-slate-500 leading-tight">
                  Já pago p/ conta
                </span>
              </button>
              <button
                type="button"
                onClick={() => { setVendaOnlineTipo('link'); setPagarmeLink(null); }}
                className={`py-3 px-2 rounded-lg border-2 font-bold text-xs flex flex-col items-center gap-1 transition-all ${
                  vendaOnlineTipo === 'link'
                    ? 'border-teal-600 bg-teal-100 text-teal-900 shadow-md'
                    : 'border-slate-200 hover:border-teal-300 bg-white text-slate-700'
                }`}
              >
                <ArrowUpRight className="w-5 h-5" />
                Link externo
                <span className="text-[9px] font-normal text-slate-500 leading-tight">
                  Já pago (outro)
                </span>
              </button>
              <button
                type="button"
                onClick={() => setVendaOnlineTipo('pagarme_link')}
                className={`py-3 px-2 rounded-lg border-2 font-bold text-xs flex flex-col items-center gap-1 transition-all ${
                  vendaOnlineTipo === 'pagarme_link'
                    ? 'border-violet-600 bg-violet-100 text-violet-900 shadow-md ring-2 ring-violet-300'
                    : 'border-violet-400 hover:border-violet-500 bg-violet-50 text-violet-800'
                }`}
              >
                <span className="text-base">🔗</span>
                Link Pagar.me
                <span className="text-[9px] font-normal text-violet-600 leading-tight font-bold">
                  Gerar agora
                </span>
              </button>
            </div>
            {!customerCpf && (
              <div className="bg-rose-50 border border-rose-300 text-rose-800 text-xs rounded p-2 font-semibold">
                ⚠ CPF do cliente é obrigatório. Aperte F5 pra identificar.
              </div>
            )}

            {/* ── PAINEL: Link Pagar.me — gera URL + cliente paga + webhook ── */}
            {vendaOnlineTipo === 'pagarme_link' && customerCpf && (
              <div className="border-2 border-violet-300 rounded-lg p-2 bg-violet-50/30 space-y-2">
                {!pagarmeLink ? (
                  <>
                    <button
                      type="button"
                      disabled={pagarmeLinkLoading}
                      onClick={async () => {
                        setPagarmeLinkLoading(true);
                        try {
                          const r = await api<{
                            pagarmeOrderId: string;
                            paymentUrl: string;
                            expiresAt: string;
                          }>('/pagarme/checkout/create', {
                            method: 'POST',
                            body: JSON.stringify({
                              saleId,
                              valor: restante > 0 ? restante : total,
                              storeCode,
                              customerName,
                              customerCpf,
                              customerEmail,
                              maxInstallments: 6,
                              expiresInMinutes: 1440, // 24h
                              acceptPix: true,
                              acceptCreditCard: true,
                            }),
                          });
                          setPagarmeLink(r);
                        } catch (e: any) {
                          toast('error', 'Erro ao gerar link Pagar.me', e?.message || 'Tente de novo');
                        } finally {
                          setPagarmeLinkLoading(false);
                        }
                      }}
                      className="w-full py-3 bg-violet-600 hover:bg-violet-700 text-white font-bold rounded-lg flex items-center justify-center gap-2 disabled:opacity-60"
                    >
                      {pagarmeLinkLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Gerando link...
                        </>
                      ) : (
                        <>
                          🔗 Gerar Link Pagar.me — {brl(restante > 0 ? restante : total)}
                        </>
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    {/* Linha 1: URL compacta + status */}
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-violet-700">
                      <span>🔗 LINK GERADO · 24h</span>
                      {pagarmeLinkPaid && (
                        <span className="bg-emerald-500 text-white px-1.5 py-0.5 rounded animate-pulse">✓ PAGO</span>
                      )}
                    </div>
                    <div className="bg-white border border-violet-300 rounded px-2 py-1 font-mono text-[10px] text-violet-900 truncate">
                      {pagarmeLink.paymentUrl}
                    </div>
                    {/* Linha 2: 4 botões em grid compacto */}
                    <div className="grid grid-cols-4 gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(pagarmeLink.paymentUrl);
                          setPagarmeLinkCopied(true);
                          setTimeout(() => setPagarmeLinkCopied(false), 2000);
                        }}
                        className="py-1.5 bg-violet-600 hover:bg-violet-700 text-white text-[10px] font-bold rounded flex flex-col items-center"
                      >
                        <span>📋</span>
                        <span>{pagarmeLinkCopied ? 'OK!' : 'Copiar'}</span>
                      </button>
                      <a
                        href={`https://wa.me/${(customerPhone || '').replace(/\D/g, '') ? `55${(customerPhone || '').replace(/\D/g, '')}` : ''}?text=${encodeURIComponent(
                          `Olá ${customerName?.split(' ')[0] || ''}! Link pra pagamento (${brl(restante > 0 ? restante : total)}):\n\n${pagarmeLink.paymentUrl}\n\nPIX ou cartão até 12x sem juros. Expira em 24h.`,
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="py-1.5 bg-green-600 hover:bg-green-700 text-white text-[10px] font-bold rounded flex flex-col items-center"
                      >
                        <span>📱</span>
                        <span>WhatsApp</span>
                      </a>
                      <button
                        type="button"
                        disabled={pagarmeLinkPaid}
                        onClick={async () => {
                          try {
                            const r = await api<{ status: string; isPaid?: boolean }>(
                              `/pagarme/pix/check/${pagarmeLink.pagarmeOrderId}`,
                              { method: 'POST' },
                            );
                            if (r.isPaid || r.status === 'paid') {
                              setPagarmeLinkPaid(true);
                              toast('success', 'Pago!', 'Aperte FINALIZAR.');
                            } else {
                              toast('info', `Status: ${r.status}`, 'Ainda não foi pago.');
                            }
                          } catch (e: any) {
                            toast('error', 'Erro ao conferir', e?.message || 'Tente de novo');
                          }
                        }}
                        className="py-1.5 bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-[10px] font-bold rounded flex flex-col items-center"
                      >
                        <span>🔄</span>
                        <span>Conferir</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onLater()}
                        className="py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-[10px] font-bold rounded flex flex-col items-center"
                      >
                        <span>🚪</span>
                        <span>Liberar</span>
                      </button>
                    </div>
                    {/* Hint compacto */}
                    {!pagarmeLinkPaid && (
                      <div className="text-[10px] text-amber-700 text-center italic">
                        Cliente demora? Aperte "Liberar" — alerta no topo qdo pagar.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Detalhes dinheiro — simplificado.
            Antes: 2 inputs (Valor a receber + Valor recebido) que confundia.
            Agora: 1 input só ("Quanto a cliente entregou") + cálculo automático.
            O `valorParcial` (forma de pagamento) é sincronizado automaticamente
            via useEffect — se cliente entrega > restante: paga o restante e
            mostra troco. Se entrega < restante: paga o que entregou e o resto
            vai pra próxima forma. */}
        {selected === 'dinheiro' && (() => {
          const recebidoLocal = Number((recebido || '0').replace(/\./g, '').replace(',', '.')) || 0;
          const troco = recebidoLocal > restante
            ? Math.round((recebidoLocal - restante) * 100) / 100
            : 0;
          const faltam = recebidoLocal > 0 && recebidoLocal < restante
            ? Math.round((restante - recebidoLocal) * 100) / 100
            : 0;
          return (
            <div className="pt-2 border-t">
              <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-3 space-y-3">
                <div>
                  <label className="text-xs uppercase font-bold text-amber-900 mb-1.5 block">
                    Quanto a cliente entregou?
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={recebido}
                    onChange={(e) => setRecebido(e.target.value)}
                    placeholder={restante.toFixed(2).replace('.', ',')}
                    className="w-full px-3 py-3 text-3xl font-black text-emerald-700 tabular-nums bg-white border-2 border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-500"
                    autoFocus
                  />
                  <div className="text-[10px] text-amber-700 mt-1 text-right">
                    Total a pagar: <b className="tabular-nums">{brl(restante)}</b>
                  </div>
                </div>
                {troco > 0 && (
                  <div className="bg-emerald-600 text-white rounded-lg p-3 flex items-center justify-between shadow-md">
                    <span className="text-sm font-bold uppercase tracking-wide">💰 Troco</span>
                    <span className="text-3xl font-black tabular-nums">{brl(troco)}</span>
                  </div>
                )}
                {faltam > 0 && (
                  <div className="bg-rose-50 border-2 border-rose-300 text-rose-800 rounded-lg p-2.5 flex items-center justify-between">
                    <span className="text-xs font-bold uppercase">Faltam (pra próxima forma)</span>
                    <span className="text-xl font-black tabular-nums">{brl(faltam)}</span>
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
          // Base de cálculo: parte do valorParcial (que default = restante).
          // SPLIT-AWARE: antes usava `total` (venda inteira) — bug em split
          // pq mostrava parcelas baseadas no total quando ja tinha pagamentos
          // parciais. Ex: venda 1000 com 500 pagos → mostrava 4× R$ 250
          // (baseado em 1000) quando deveria ser 4× R$ 125 (baseado em 500).
          //
          // Crediário continua descontando entrada antes de parcelar.
          const valorBase = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.')) || restante;
          const ent = selected === 'crediario'
            ? (Number((credEntrada || '0').replace(/\./g, '').replace(',', '.')) || 0)
            : 0;
          const baseTotal = Math.max(0, valorBase - ent);
          return (
            <div className="space-y-1.5 pt-1.5 border-t">
              <label className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider flex items-center justify-between">
                <span>Parcelas (sem juros)</span>
                {selected === 'crediario' && ent > 0 && (
                  <span className="normal-case text-slate-500 text-[9px]">
                    Financiando {brl(baseTotal)} (entrada {brl(ent)})
                  </span>
                )}
              </label>
              {/* PDV2: COLUNA ÚNICA — uma linha por parcela, leitura limpa
                  de cima pra baixo ("3× de R$ 15,93"). Linha selecionada
                  vira verde. Dica de teclado: 1-9 selecionam direto. */}
              <div className="flex flex-col gap-1">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((p) => {
                  const calc = calcularParcelas(baseTotal, p);
                  const valorMostrar = calc.iguais;
                  const todasIguais = calc.iguais === calc.ultima;
                  const ativo = parcelas === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setParcelas(p)}
                      className={`flex items-center justify-between gap-3 px-3 sm:px-4 py-2 rounded-lg transition-all border-2 shrink-0 ${
                        ativo
                          ? 'bg-emerald-600 border-emerald-700 text-white shadow-md'
                          : 'bg-white border-slate-200 hover:border-emerald-400 hover:bg-emerald-50 text-slate-700'
                      }`}
                    >
                      <span className={`text-sm font-black tabular-nums leading-none w-9 text-left shrink-0 ${
                        ativo ? 'text-white' : 'text-emerald-700'
                      }`}>{p}×</span>
                      <span className={`flex-1 text-left text-[11px] uppercase tracking-wide font-semibold ${
                        ativo ? 'text-white/85' : 'text-slate-400'
                      }`}>
                        {p === 1 ? 'à vista' : todasIguais ? 'de' : `de · última ${brl(calc.ultima)}`}
                      </span>
                      <span className={`text-base font-black tabular-nums leading-none ${
                        ativo ? 'text-white' : 'text-slate-800'
                      }`}>
                        {p === 1 ? brl(baseTotal) : brl(valorMostrar)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* PDV2: card-resumo verde REMOVIDO — redundante com a linha
                  selecionada (que já destaca Nx + valor). A info de "última
                  parcela ajustada" foi pra dentro da própria linha. */}
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

                {/* Regerar QR — se vendedora mudou o valorParcial depois de gerar */}
                {(() => {
                  const valorDigitado = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.')) || 0;
                  // Backend salva como pagarmeValor / valor — comparamos com o valor digitado.
                  // Se o QR foi gerado com um valor diferente do atual (mais ou menos), avisa.
                  const valorEsperado = valorDigitado > 0 ? valorDigitado : (restante > 0 ? restante : total);
                  // Sem acesso direto ao valor do QR — comparamos com o que SERIA gerado agora.
                  // Botao sempre disponivel pra regerar com valor atual.
                  return !pixPaid && (
                    <button
                      type="button"
                      onClick={() => {
                        autoPixTriggeredRef.current = false;
                        setPixCharge(null);
                        generatePix(valorEsperado);
                      }}
                      disabled={pixLoading}
                      className="w-full px-3 py-2 mt-1 bg-amber-100 hover:bg-amber-200 text-amber-900 rounded text-xs font-bold flex items-center justify-center gap-1 transition-colors disabled:opacity-40"
                      title="Gera novo QR com o valor atualmente digitado no campo Valor"
                    >
                      🔄 Regerar QR com {brl(valorEsperado)}
                    </button>
                  );
                })()}

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
            const sobra = restante - valorAtualNum;
            const labelMain = vaiFinalizar
              ? `✓ FINALIZAR · ${brl(valorAtualNum)}`
              : selected === 'pix'
                ? `Recebi o PIX · ${brl(valorAtualNum)} → faltam ${brl(sobra)}`
                : `+ Adicionar ${brl(valorAtualNum)} · faltam ${brl(sobra)}`;
            return (
              <button
                onClick={adicionarPagamento}
                disabled={
                  addingPayment ||
                  !valorParcial ||
                  (needsBandeira && !bandeira) ||
                  (selected === 'crediario' && !customerCpf)
                }
                className={`w-full px-3 py-4 font-black rounded-xl text-base disabled:opacity-40 flex items-center justify-center gap-2 transition-all shadow-md ${
                  vaiFinalizar
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white ring-4 ring-emerald-300/60 text-lg'
                    : 'bg-amber-500 hover:bg-amber-600 text-white'
                }`}
              >
                {addingPayment ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : vaiFinalizar ? (
                  <Check className="w-6 h-6" />
                ) : null}
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
              {finalizing ? 'Finalizando...' : 'Finalizar venda'}
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
/** Handle pra parent forçar flush do CPF antes de emitir NFC-e */
export type CpfNaNotaHandle = {
  /** Salva o CPF se houver um input válido não persistido. Retorna true se salvou. */
  flushPendingSave: () => Promise<boolean>;
  /** Retorna true se há CPF digitado mas ainda não salvo no banco */
  hasUnsavedCpf: () => boolean;
};

const CpfNaNotaInput = React.forwardRef<
  CpfNaNotaHandle,
  { sale: Sale; onUpdated: (s: Sale) => void }
>(function CpfNaNotaInput({ sale, onUpdated }, ref) {
  const { toast } = usePdvToast();
  const [editing, setEditing] = useState(false);
  const [cpfInput, setCpfInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastSavedCpf, setLastSavedCpf] = useState<string | null>(sale.customerCpf || null);

  // Formata CPF pra exibição: 28665529896 → 286.655.298-96
  const fmtCpf = (raw: string | null) => {
    if (!raw) return '';
    const d = String(raw).replace(/\D/g, '');
    if (d.length === 11) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
    return d;
  };

  // Salva diretamente um CPF passado por parâmetro (versão pra debounce/flush)
  async function salvarCpfDireto(cpfLimpo: string, opts?: { silent?: boolean }): Promise<boolean> {
    if (cpfLimpo.length !== 11) {
      if (!opts?.silent) toast('error', 'CPF inválido', 'Digita os 11 dígitos do CPF');
      return false;
    }
    if (cpfLimpo === lastSavedCpf) return true; // já salvo, não precisa
    setSaving(true);
    try {
      await api(`/pdv/sales/${sale.id}/customer`, {
        method: 'PATCH',
        body: JSON.stringify({ cpf: cpfLimpo }),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      onUpdated(fresh);
      setLastSavedCpf(cpfLimpo);
      setEditing(false);
      setCpfInput('');
      if (!opts?.silent) toast('success', 'CPF adicionado', 'Vai aparecer na NFC-e');
      return true;
    } catch (e: any) {
      toast('error', 'Falha ao salvar CPF', e?.message || String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function salvarCpf() {
    const cpfLimpo = cpfInput.replace(/\D/g, '');
    await salvarCpfDireto(cpfLimpo);
  }

  // ─── AUTO-SAVE com debounce 600ms ───
  // Quando vendedora digita o 11º dígito, salva sozinho (sem precisar clicar Salvar)
  useEffect(() => {
    const cpfLimpo = cpfInput.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) return;
    if (cpfLimpo === lastSavedCpf) return;
    const t = setTimeout(() => {
      salvarCpfDireto(cpfLimpo, { silent: false });
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpfInput, lastSavedCpf]);

  // ─── Expõe API pro parent forçar flush antes de emitir NFC-e ───
  React.useImperativeHandle(ref, () => ({
    hasUnsavedCpf: () => {
      const cpfLimpo = cpfInput.replace(/\D/g, '');
      return editing && cpfLimpo.length === 11 && cpfLimpo !== lastSavedCpf;
    },
    flushPendingSave: async () => {
      const cpfLimpo = cpfInput.replace(/\D/g, '');
      if (cpfLimpo.length !== 11 || cpfLimpo === lastSavedCpf) return false;
      return await salvarCpfDireto(cpfLimpo, { silent: true });
    },
  }), [cpfInput, editing, lastSavedCpf]);

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
        ✨ Salva sozinho ao digitar os 11 dígitos. CPF vai aparecer na NFC-e.
      </div>
    </div>
  );
});

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
  // Ref pro componente de CPF — permite forçar flush antes de emitir NFC-e
  const cpfInputRef = useRef<CpfNaNotaHandle>(null);

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

      // Carnê de crediário → A4 (HP/Brother). Roteado pelo printer-router:
      // antes do silent print, seta a impressora A4 escolhida em config.
      const electron = (window as any).electronAPI;
      if (electron?.silentPrintUrl) {
        try {
          const { loadPrinterConfig } = await import('@/lib/printer-router');
          const cfg = loadPrinterConfig();
          if (cfg.a4) {
            await electron.setConfig({ printer: cfg.a4 });
          }
          await electron.silentPrintUrl(url);
          toast('success', 'Carnê enviado pra impressora A4', 'Confira a bandeja');
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
    // ── Dados da empresa: extraídos do XML AUTORIZADO pela SEFAZ ──────
    // ANTES estava hardcoded com CNPJ da matriz (/0001-39) e razão antiga
    // "EIRELI" (extinto em 2021). Agora puxa do <emit> do XML — que reflete
    // a config REAL de cada loja (cada CNPJ próprio, /0006-43 pra Santos, etc).
    const xmlAutorizado = ((sale as any).nfceXml as string | undefined) || '';
    const emitBlock = xmlAutorizado.match(/<emit>([\s\S]*?)<\/emit>/)?.[1] || '';
    const xmlCnpjRaw = (emitBlock.match(/<CNPJ>([^<]+)<\/CNPJ>/)?.[1] || '').trim();
    const xmlRazao = (emitBlock.match(/<xNome>([^<]+)<\/xNome>/)?.[1] || '').trim();
    const xmlFant = (emitBlock.match(/<xFant>([^<]+)<\/xFant>/)?.[1] || '').trim();

    // Formata CNPJ "20104813000643" → "20.104.813/0006-43"
    const formatCnpj = (c: string) => {
      const d = c.replace(/\D/g, '').padStart(14, '0').slice(0, 14);
      return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
    };

    // Fallbacks só usados se o XML não estiver disponível (preview antes
    // da autorização SEFAZ, por ex). Atualizados pra razão correta atual.
    const RAZAO_SOCIAL = xmlRazao || 'T.O. RISSUTTO LTDA';
    const NOME_FANTASIA = xmlFant || "LURD'S PLUS SIZE";
    const CNPJ = xmlCnpjRaw ? formatCnpj(xmlCnpjRaw) : '—';

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
    // Formato OFICIAL SEFAZ-SP: https://www.nfce.fazenda.sp.gov.br/qrcode?p=CHAVE|VERSAO|AMBIENTE|IDCSC|HASH
    //
    // BUG HISTORICO RESOLVIDO: Antes gerava URL invalida no frontend com
    // ?chNFe=CHAVE&nVersao=100&tpAmb=1 — esse formato nao eh QR Code NFC-e,
    // eh URL de consulta antiga que SEFAZ rejeita ao escanear ("Formato
    // de QR-Code nao suportado"). O backend ja salvou o QR Code correto
    // em sale.nfceQrUrl com o hash CSC valido. So precisa usar.
    //
    // Tenta extrair do XML autorizado tambem (fonte de verdade), com
    // fallback pra nfceQrUrl direto. Ultimo recurso: URL antiga so pra
    // nao quebrar cupom em casos onde o XML/qrUrl nao existem ainda.
    const xmlForQr = ((sale as any).nfceXml as string | undefined) || '';
    const qrFromXml = (xmlForQr.match(/<qrCode>\s*<!\[CDATA\[([^\]]+)\]\]>\s*<\/qrCode>/)?.[1] || '').trim();
    const qrUrl = qrFromXml
      || (sale as any).nfceQrUrl
      || (sale.nfceChave ? `https://www.nfce.fazenda.sp.gov.br/qrcode?chNFe=${sale.nfceChave}&nVersao=100&tpAmb=1` : '');
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

    // NFC-e SEMPRE vai direto pra impressora fiscal térmica 80mm configurada.
    // Sem preview, sem popup — fluxo silencioso pra não atrapalhar venda.
    try {
      const { loadPrinterConfig, isElectron } = await import('@/lib/printer-router');
      const electron = (window as any).electronAPI;
      if (isElectron() && electron?.silentPrintHTML) {
        const cfg = loadPrinterConfig();
        if (cfg.termica) {
          await electron.setConfig({ printer: cfg.termica });
        }
        await electron.silentPrintHTML(html);
        return;
      }
      // Fora do Electron (Chrome puro) — sem app desktop não tem como imprimir
      // silencioso. Mostra erro claro com link pra config.
      toast(
        'warning',
        'App desktop necessário',
        'Pra imprimir NFC-e direto na térmica, abra pelo app desktop (LURDS ORDER ONE). No Chrome puro não dá pra mandar pra impressora sem preview.',
      );
    } catch (e: any) {
      console.warn('[nfce] silentPrintHTML falhou:', e);
      toast(
        'error',
        'Impressão NFC-e falhou',
        e?.message || 'Verifique se a impressora térmica 80mm está configurada em /pdv/config-impressora.',
      );
    }
  }

  // Auto-print NFC-e: assim que SEFAZ autoriza, o cupom fiscal sai sozinho
  // na térmica configurada em /pdv/config-impressora. Vendedora não precisa
  // clicar "Imprimir DANFE" — sai junto com o cupom não-fiscal de venda.
  const lastPrintedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isAuthorized) return;
    if (!sale.nfceChave) return;
    if (lastPrintedRef.current === sale.nfceChave) return;
    lastPrintedRef.current = sale.nfceChave;
    setTimeout(() => imprimirDanfeNfce(), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized, sale.nfceChave]);

  async function emitirNfce() {
    setEmitting(true);
    setEmitError(null);
    try {
      // ─── FLUSH do CPF antes de emitir ───
      // Se vendedora digitou CPF mas não clicou Salvar, salva agora.
      // Resolve bug onde a NFC-e saía sem CPF mesmo o input tendo valor.
      if (cpfInputRef.current?.hasUnsavedCpf()) {
        const ok = await cpfInputRef.current.flushPendingSave();
        if (!ok) {
          setEmitError('Falhou ao salvar CPF antes de emitir. Confira e tente de novo.');
          setEmitting(false);
          return;
        }
        // Aguarda um tick pro state propagar antes de chamar a NFCe
        await new Promise((r) => setTimeout(r, 100));
      }
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
            <CpfNaNotaInput ref={cpfInputRef} sale={sale} onUpdated={(s) => setSale(s)} />
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
      // Filtra: nao mostra a venda atual nem fantasmas vazias
      // (vendedora abriu PDV mas nao bipou nada — acumula sem necessidade).
      // BUG FIX: o endpoint nao retorna `items[]` — usa _count.items pra contagem real.
      setList(arr.filter((s) => {
        if (s.id === currentSaleId) return false;
        const qtdItems = s?._count?.items ?? s.items?.length ?? 0;
        return qtdItems > 0;
      }));
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

  const backdropClose = useSmartBackdropClose(onClose);
  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto"
      onMouseDown={backdropClose.onMouseDown}
      onClick={backdropClose.onClick}
    >
      <div
        className="bg-white rounded-lg w-full max-w-md my-8 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
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
        <img src={src} alt="Visa Electron" className="h-4 object-contain" />
        <span className="text-[7px] font-bold tracking-wider text-[#1A1F71]">
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
      className="h-5 max-h-5 object-contain"
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

  const backdropClose = useSmartBackdropClose(onClose);
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4" onMouseDown={backdropClose.onMouseDown} onClick={backdropClose.onClick}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
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
    return <Link href={href} onClick={onClick} className={cls} style={style}>{inner}</Link>;
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
      setError('Descreva o item (ex: "Brinco prata", "Troca defeito")');
      return;
    }
    const v = parseNum(valor);
    // Aceita NEGATIVO (ex: TROCA DEFEITO -39,90). Bloqueia só zero.
    if (v == null || v === 0) {
      setError('Valor inválido — use números (ex: 49,90 ou -39,90 pra abater)');
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
          <br />
          💡 Valor pode ser <b>negativo</b> pra abater (ex: <b>TROCA DEFEITO -39,90</b>).
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
              Valor unitário (pode ser negativo)
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
                placeholder="0,00 ou -39,90"
                className={`w-full px-3 py-3 pl-10 text-xl font-bold tabular-nums border-2 rounded-xl focus:outline-none focus:ring-2 ${
                  (parseNum(valor) ?? 0) < 0
                    ? 'text-rose-700 border-rose-200 focus:ring-rose-300 focus:border-rose-400'
                    : 'text-emerald-700 border-emerald-200 focus:ring-emerald-300 focus:border-emerald-400'
                }`}
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


/* ─── PDV2: Overlay de ajuda — lista de atalhos do teclado (F12 / ?) ─── */
function ShortcutsHelpModal({ onClose }: { onClose: () => void }) {
  const close = useSmartBackdropClose(onClose);
  const atalhos: Array<[string, string]> = [
    ['F1', 'Focar campo de bipagem'],
    ['F2', 'Desconto na venda inteira'],
    ['F3', 'Caixa (sangria / suprimento)'],
    ['F4', 'Troca / Devolução'],
    ['F6', 'Identificar cliente (CPF)'],
    ['F8', 'Abrir tela de pagamento'],
    ['F9', 'Escolher vendedora'],
    ['F10', 'Consultar produto (estoque / preço)'],
    ['Del', 'Remover último item do carrinho'],
    ['Esc', 'Fechar modal aberto'],
    ['F12 ou ?', 'Abrir / fechar esta ajuda'],
    ['0 + Enter', 'Lançar item manual (produto livre)'],
  ];
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onMouseDown={close.onMouseDown}
      onClick={close.onClick}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 bg-slate-900 text-white">
          <div className="font-black text-sm tracking-wide">⌨ Atalhos do PDV (V2)</div>
          <button onClick={onClose} className="text-white/70 hover:text-white transition" aria-label="Fechar">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 grid grid-cols-1 gap-1.5 max-h-[70vh] overflow-y-auto">
          {atalhos.map(([k, desc]) => (
            <div key={k} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-slate-50">
              <kbd className="min-w-[72px] text-center text-[11px] font-mono font-bold bg-slate-100 text-slate-800 border border-slate-300 rounded px-1.5 py-1 shrink-0">
                {k}
              </kbd>
              <span className="text-sm text-slate-700">{desc}</span>
            </div>
          ))}
        </div>
        <div className="px-5 py-2.5 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-400 text-center">
          Pressione Esc ou F12 pra fechar
        </div>
      </div>
    </div>
  );
}
