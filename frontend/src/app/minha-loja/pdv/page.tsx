'use client';
import { overlayClose } from '@/lib/overlayClose';

/**
 * /minha-loja/pdv — Frente de caixa.
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
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowLeft, Loader2, X, Barcode, Trash2, Plus, Minus,
  ShoppingCart, User, CreditCard, Banknote, QrCode, Check, AlertCircle,
  AlertTriangle,
  FileText, RotateCcw, History, Percent,
  Clock, ChevronRight, Pause, DollarSign, ArrowRightLeft, Search, Sparkles,
  Receipt, Globe, Shuffle, Tag, Wallet, ArrowUpRight, Printer,
  RefreshCw, Handshake, Moon, Sun, Package,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  type DadosClienteOnline,
  checarDadosClienteOnline,
  dadosClienteDaVenda,
  faltandoDadosBasicosClienteOnline,
  faltandoDadosClienteOnline,
  pecaViaja,
} from '@/lib/dados-cliente-online';
import { loadPrinterConfig } from '@/lib/printer-router';
// Import ESTÁTICO (igual à página DANFE de reimpressão, que sempre imprimiu
// QR) — o import dinâmico devolvia o módulo sem .default em alguns bundles
// e o QR morria num catch silencioso (caso Moema 21/07, round 2).
import QRCode from 'qrcode';
import { PdvToastProvider, usePdvToast, humanizeError } from '@/components/PdvToast';
import ValeTrocaModal from './ValeTrocaModal';
import { appPrompt } from '@/lib/app-prompt';
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
    // Item BÁSICO que a operadora forçou pra dentro da promoção (botão azul).
    forcarPromo?: boolean;
    total: number;
  }>;
};

type Store = { id: string; code: string; name: string; active: boolean };

type StoreSummary = {
  storeCode: string;
  soldTodayQty: number;
  returnedTodayQty: number;
  netSoldTodayQty: number;
  stockQty: number;
  sellerRanking: Array<{
    sellerName: string;
    grossSalesValue: number;
    returnsAppliedValue: number;
    netSalesValue: number;
  }>;
  updatedAt: string;
};

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

/**
 * A venda fresca SEM uma segunda viagem ao servidor.
 *
 * As mutações do PDV (bipar, +/−, remover, desconto, campanha, remover
 * pagamento) já devolvem a venda completa — igual o bipe faz desde a
 * otimização anterior. Antes CADA clique custava POST/PATCH + GET inteiro:
 * em loja com internet ruim isso dobrava o tempo do "+" na quantidade.
 *
 * O GET continua aqui como rede de segurança pro backend ANTIGO (janela de
 * deploy, quando o Railway ainda não subiu a versão nova).
 */
async function saleFromResponse(r: any, saleId: string): Promise<Sale> {
  if (r?.sale?.id && Array.isArray(r.sale.items)) return r.sale as Sale;
  if (r?.id === saleId && Array.isArray(r.items)) return r as Sale;
  return api<Sale>(`/pdv/sales/${saleId}`);
}

// ── Densidade da tela ──────────────────────────────────────────────────
// Três tamanhos fixos no lugar do zoom proporcional livre. O piso subiu de
// 0.70 pra 0.86: num monitor de 1366px o texto para de encolher pra ~10px.
// 'auto' escolhe pelo monitor; a loja pode fixar no rodapé do PDV.
type PdvDensityFixa = 'compacto' | 'normal' | 'grande';
type PdvDensity = PdvDensityFixa | 'auto';
/**
 * Loja-canal SITE — a única com "Carrinhos" no menu do PDV (dono, 17/08).
 *
 * É o time que trabalha carrinho abandonado. Loja física não vê carrinho de
 * cliente que não é dela, e a lista lá só geraria confusão.
 */
const CARRINHOS_STORE_CODE = '13';

const PDV_DENSITY_KEY = 'lurds_pdv_densidade';
const DENSITY_ZOOM: Record<PdvDensityFixa, number> = {
  compacto: 0.86,
  normal: 0.95,
  grande: 1.05,
};
const densidadeAuto = (w: number): PdvDensityFixa =>
  w < 1400 ? 'compacto' : w < 1650 ? 'normal' : 'grande';

// Cores do split de pagamento (barra de progresso + bolinhas das formas).
// Antes: ciano/violeta/azul/rosa/teal — paleta de outro sistema, que ainda
// brigava com o verde do total. Agora segue a identidade do PDV: dourado
// pros meios eletrônicos, verde SÓ pro dinheiro, neutros pro resto.
const PAYMENT_COLORS: Record<string, string> = {
  dinheiro: 'bg-[#2E7D46]',
  pix: 'bg-[#D4AF37]',
  credito: 'bg-[#8C7325]',
  debito: 'bg-[#5B7C99]',
  crediario: 'bg-[#64748B]',
  vale_troca: 'bg-[#2F7A72]',
};
const paymentColor = (m?: string | null) => PAYMENT_COLORS[String(m || '').toLowerCase()] || 'bg-[#94A3B8]';

const BANDEIRAS_DEBITO = ['REDESHOP', 'VISA ELECTRON', 'ELO'] as const;
const BANDEIRAS_CREDITO = ['MASTERCARD', 'VISANET', 'CIELO', 'HIPERCARD', 'AMEX'] as const;

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Quanto ainda FALTA pagar da venda: total menos vale-troca e pagamentos
// parciais já lançados. É esse valor que o simulador de parcelamento usa —
// numa troca, a cliente parcela só a diferença, não o carrinho inteiro.
const restanteVenda = (sale: Sale | null): number => {
  if (!sale) return 0;
  const pago = (sale.payments || []).reduce((s: number, p: any) => s + (Number(p.valor) || 0), 0);
  return Math.round(((sale.total || 0) - pago) * 100) / 100;
};

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

// Cria as parcelas de crediário no Giga. Se o backend bloquear por LIMITE DE
// CRÉDITO (403 com "limite"), pede a senha de SUPERVISOR e tenta de novo com
// overridePassword. Cancelar o prompt propaga o erro original (venda não passa).
async function postCrediarioComOverride(saleId: string, payload: any): Promise<any> {
  try {
    return await api<any>(`/pdv/sales/${saleId}/crediario`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (e: any) {
    const msg = String(e?.message || '');
    const ehLimite = /^403/.test(msg) && /limite de cr[eé]dito/i.test(msg);
    if (!ehLimite || typeof window === 'undefined') throw e;
    const senha = await appPrompt(
      'Cliente acima do LIMITE DE CRÉDITO.\n\n' +
        'Digite a senha de SUPERVISOR para liberar o crediário (ou cancele para abortar):',
      { password: true },
    );
    if (!senha) throw e;
    return await api<any>(`/pdv/sales/${saleId}/crediario`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, overridePassword: senha }),
    });
  }
}

// ===========================================================================
// ScanBar — barra de bipagem ISOLADA (estado local).
//
// Antes, o `scanInput` morava no PdvPageInner (componente de ~2.800 linhas).
// Cada tecla digitada re-renderizava a árvore inteira E re-registrava o
// listener global de teclado (scanInput estava nas deps dele). Em máquina
// fraca de loja isso engasgava a bipagem.
//
// Aqui o valor digitado fica DENTRO da ScanBar: digitar re-renderiza só esta
// barra. As 3 funções do campo são preservadas 1:1:
//   1. Leitor de código de barras (digita rápido + Enter)
//   2. Digitação manual do código (Enter)
//   3. Busca por REF: REF+ESPAÇO ou Shift+Enter (grade), 3-6 díg+Enter (REF
//      curta), texto com letra (busca por descrição, debounce), e fallback
//      automático de código 7+ díg não encontrado → tenta como REF.
//
// O pai interage só via ref imperativo (focus/focusSelect/clear/isActiveEmpty)
// e callbacks (onScanResult/onError/onRequestManualItem).
// ===========================================================================
type ScanBarHandle = {
  focus: () => void;
  focusSelect: () => void;
  clear: () => void;
  isActiveEmpty: () => boolean;
};

type ScanBarProps = {
  /** null enquanto a venda ainda não nasceu — ela só nasce ao bipar a 1ª peça. */
  saleId: string | null;
  /** Devolve o id da venda CRIANDO na hora se ainda não existir. */
  ensureSaleId: () => Promise<string | null>;
  onScanResult: (fresh: Sale) => void;     // pai faz flashAddedItem + setSale
  onError: (msg: string | null) => void;   // pai faz setError
  onRequestManualItem: () => void;         // pai abre o modal de item manual
  onAbrirPromoCheck: () => void;           // pai abre "essa peça entra na promo?"
};

const ScanBar = forwardRef<ScanBarHandle, ScanBarProps>(function ScanBar(
  { saleId, ensureSaleId, onScanResult, onError, onRequestManualItem, onAbrirPromoCheck },
  ref,
) {
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

  const [scanInput, setScanInput] = useState('');
  const [searchResults, setSearchResults] = useState<ErpSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── FILA DE BIPAGEM ────────────────────────────────────────────────────
  // ANTES: o campo ficava `disabled` enquanto o POST não voltava. O leitor de
  // código de barras é MUITO mais rápido que a rede — bipar duas peças em
  // sequência perdia a segunda (o campo estava desabilitado e as teclas caíam
  // no vazio, sem erro nenhum na tela).
  //
  // AGORA: o campo NUNCA trava. Cada leitura entra numa fila serial
  // (chainRef) — os POSTs continuam um de cada vez, na ordem, pra não haver
  // corrida de duas respostas escrevendo a venda ao mesmo tempo. O contador
  // `pending` só alimenta o spinner.
  const [pending, setPending] = useState(0);
  const scanLoading = pending > 0;
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  // Callbacks sempre na versão mais recente: uma leitura enfileirada não pode
  // devolver o resultado pro `sale` de dois bipes atrás.
  const onScanResultRef = useRef(onScanResult);
  const onErrorRef = useRef(onError);
  const ensureSaleIdRef = useRef(ensureSaleId);
  useEffect(() => {
    onScanResultRef.current = onScanResult;
    onErrorRef.current = onError;
    ensureSaleIdRef.current = ensureSaleId;
  });
  // Venda que a fila está usando. A prop manda enquanto existe venda; quando
  // ela volta a null (venda finalizada), só limpamos com a fila VAZIA — senão
  // apagaríamos a venda recém-criada pelo bipe que ainda está gravando.
  const saleIdRef = useRef<string | null>(saleId);
  useEffect(() => {
    if (saleId || pending === 0) saleIdRef.current = saleId;
  }, [saleId, pending]);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    focusSelect: () => { inputRef.current?.focus(); inputRef.current?.select(); },
    clear: () => setScanInput(''),
    isActiveEmpty: () => document.activeElement === inputRef.current && !scanInput.trim(),
  }), [scanInput]);

  // ── Bipagem ──
  // forceRef: Shift+Enter / REF+ESPAÇO → busca a REF/grade direto, sem tentar bipar.
  const handleScan = async (e?: React.FormEvent, opts?: { forceRef?: boolean }) => {
    e?.preventDefault();
    const sku = scanInput.trim();
    if (!sku) return;
    // Atalho item manual: vendedora digita "0" → abre modal pra lançar
    // produto livre (descrição + valor) sem precisar achar no Giga.
    if (sku === '0') {
      setScanInput('');
      onRequestManualItem();
      return;
    }
    // BUSCA DE REF/GRADE — gatilhos:
    //   1. forceRef (Shift+Enter / REF+ESPAÇO): explícito, REF de QUALQUER tamanho.
    //   2. Fallback no catch abaixo: bipou código + ENTER e não achou → tenta REF.
    // (NÃO usar mais "3-6 dígitos = REF": existem CÓDIGOS de 3-6 dígitos, ex. 10115.)
    const buscarRef = async () => {
      setSearchLoading(true);
      onError(null);
      try {
        const res = await api<ErpSearchHit[]>(`/products/erp-search?q=${encodeURIComponent(sku)}`);
        const arr = Array.isArray(res) ? res : [];
        setSearchResults(arr);
        setShowResults(arr.length > 0);
        setHighlightedIdx(arr.length > 0 ? 0 : -1);
        if (!arr.length) onError(`REF ${sku} não encontrada no Giga`);
      } catch (e2: any) {
        onError(e2?.message || 'Erro ao buscar REF');
      } finally {
        setSearchLoading(false);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    };
    // REF/GRADE só por gatilho EXPLÍCITO (REF + ESPAÇO ou Shift+Enter).
    // ANTES: "3-6 dígitos + Enter" caía aqui automático — mas isso QUEBRAVA
    // produtos cujo CODIGO tem 3-6 dígitos (ex.: 10115 = Calça). O leitor manda
    // BIP+ENTER; como 10115 também é REF das Meias, o ENTER "puxava a REF" e
    // trazia o produto errado. Agora o ENTER SEMPRE bipa por código; se o
    // código não existir, o catch abaixo tenta como REF (REF digitada à mão).
    if (opts?.forceRef) {
      await buscarRef();
      return;
    }
    // O campo é limpo AGORA, não quando a resposta chegar: a próxima peça já
    // pode ser bipada em cima. A gravação segue na fila, em segundo plano.
    setScanInput('');
    enfileirarBipe(sku, buscarRef);
  };

  /**
   * Enfileira uma leitura. As gravações acontecem UMA DE CADA VEZ (na ordem
   * em que a vendedora bipou), mas o campo continua livre o tempo todo.
   *
   * A venda NASCE AQUI quando ainda não existe (11/08): antes ela era criada
   * só de abrir a tela e viravam 42 registros vazios por dia. Como a fila é
   * serial, o 1º bipe cria e os seguintes já pegam o id resolvido — dois
   * bipes rápidos nunca abrem duas vendas.
   */
  const enfileirarBipe = useCallback((sku: string, aoNaoAchar?: () => Promise<void>) => {
    setPending((n) => n + 1);
    onErrorRef.current(null);
    chainRef.current = chainRef.current.then(async () => {
      try {
        const sid = saleIdRef.current || (await ensureSaleIdRef.current());
        if (!sid) {
          onErrorRef.current('Não consegui abrir a venda. Tenta bipar de novo.');
          return;
        }
        // Guarda o id da venda recém-criada: o próximo item da fila roda antes
        // do estado do pai voltar como prop.
        saleIdRef.current = sid;
        const r = await api<any>(`/pdv/sales/${sid}/items`, {
          method: 'POST',
          body: JSON.stringify({ skuOrEan: sku }),
        });
        // PERF: backend novo devolve a venda completa no POST — elimina o
        // segundo GET. Fallback pro GET enquanto backend antigo estiver no ar.
        const fresh: Sale = r?.sale || (await api<Sale>(`/pdv/sales/${sid}`));
        onScanResultRef.current(fresh);
      } catch (e: any) {
        const msg = String(e?.message || '');
        // FALLBACK REF: código numérico não existe no Giga? Pode ser uma REF
        // (digitada à mão) — busca a grade automaticamente antes de dar erro.
        // Cobre qualquer numérico 3+ (não só 7+), já que agora o ENTER bipa
        // código primeiro pra QUALQUER tamanho de número.
        if (aoNaoAchar && /^\d{3,}$/.test(sku) && /n[aã]o encontrado/i.test(msg)) {
          await aoNaoAchar();
          return;
        }
        onErrorRef.current(msg || 'Erro ao bipar');
      } finally {
        setPending((n) => Math.max(0, n - 1));
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
          }
        }, 50);
      }
    });
  }, []);

  // ── Adiciona peca direto por SKU (usado pelo dropdown de busca) ──
  const addBySku = useCallback((sku: string) => {
    setShowResults(false);
    setSearchResults([]);
    setScanInput('');
    enfileirarBipe(sku);
  }, [enfileirarBipe]);

  // ── Effect: busca inline com debounce ──
  // Se digitar texto (com letra), busca por descricao no Giga.
  // Numeros (REF/codigo) NAO acionam dropdown automatico — sao explicitos
  // (Enter pra bipe/REF curta, ESPAÇO pra grade). Determinístico, independe
  // da velocidade de digitação.
  useEffect(() => {
    const term = scanInput.trim();
    const hasLetter = /[a-zA-ZÀ-ÿ]/.test(term);
    if (term.length < 3 || !hasLetter) {
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

  return (
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
        className="bg-white rounded-xl border border-[#E5E2D9] pl-4 pr-2 py-2 shadow-sm flex items-center gap-3 w-full"
      >
        <Barcode className="w-5 h-5 text-slate-400 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={scanInput}
          onChange={(e) => setScanInput(e.target.value)}
          onKeyDown={(e) => {
            // REF + ESPAÇO → abre a grade do modelo (tamanhos/cores).
            // Só quando o campo tem APENAS números (3+ dígitos) — digitando
            // texto (nome da peça), o espaço funciona normal.
            if (e.key === ' ' && /^\d{3,}$/.test(scanInput.trim())) {
              e.preventDefault();
              handleScan(undefined, { forceRef: true });
              return;
            }
            // Shift+Enter → mesma busca (atalho alternativo)
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              handleScan(undefined, { forceRef: true });
              return;
            }
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
          placeholder="Bipe o código, a REF ou o nome da peça"
          /* Sem `disabled` de propósito: o leitor é mais rápido que a rede e a
             peça bipada durante a gravação da anterior não pode se perder. */
          className="flex-1 min-w-0 px-1 py-2 text-base font-semibold border-0 focus:outline-none placeholder:text-slate-400 placeholder:font-normal text-slate-900"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {searchLoading && (
          <Loader2 className="w-4 h-4 text-slate-400 animate-spin shrink-0" />
        )}
        {/* Consulta de promoção: bipa e responde "entra nos 50%?" sem lançar
            nada na venda. A regra tem 3 partes (ano, coleção -INV/-VER e
            básico) e ninguém decora as três com a cliente na frente. */}
        <button
          type="button"
          onClick={onAbrirPromoCheck}
          className="w-11 h-11 rounded-lg flex items-center justify-center shrink-0 border-2 border-[#E5E2D9] text-[#8C7325] hover:bg-[#FBF6E6] transition"
          title="Essa peça entra na promoção?"
        >
          <Tag className="w-5 h-5" />
        </button>
        {/* Quantas leituras ainda estão sendo gravadas. Só aparece quando
            passa de uma — é o sinal de que a fila está trabalhando e nenhuma
            peça se perdeu, mesmo com a internet lenta. */}
        {pending > 1 && (
          <span
            className="shrink-0 text-[11px] font-black text-[#8C7325] bg-[#FBF6E6] border border-[#E4C968] rounded-full px-2 py-0.5 tabular-nums"
            title={`${pending} leituras na fila de gravação`}
          >
            {pending} na fila
          </span>
        )}
        <button
          type="submit"
          disabled={!scanInput}
          className="w-11 h-11 text-white font-bold rounded-lg flex items-center justify-center disabled:opacity-40 transition shrink-0 hover:brightness-95"
          style={{ background: '#B8912B' }}
          title="Buscar / adicionar (Enter)"
        >
          {scanLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
        </button>
      </form>

      {/* DROPDOWN DE BUSCA — aparece abaixo do input quando ha resultados */}
      {showResults && searchResults.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white rounded-2xl border border-slate-200 shadow-xl max-h-[420px] overflow-y-auto">
          <div className="px-3 py-2 border-b border-slate-100 bg-slate-50 text-[11px] font-semibold text-slate-500 flex items-center justify-between">
            <span>{searchResults.length} resultado(s) — clique pra adicionar</span>
            <span className="text-[10px] font-normal text-slate-400">↑↓ navegar · Enter escolher · Esc fechar</span>
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
  );
});

/**
 * Relógio do header — "Caixa aberto · 14:32". Puramente visual, atualiza a
 * cada 30s. Nenhuma dependência de estado da venda.
 */
function HeaderClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const hhmm = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 whitespace-nowrap">
      <Clock className="w-3.5 h-3.5 text-slate-400" />
      Caixa aberto · {hhmm}
    </span>
  );
}

/**
 * Status de conexão com o servidor — escuta o evento global
 * 'flowops:connection' que o wrapper api() já dispara em toda chamada
 * (online em sucesso, offline em falha de rede/5xx). Só representação visual.
 */
function useConnStatus() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const handler = (e: Event) => {
      const det = (e as CustomEvent<{ status: 'online' | 'offline' }>).detail;
      if (det?.status) setOnline(det.status === 'online');
    };
    window.addEventListener('flowops:connection', handler);
    return () => window.removeEventListener('flowops:connection', handler);
  }, []);
  return online;
}

function ConnBadge({ compact }: { compact?: boolean }) {
  const online = useConnStatus();
  return (
    <span className={`flex items-center gap-1.5 text-xs font-bold whitespace-nowrap ${online ? 'text-emerald-700' : 'text-rose-600'}`}>
      <span className={`w-2 h-2 rounded-full ${online ? 'bg-emerald-500' : 'bg-rose-500 animate-pulse'}`} />
      {compact ? (online ? 'Conectado' : 'Sem conexão') : (online ? 'Conectado ao servidor' : 'Sem conexão com o servidor')}
    </span>
  );
}

/**
 * Rodapé fino de status (espec do layout claro): conexão + impressora térmica
 * configurada + ambiente. Fixed no fundo, altura mínima.
 *
 * Também é onde mora o seletor de TAMANHO da tela (densidade) — preferência
 * local deste computador. Ficou aqui, e não no header, porque o header já
 * disputa espaço com 9 chips.
 */
function StatusFooter({
  density,
  onDensity,
}: {
  density: PdvDensity;
  onDensity: (d: PdvDensity) => void;
}) {
  const [printerName, setPrinterName] = useState<string | null>(null);
  useEffect(() => {
    try { setPrinterName(loadPrinterConfig().termica); } catch { setPrinterName(null); }
  }, []);
  const isProd = process.env.NODE_ENV === 'production';
  const opcoes: Array<[PdvDensity, string]> = [
    ['auto', 'Auto'],
    ['compacto', 'Compacto'],
    ['normal', 'Normal'],
    ['grande', 'Grande'],
  ];
  return (
    <footer className="fixed bottom-0 left-0 right-0 z-10 bg-white border-t border-[#EDEAE1]">
      <div className="max-w-[1700px] mx-auto px-5 h-9 flex items-center gap-6 text-[11px] font-semibold text-slate-500">
        <ConnBadge />
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <Printer className="w-3.5 h-3.5 text-slate-400" />
          {printerName || 'Impressora não configurada'}
        </span>
        <span className="hidden lg:flex items-center gap-1.5 whitespace-nowrap">
          <FileText className="w-3.5 h-3.5 text-slate-400" />
          Ambiente: {isProd ? 'Produção' : 'Desenvolvimento'}
        </span>
        <div className="ml-auto hidden lg:flex items-center gap-1">
          <span className="text-slate-400 whitespace-nowrap">Tamanho da tela</span>
          {opcoes.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onDensity(id)}
              aria-pressed={density === id}
              className={`px-2 py-0.5 rounded border transition whitespace-nowrap ${
                density === id
                  ? 'border-[#CDA434] bg-[#FBF6E6] text-[#8C7325]'
                  : 'border-transparent hover:border-slate-200 hover:text-slate-700'
              }`}
              title={
                id === 'auto'
                  ? 'Ajusta sozinho pelo tamanho do monitor'
                  : `Fixa o tamanho em ${label.toLowerCase()} neste computador`
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </footer>
  );
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

  // Faixas de desconto (config /retaguarda/descontos-senhas). Default = regra
  // antiga 7/10 caso a leitura falhe. Só decide QUAL prompt de senha mostrar —
  // a validação real é no backend (requireDiscountAuth).
  const [discountBands, setDiscountBands] = useState({ freeUpToPct: 7, caixaUpToPct: 10 });
  useEffect(() => {
    api<{ freeUpToPct: number; caixaUpToPct: number }>('/pdv/discount-policy')
      .then((r) => {
        if (r && typeof r.freeUpToPct === 'number' && typeof r.caixaUpToPct === 'number') {
          setDiscountBands({ freeUpToPct: r.freeUpToPct, caixaUpToPct: r.caixaUpToPct });
        }
      })
      .catch(() => {});
  }, []);

  // Menu lateral recolhível (só visual). Persiste a preferência por PC.
  const [menuCollapsed, setMenuCollapsed] = useState(false);
  useEffect(() => {
    try { setMenuCollapsed(localStorage.getItem('lurds_pdv_menu_collapsed') === '1'); } catch {}
  }, []);
  const toggleMenu = () => {
    setMenuCollapsed((v) => {
      try { localStorage.setItem('lurds_pdv_menu_collapsed', v ? '0' : '1'); } catch {}
      return !v;
    });
  };

  // Piloto visual do checkout. O layout anterior continua vivo no mesmo
  // componente e pode ser restaurado em um clique, sem tocar na venda aberta.
  const [checkoutLayout, setCheckoutLayout] = useState<'highlighted' | 'legacy'>('highlighted');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('lurds_pdv_checkout_layout');
      if (saved === 'legacy' || saved === 'highlighted') setCheckoutLayout(saved);
    } catch {}
  }, []);
  const toggleCheckoutLayout = () => {
    setCheckoutLayout((current) => {
      const next = current === 'highlighted' ? 'legacy' : 'highlighted';
      try { localStorage.setItem('lurds_pdv_checkout_layout', next); } catch {}
      return next;
    });
  };

  // Tema visual exclusivo deste computador. Não toca na venda nem sincroniza
  // com a loja: cada caixa escolhe claro/noturno de forma independente.
  const [colorTheme, setColorTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('lurds_pdv_color_theme');
      if (saved === 'light' || saved === 'dark') setColorTheme(saved);
    } catch {}
  }, []);
  const toggleColorTheme = () => {
    setColorTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('lurds_pdv_color_theme', next); } catch {}
      return next;
    });
  };
  const nightMode = colorTheme === 'dark';

  const [quickConvenioAtivo, setQuickConvenioAtivo] = useState<{ id: string; nome: string } | null>(null);
  useEffect(() => {
    if (!storeCode) {
      setQuickConvenioAtivo(null);
      return;
    }
    let cancelled = false;
    api<{ id?: string; nome?: string }>(`/pdv/convenio/ativo?storeCode=${encodeURIComponent(storeCode)}`)
      .then((result) => {
        if (!cancelled) setQuickConvenioAtivo(result?.id ? { id: result.id, nome: result.nome || 'Convênio' } : null);
      })
      .catch(() => { if (!cancelled) setQuickConvenioAtivo(null); });
    return () => { cancelled = true; };
  }, [storeCode]);

  // Barra de bipagem isolada — o estado digitado vive DENTRO do componente
  // ScanBar (ver definição acima). O pai fala com ela só via ref imperativo.
  const scanBarRef = useRef<ScanBarHandle>(null);
  // O botão "Marcar" do layout novo aciona literalmente o botão legado,
  // preservando todas as validações e o fluxo de override já existentes.
  const markSaleButtonRef = useRef<HTMLButtonElement>(null);
  const [promoCheckOpen, setPromoCheckOpen] = useState(false);
  // SKU pendente quando vendedora ainda nao foi escolhida — bipe fica em
  // espera. Apos saveVendedora, dispara handleScan automatico com esse SKU
  // (vendedora nao precisa voltar e clicar de novo na setinha).
  const pendingScanRef = useRef<string | null>(null);
  // PDV2: finalize pendente quando vendedora ainda nao foi escolhida.
  // A vendedora agora é exigida no ENCERRAMENTO da venda (nao no 1º bip,
  // pra liberar a cliente mais rapido). Apos saveVendedora, o finalize
  // é retomado automaticamente com os mesmos argumentos.
  const pendingFinalizeRef = useRef<{ paymentMethod: string; paymentDetails?: any } | null>(null);

  // ── DENSIDADE DA TELA (era AUTO-FIT contínuo) ──────────────────────────
  // ANTES: zoom proporcional livre (w / 1700, piso 0.7). Num monitor de
  // 1366px isso dava 0.80 e o texto de 13px chegava aos olhos como 10px —
  // e ninguém na loja tinha como corrigir.
  //
  // AGORA: 3 tamanhos fixos (compacto/normal/grande) com piso bem mais alto,
  // escolhidos automaticamente pelo monitor OU fixados pela loja no rodapé.
  // O CSS `.pdv-dense-compacto` (globals.css) ainda levanta os textos
  // menores (9/10/11px) pra que nada fique abaixo do legível.
  const [density, setDensity] = useState<PdvDensity>('auto');
  // Densidade REAL em uso (resolve o 'auto' pelo monitor). Vive em state pra
  // não ler window durante o render — isso quebraria a hidratação do Next.
  const [densityUsada, setDensityUsada] = useState<PdvDensityFixa>('grande');
  const [uiZoom, setUiZoom] = useState(1);
  useEffect(() => {
    try {
      const salvo = localStorage.getItem(PDV_DENSITY_KEY) as PdvDensity | null;
      if (salvo && (salvo === 'auto' || DENSITY_ZOOM[salvo as PdvDensityFixa])) setDensity(salvo);
    } catch { /* preferência local — sem ela segue em auto */ }
  }, []);
  useEffect(() => {
    const calcZoom = () => {
      const w = window.innerWidth;
      const efetiva = density === 'auto' ? densidadeAuto(w) : density;
      setDensityUsada(efetiva);
      // Celular/tablet seguem os breakpoints responsivos do Tailwind.
      setUiZoom(w < 1024 ? 1 : DENSITY_ZOOM[efetiva]);
    };
    calcZoom();
    window.addEventListener('resize', calcZoom);
    return () => window.removeEventListener('resize', calcZoom);
  }, [density]);
  const applyDensity = (d: PdvDensity) => {
    setDensity(d);
    try { localStorage.setItem(PDV_DENSITY_KEY, d); } catch { /* noop */ }
  };

  const [showCustomer, setShowCustomer] = useState(false);
  const [showVendedora, setShowVendedora] = useState(false);
  // Popup central de CONFIRMAÇÃO da venda (resumo + escolha da vendedora) que
  // abre na finalização — substituiu o seletor de vendedora do canto superior.
  const [showConfirmSale, setShowConfirmSale] = useState(false);
  // Seletor de MOTIVO do cancelamento (11/08). Texto livre não ensina nada:
  // em 30 dias, R$ 543 mil saíram como "Cancelado pela vendedora" e ninguém
  // sabe se foi desistência da cliente ou defeito nosso.
  const [showCancelReason, setShowCancelReason] = useState(false);
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
  // Erro FIXO do último finalize (o toast some rápido — sem isto a vendedora
  // não sabia por que a venda "voltava" após escolher a vendedora).
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
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
                else { localStorage.removeItem(`lurds_pdv_sale_${storeCode}`); setSale(null); }
              }).catch(() => { localStorage.removeItem(`lurds_pdv_sale_${storeCode}`); setSale(null); });
            } else {
              setSale(null);
            }
          }
        })
        .catch(() => setSale(null));
      return;
    }

    // PRIORIDADE 2: venda OPEN salva no localStorage
    const lastSaleId = localStorage.getItem(`lurds_pdv_sale_${storeCode}`);
    if (lastSaleId) {
      api<Sale>(`/pdv/sales/${lastSaleId}`)
        .then((s) => {
          // GUARD TREINO: nunca reaproveita venda com estado de treino
          // diferente da sessão atual. Venda real + sessão em treino (ou
          // vice-versa) = abandona e cria nova com a flag certa. Era a
          // brecha que fazia o treino baixar estoque REAL.
          const sessaoTreino = (() => {
            try { return sessionStorage.getItem('flowops_training') === '1'; } catch { return false; }
          })();
          const vendaTreino = !!(s as any).isTraining;
          if (s.status === 'open' && s.storeCode === storeCode && vendaTreino === sessaoTreino) {
            setSale(s);
          } else {
            localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
            setSale(null);
          }
        })
        .catch(() => {
          localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
          setSale(null);
        });
    } else {
      setSale(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeCode]);

  /**
   * VENDA SOB DEMANDA (11/08) — devolve o id da venda aberta, criando na hora
   * se ainda não existe.
   *
   * Antes o PDV criava a venda no banco só de abrir a tela: 42 registros
   * vazios por dia (1.264 em 30 dias), que morriam em cancelamento em massa
   * no fechamento do caixa ("limpeza de pendências"). O efeito colateral era
   * pior que o lixo: as vendas DE VERDADE que ficaram pendentes se perdiam no
   * meio do monte e eram canceladas junto.
   *
   * O ref segura a promessa em voo: dois bipes rápidos (ou bipe + clique no
   * dropdown) compartilham a MESMA criação em vez de abrir duas vendas.
   */
  const ensureSaleIdRef = useRef<Promise<string | null> | null>(null);
  const ensureSaleId = useCallback(async (): Promise<string | null> => {
    if (sale?.id) return sale.id;
    if (ensureSaleIdRef.current) return ensureSaleIdRef.current;
    const p = (async () => {
      try {
        const s = await createNewSale();
        return s?.id ?? null;
      } finally {
        ensureSaleIdRef.current = null;
      }
    })();
    ensureSaleIdRef.current = p;
    return p;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale?.id, storeCode]);

  const createNewSale = async (): Promise<Sale | null> => {
    if (!storeCode) return null;
    setLoadingSale(true);
    setError(null);
    try {
      // ── RECICLAGEM DE ÓRFÃS — DESABILITADA ──
      // ANTES: PDV adotava venda VAZIA já aberta na loja, pra evitar lixo
      // no banco. BUG GRAVE detectado em SOROCABA (jun/26): com 2 PCs na
      // mesma loja, o PC2 adotava a venda RECÉM-CRIADA pelo PC1 (ainda
      // vazia) → ambos os PCs ficavam controlando a MESMA venda → peça
      // bipada num PC aparecia no outro = caos.
      //
      // FIX: SEMPRE criar venda nova. Lixo de vendas vazias é resolvido
      // por job de limpeza no backend (cancel automático de vendas open
      // sem items há mais de N horas), não no fluxo de abertura.

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
      return full;
    } catch (e: any) {
      setError(e?.message || 'Erro ao abrir venda');
      return null;
    } finally {
      setLoadingSale(false);
    }
  };

  // ── Fotos do carrinho: UM pedido em lote, não um por peça ──
  useEffect(() => {
    const skus = (sale?.items || []).map((i) => i.sku).filter(Boolean);
    if (skus.length) void prefetchProductImages(skus);
  }, [sale?.items]);

  // ── Foco automático ──
  useEffect(() => {
    if (!sale || sale.status !== 'open') return;
    if (!showCustomer && !showVendedora && !showConfirmSale && !showPayment && !showFinalized) {
      scanBarRef.current?.focus();
    }
  }, [sale, showCustomer, showVendedora, showConfirmSale, showPayment, showFinalized]);

  // Auto-abrir modal de vendedora REMOVIDO — agora vendedora é escolhida
  // a qualquer momento clicando no botão do header (cascata inline).

  // PDV2: o confirm() de "vendedora não escolhida" ao abrir pagamento foi
  // REMOVIDO — a vendedora agora é exigida no ENCERRAMENTO (gate no
  // finalizeSale), com retomada automática após escolher. Bipagem e
  // pagamento fluem sem interrupção pra liberar a cliente mais rápido.

  // ── Listener global de teclado (atalhos + foco automático) ─────────────
  // ANTES: `sale` estava nas deps, então o listener era REMOVIDO e RECRIADO a
  // cada bipe, a cada +/− de quantidade, a cada desconto. Em PC fraco de loja
  // isso engasgava justamente no momento de maior digitação.
  //
  // AGORA: registra UMA vez e lê o estado atual por ref. O ref é atualizado a
  // cada render (logo abaixo), então o handler nunca vê estado velho.
  const kbdRef = useRef({
    sale, showCustomer, showPayment, showFinalized, showVendedora,
    showConfirmSale, showDiscount, showShortcuts,
  });
  kbdRef.current = {
    sale, showCustomer, showPayment, showFinalized, showVendedora,
    showConfirmSale, showDiscount, showShortcuts,
  };
  // `removeItem` é declarada mais abaixo — guardar por effect (que roda DEPOIS
  // do render) evita o erro de usar a const antes da declaração.
  const removeItemRef = useRef<(itemId: string) => void>(() => {});
  useEffect(() => { removeItemRef.current = removeItem; });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const {
        sale, showCustomer, showPayment, showFinalized, showVendedora,
        showConfirmSale, showDiscount, showShortcuts,
      } = kbdRef.current;
      const removeItem = removeItemRef.current;
      if (!sale || sale.status !== 'open') return;
      const anyModal =
        showCustomer || showPayment || showFinalized || showVendedora || showConfirmSale ||
        !!showDiscount || showShortcuts;
      // ── PDV2: Esc fecha modais — roda ANTES do early-return de modal
      // (no PDV v1 o listener inteiro era desativado com modal aberto) ──
      if (e.key === 'Escape') {
        if (showShortcuts) { e.preventDefault(); setShowShortcuts(false); return; }
        if (showDiscount) { e.preventDefault(); setShowDiscount(null); return; }
        if (showCustomer) { e.preventDefault(); setShowCustomer(false); return; }
        if (showVendedora) { e.preventDefault(); setShowVendedora(false); return; }
        // Esc no popup de confirmação = cancelar (descarta finalize pendente)
        if (showConfirmSale) { e.preventDefault(); pendingFinalizeRef.current = null; setShowConfirmSale(false); return; }
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
        scanBarRef.current?.focusSelect();
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
      // F9 (escolher vendedora) REMOVIDO — a vendedora agora é escolhida no
      // popup central de confirmação que abre na finalização da venda.
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
        // "campo de bipe vazio" agora é consultado na ScanBar (estado local dela).
        const scanVazio = scanBarRef.current?.isActiveEmpty() ?? false;
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
        scanBarRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // Deps VAZIAS de propósito: tudo que o handler precisa vem de kbdRef,
    // que é reatribuído a cada render. Assim o listener é registrado uma
    // única vez na vida da tela.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ── Atualizar qty/desconto do item ──
  const updateItem = async (itemId: string, patch: { qty?: number; desconto?: number; excludePromo?: boolean; forcePromo?: boolean }) => {
    if (!sale) return;
    // MD-1: desconto manual por item em faixas (% sobre o BRUTO do item):
    // 0–7% livre · >7–10% CAIXA · >10% GERENTE + justificativa. Campanha ativa bloqueia.
    let password: string | undefined;
    let motivo: string | undefined;
    if (patch.desconto != null && patch.desconto > 0) {
      if (sale.activePromotion && sale.activePromotion !== 'NONE') {
        toast('error', 'Promoção ativa', 'Desconto avulso por item bloqueado — prevalece a campanha.');
        return;
      }
      const item = sale.items.find((i) => i.id === itemId);
      const qty = patch.qty ?? item?.qty ?? 1;
      const bruto = (item?.precoUnit ?? 0) * qty;
      const pct = bruto > 0 ? (patch.desconto / bruto) * 100 : 0;
      if (pct > discountBands.caixaUpToPct + 1e-9) {
        const pw = await appPrompt(`Desconto de ${pct.toFixed(1)}% no item — exige senha de GERENTE:`, { password: true });
        if (!pw) return;
        password = pw;
        const m = await appPrompt('Justificativa do desconto (obrigatória):');
        if (!m || !m.trim()) return;
        motivo = m.trim();
      } else if (pct > discountBands.freeUpToPct + 1e-9) {
        const pw = await appPrompt(`Desconto de ${pct.toFixed(1)}% no item — exige senha do CAIXA:`, { password: true });
        if (!pw) return;
        password = pw;
      }
    }
    try {
      const r = await api<any>(`/pdv/sales/${sale.id}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, password, motivo }),
      });
      const fresh = await saleFromResponse(r, sale.id);
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
      // Feedback de exclusão/inclusão na promoção
      if (patch.excludePromo != null) {
        const item = fresh.items.find((i) => i.id === itemId);
        if (patch.excludePromo) {
          toast('info', 'Item fora da promoção', `${item?.descricao || item?.ref || item?.sku} — desconto removido`);
        } else {
          toast('success', 'Item de volta na promoção', item?.descricao || item?.ref || item?.sku);
        }
      }
      // Feedback de FORÇAR promo (botão azul): avisa se a data/coleção barrou
      // (item novo forçado não ganha desconto — o filtro de data ainda vale).
      if (patch.forcePromo === true) {
        const item = fresh.items.find((i) => i.id === itemId);
        if (item && item.desconto > 0) {
          toast('success', 'Item colocado na promoção', `${item.descricao || item.ref || item.sku} · ${brl(item.desconto)} off`);
        } else {
          toast('warning', 'Sem desconto pra este item', 'Forçado, mas a data/coleção não se enquadra na campanha.');
        }
      } else if (patch.forcePromo === false) {
        const item = fresh.items.find((i) => i.id === itemId);
        toast('info', 'Item voltou a básico', item?.descricao || item?.ref || item?.sku);
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
      const r = await api<any>(`/pdv/sales/${sale.id}/promotion`, {
        method: 'PATCH',
        body: JSON.stringify({ promotion }),
      });
      const fresh = await saleFromResponse(r, sale.id);
      setSale(fresh);
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
    }
  };

  // ── Aplicar desconto na venda inteira (extra, soma com descontos de item) ──
  const setSaleDiscount = async (desconto: number) => {
    if (!sale) return;
    // MD-1: campanha ativa → prevalece a promoção, desconto avulso bloqueado.
    if (desconto > 0 && sale.activePromotion && sale.activePromotion !== 'NONE') {
      toast('error', 'Promoção ativa', 'Desconto avulso bloqueado — prevalece a campanha.');
      return;
    }
    // MD-1: senha por faixa (% sobre subtotal BRUTO): 0–7% livre · >7–10% CAIXA
    // · >10% GERENTE + justificativa.
    let password: string | undefined;
    let motivo: string | undefined;
    if (desconto > 0) {
      const subtotalBruto = sale.items.reduce((s, i) => s + i.precoUnit * i.qty, 0);
      const pct = subtotalBruto > 0 ? (desconto / subtotalBruto) * 100 : 0;
      if (pct > discountBands.caixaUpToPct + 1e-9) {
        const pw = await appPrompt(`Desconto de ${pct.toFixed(1)}% — exige senha de GERENTE:`, { password: true });
        if (!pw) return;
        password = pw;
        const m = await appPrompt('Justificativa do desconto (obrigatória):');
        if (!m || !m.trim()) return;
        motivo = m.trim();
      } else if (pct > discountBands.freeUpToPct + 1e-9) {
        const pw = await appPrompt(`Desconto de ${pct.toFixed(1)}% — exige senha do CAIXA:`, { password: true });
        if (!pw) return;
        password = pw;
      }
    }
    try {
      const r = await api<any>(`/pdv/sales/${sale.id}/discount`, {
        method: 'PATCH',
        body: JSON.stringify({ desconto, password, motivo }),
      });
      const fresh = await saleFromResponse(r, sale.id);
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

  // ── Recalcular preços (promoção) — reconsulta o preço atual de cada item ──
  // Útil pra itens puxados de MARCADO, que vêm com o preço original congelado.
  const [recalculando, setRecalculando] = useState(false);
  const recalcularPrecos = async () => {
    if (!sale) return;
    setRecalculando(true);
    try {
      const r = await api<{ atualizados: number; sale?: Sale }>(`/pdv/sales/${sale.id}/recalcular-precos`, {
        method: 'POST',
      });
      const fresh = await saleFromResponse(r, sale.id);
      setSale(fresh);
      if (r.atualizados > 0) {
        toast('success', `${r.atualizados} preço(s) atualizado(s)`, `Total: ${brl(fresh.total)}`);
      } else {
        toast('info', 'Nada a recalcular', 'Todos os itens já estão no preço atual.');
      }
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
    } finally {
      setRecalculando(false);
    }
  };

  // ── "Fechar depois" — deixa venda OPEN e abre nova ──
  const fecharDepois = () => {
    if (!sale || !sale.items?.length) return;
    setShowPayment(false);
    // Limpa referência da venda atual e cria nova (a anterior fica OPEN no DB)
    localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
    setSale(null); // a próxima venda nasce no próximo bipe
    // Recarrega contagem de vendas em aberto
    loadOpenCount();
  };

  // ── Vendas em aberto (badge) ──
  const [openCount, setOpenCount] = useState(0);
  const [showOpenList, setShowOpenList] = useState(false);
  const [showStoreSummary, setShowStoreSummary] = useState(false);

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
  // ── Modal Vale Presente (vende um vale; código VP- sai no cupom) ──
  const [showGiftVoucher, setShowGiftVoucher] = useState(false);
  // ── Modal Simulador de Parcelamento Cartão (mostra cliente quanto fica cada parcela) ──
  const [showSimular, setShowSimular] = useState(false);
  // Carrinhos abandonados — só no PDV da loja-canal SITE (ver CARRINHOS_STORE_CODE).
  const [showCarrinhos, setShowCarrinhos] = useState(false);
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
      const r = await api<any>(`/pdv/sales/${sale.id}/items/${itemId}`, { method: 'DELETE' });
      const fresh = await saleFromResponse(r, sale.id);
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
      setShowConfirmSale(false);
      toast('success', 'Vendedora identificada', data.nome);

      // AUTO-BIPE: se tem um SKU pendente (vendedora bipou antes de escolher
      // vendedora), faz o POST direto na API (sem passar pelo handleScan que
      // leria scanInput stale via closure). Vendedora nao precisa voltar pra
      // apertar a setinha — a peça entra direto no carrinho.
      const pending = pendingScanRef.current;
      if (pending) {
        pendingScanRef.current = null;
        scanBarRef.current?.clear();
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
        setTimeout(() => scanBarRef.current?.focus(), 50);
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
      // Sai do modo "venda online exige tudo" — senão a próxima abertura do
      // cadastro (balcão, outra venda) continuaria cobrando cadastro completo.
      setExigirDadosOnline(false);
      toast('success', 'Cliente identificado', data.name || data.cpf);
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
    }
  };

  // ── VISÃO POR PESSOA do cliente identificado ──
  // /pdv/customer-resume agrega TODOS os cadastros da pessoa (lojas + site)
  // pelo CPF: cashback e LTV somados + origem do cadastro. Alimenta o badge
  // no card da venda ("🌐 Cliente do SITE" / "loja tal" + cashback total).
  const [clientePessoa, setClientePessoa] = useState<any>(null);
  useEffect(() => {
    const digits = String(sale?.customerCpf || '').replace(/\D/g, '');
    if (digits.length !== 11) { setClientePessoa(null); return; }
    let cancelled = false;
    api<any>(`/pdv/customer-resume?cpf=${digits}`)
      .then((r) => { if (!cancelled) setClientePessoa(r?.found ? r.customer : null); })
      .catch(() => { if (!cancelled) setClientePessoa(null); });
    return () => { cancelled = true; };
  }, [sale?.customerCpf]);

  // ── Cancelar ──
  /**
   * Cancelar venda — abre o seletor de MOTIVO em vez do confirm() seco.
   *
   * Por que (medição 11/08): 564 vendas COM PEÇA foram canceladas em 30 dias,
   * R$ 543 mil, todas com o mesmo texto "Cancelado pela vendedora". Com isso
   * não dá pra saber se é desistência normal da cliente ou defeito nosso —
   * e sem saber, não dá pra consertar. Carrinho vazio não pergunta nada
   * (não é decisão, é limpeza).
   */
  const cancelSale = async () => {
    if (!sale) return;
    const temItens = (sale.items || []).length > 0;
    if (!temItens) {
      await confirmarCancelamento('Carrinho vazio');
      return;
    }
    setShowCancelReason(true);
  };

  /** Executa o cancelamento com o motivo escolhido. */
  const confirmarCancelamento = async (motivo: string) => {
    if (!sale) return;
    setShowCancelReason(false);
    try {
      await api(`/pdv/sales/${sale.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: `Cancelado pela vendedora — ${motivo}` }),
      });
      localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
      setSale(null); // venda nova só nasce quando bipar a próxima peça
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
    // PDV2: a confirmação da venda (resumo + escolha OBRIGATÓRIA da vendedora)
    // acontece num popup central no ENCERRAMENTO. Salva o finalize pendente,
    // abre o popup e retoma automaticamente após confirmar (skipSellerGate
    // evita reabrir o popup na retomada). Sempre abre — é a etapa final do fluxo.
    if (!opts?.skipSellerGate) {
      pendingFinalizeRef.current = { paymentMethod, paymentDetails };
      setShowConfirmSale(true);
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
      let totalAtual = Number(sale.total || 0);
      if (payments.length === 0) {
        try {
          const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
          payments = fresh.payments || [];
          totalAtual = Number(fresh.total ?? totalAtual);
          if (payments.length > 0) {
            setSale(fresh);
          }
        } catch { /* segue com state local */ }
      }
      // TROCA PAR com total ZERO: não há o que pagar — finaliza sem payment
      // (o backend aceita; sem essa exceção a vendedora ficava em loop:
      // finalizar → vendedora → "sem forma de pagamento" → volta pra tela).
      if (payments.length === 0 && Math.abs(totalAtual) >= 0.01) {
        toast('warning', 'Sem forma de pagamento', 'Escolha PIX, cartao, dinheiro, crediario ou vale-troca antes de finalizar.');
        setShowPayment(true);
        finalizingRef.current = false; // libera pra proximo finalize
        return;
      }
    }
    setFinalizeError(null);
    setFinalizing(true);
    try {
      const body: any = {};
      if (paymentMethod) {
        body.paymentMethod = paymentMethod;
        body.paymentDetails = paymentDetails;
      }
      const finResp = await api<any>(
        `/pdv/sales/${sale.id}/finalize`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      /**
       * PEDIDO ONLINE (14/08): venda 100% Venda Online virou um pedido no
       * trilho do site. Três desfechos, e a vendedora PRECISA saber qual foi —
       * caso Suzano/ON-000004 (15/08): ela fechou a venda, mandou a peça de
       * motoboy e não tinha ideia de que um pedido havia nascido pra outra loja
       * separar. O toast agora diz explicitamente se sobrou tarefa pra alguém.
       */
      if (finResp?.onlineOrder) {
        const oo = finResp.onlineOrder;
        if (oo.fechadoNaLoja) {
          // MOTOBOY daqui: sai da mão da loja, sem etiqueta/rastreio pra emitir.
          toast(
            'success',
            `Pedido ${oo.wcOrderNumber} — FECHADO AQUI`,
            `Motoboy desta loja: estoque já baixado e nada pra separar. Você entrega direto pra cliente.`,
          );
        } else if (oo.autoAtendida) {
          // SEDEX/PAC/RETIRADA com estoque: o card é a ferramenta — é nele que
          // ela gera a etiqueta dos Correios ou guarda a peça pro balcão.
          toast(
            'success',
            `${String(oo.storeName || 'Sua loja').toUpperCase()} ATENDE O PEDIDO TODO`,
            `Pedido ${oo.wcOrderNumber} entrou na fila desta loja — abra o card em Minha Loja pra gerar a etiqueta e imprimir a NF.`,
          );
        } else if (oo.lojaEscolhida) {
          // RETIRADA/MOTOBOY em outra loja: o card já nasceu LÁ, com
          // transferências das lojas que têm o que faltar. Nada pra fazer aqui.
          toast(
            'success',
            `Pedido ${oo.wcOrderNumber} — card na ${String(oo.lojaEscolhida.name || oo.lojaEscolhida.code).toUpperCase()}`,
            'A loja escolhida já recebeu a separação. O que ela não tiver chega por transferência antes de entregar. Não mande peça daqui.',
          );
        } else {
          toast(
            'warning',
            `Pedido ${oo.wcOrderNumber} foi pra MATRIZ`,
            'Esta loja não tem todas as peças — OUTRA loja vai separar e enviar. Não mande a peça por conta: confira o pedido antes.',
          );
        }
      }
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      setShowPayment(false);
      localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);

      // TODA venda (inclusive PIX presencial) MOSTRA a tela de finalizada,
      // pra a vendedora poder emitir a NFC-e. Antes o PIX setava autoFlowRef
      // e pulava a tela ("cliente ja foi embora") — isso escondia o botao
      // EMITIR NFC-e. Agora ninguem pula; a vendedora clica "Nova venda".
      // isDirectPix/allPaymentsPix seguem usados na impressao auto do cupom.
      autoFlowRef.current = false;
      const isDirectPix = paymentMethod === 'pix';
      const allPaymentsPix = (fresh?.payments?.length ?? 0) > 0 &&
        (fresh.payments || []).every((p: any) => String(p.method).toLowerCase() === 'pix');
      setShowFinalized(true);

      // ── Impressão automática de cupom: PIX ou DINHEIRO (em 2 vias) ──
      // Cartão/crediário/marcado/vale NÃO imprimem cupom auto.
      // Roteado via printer-router → vai SEMPRE pra impressora térmica
      // configurada em /minha-loja/pdv/config-impressora.
      // (Removida em 23/07 a pedido do dono e RESTAURADA no mesmo dia —
      // as lojas usam o cupom em dinheiro/PIX.)
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

      // (Antes havia auto-abertura da proxima venda em ~1.5s pro PIX. Removido:
      // agora a tela de finalizada sempre aparece e a vendedora clica
      // "Nova venda" — assim consegue emitir a NFC-e antes de seguir.)
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, h.hint);
      // Banner FIXO no card da venda — o toast some rápido e a vendedora
      // ficava sem saber por que a venda "voltou" depois de escolher a
      // vendedora (caso troca 03/07). Limpa no próximo finalize.
      setFinalizeError(h.hint || h.title || e?.message || 'Falha ao finalizar');
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
    setFinalizeError(null);
    setSale(null); // a próxima venda nasce no próximo bipe
  };

  // Handlers compartilhados pelos dois blocos do pagamento rápido. A divisão
  // é somente visual: bandeiras ficam sob o carrinho e demais formas no resumo.
  const venderCredito = (brand?: string) => {
    setPresetMethod('credito');
    setPresetBandeira(brand || null);
    setPaymentFilter('cartao');
    setShowPayment(true);
  };
  const venderDebito = (brand?: string) => {
    setPresetMethod('debito');
    setPresetBandeira(brand || null);
    setPaymentFilter('cartao');
    setShowPayment(true);
  };
  /**
   * VENDA ONLINE — CADASTRO OBRIGATÓRIO DA CLIENTE (dono 18/08).
   *
   * Balcão a cliente leva a sacola na mão; venda online a venda vira pedido
   * no trilho do site. Faltando dado, a falha aparece longe do caixa:
   * etiqueta "Cliente", pedido sem CEP que nem vira Order (fluxo legado, sem
   * card e sem etiqueta) e cliente que ninguém avisa.
   *
   * A régua tem DOIS níveis, e é o `entregaTipo` da venda que escolhe:
   *   - CONTATO (nome, CPF, WhatsApp, e-mail) — sempre, em qualquer modalidade
   *   - ENDEREÇO — só quando a peça VIAJA (SEDEX/PAC/MOTOBOY). RETIRADA EM
   *     LOJA fecha sem CEP: a cliente busca no balcão e não quer passar
   *     endereço só pra sair da tela (dono 18/08).
   *
   * Mesma régua do servidor (`backend/src/common/dados-cliente-online.ts`),
   * que barra ANTES de gerar PIX/link — nunca existe dinheiro na conta com a
   * venda travada por cadastro.
   */
  const clienteOnline = useMemo(() => dadosClienteDaVenda(sale), [sale]);
  /**
   * PORTÃO DE ENTRADA — só o que vale pra QUALQUER modalidade (nome, CPF,
   * WhatsApp, e-mail). O endereço NÃO é cobrado aqui de propósito: a forma de
   * entrega só é escolhida no modal de pagamento, então exigir CEP no botão
   * trancaria a vendedora do lado de fora da única tela onde ela pode dizer
   * que é RETIRADA — e retirada não pede endereço (dono 18/08). Quem cobra o
   * endereço é o modal, com a modalidade já na mão, antes de qualquer
   * cobrança sair.
   */
  const faltaContatoOnline = useMemo(
    () => faltandoDadosBasicosClienteOnline(clienteOnline),
    [clienteOnline],
  );
  /** Modal de cliente aberto pelo fluxo online = campos obrigatórios. */
  const [exigirDadosOnline, setExigirDadosOnline] = useState(false);
  /**
   * Modalidade que o cadastro deve cobrar. Vem do modal de pagamento (a
   * escolha viva) ou da venda já gravada. `null` = ainda não escolheu → o
   * cadastro pede só o contato e deixa o endereço opcional.
   */
  const [entregaDoCadastro, setEntregaDoCadastro] = useState<string | null>(null);
  const abrirCadastroOnline = (entregaTipo?: string | null) => {
    setEntregaDoCadastro(entregaTipo ?? (sale as any)?.entregaTipo ?? null);
    setExigirDadosOnline(true);
    setShowCustomer(true);
  };

  const venderOutro = (method: string) => {
    if (method === 'pix') { setPaymentFilter('pix'); setShowPayment(true); return; }
    if (method === 'crediario') { setPaymentFilter('crediario'); setShowPayment(true); return; }
    if (method === 'dinheiro') { setPresetMethod('dinheiro'); setPaymentFilter('all'); setShowPayment(true); return; }
    if (method === 'convenio') {
      setPresetMethod('convenio');
      setPresetBandeira(null);
      setPaymentFilter('all');
      setShowPayment(true);
      return;
    }
    if (method === 'venda_online') {
      // CONTATO antes do pagamento (dono 18/08): nome e sobrenome, CPF,
      // WhatsApp e e-mail. Antes bastava ter CPF — e era assim que a venda ia
      // embora sem nome de verdade. O ENDEREÇO é cobrado lá dentro, no modal,
      // porque só lá se sabe se a peça viaja: retirada em loja não pede.
      if (faltaContatoOnline.length) {
        toast(
          'warning',
          'Complete o cadastro da cliente',
          `Venda online precisa de: ${faltaContatoOnline.join(', ')}.`,
        );
        abrirCadastroOnline();
        return;
      }
      setPresetMethod('venda_online');
      setPaymentFilter('all');
      setShowPayment(true);
    }
  };

  // ── Render ──

  if (!storeCode) {
    return (
      <div className={`pdv1-skin ${nightMode ? 'pdv-night' : ''} min-h-screen bg-[#FAFAF7] flex items-center justify-center p-4`}>
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
      className={`pdv1-skin pdv-dense-${densityUsada} ${nightMode ? 'pdv-night' : ''} min-h-screen flex flex-col`}
      style={{
        background: nightMode ? '#0B1120' : '#FAFAF7',
        zoom: uiZoom,
        // `zoom` reduz também os 100vh do root. Compensa a altura para não
        // deixar uma faixa do fundo global aparecendo abaixo do PDV.
        minHeight: uiZoom < 1 ? `${Math.ceil(100 / uiZoom)}vh` : '100vh',
      }}
    >
      <TrainingModeBanner />
      {/* Header — barra branca fina (espec do layout claro): wordmark Lurd's +
          cidade + badge "PDV · loja" à esquerda; operadora, relógio do caixa e
          status de conexão à direita. Botões funcionais (Pausadas, Online,
          Treinamento) viram chips compactos no mesmo grupo da direita. */}
      <header
        className="sticky top-0 z-20"
        style={{
          background: nightMode ? '#111827' : '#FFFFFF',
          borderBottom: `1px solid ${nightMode ? '#334155' : '#EDEAE1'}`,
        }}
      >
        <div className="max-w-[1700px] mx-auto pl-3 pr-5 py-2.5 flex items-center gap-3">
          <Link
            href="/minha-loja"
            className="text-slate-400 hover:text-slate-700 transition shrink-0"
            aria-label="Voltar"
            title="Voltar ao início"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>

          {/* Logotipo Lurd's — só a marca, sem texto */}
          <Link href="/minha-loja" className="flex items-center shrink-0 group" title="Início">
            <div className="relative w-11 h-11 shrink-0">
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

          <span
            className="text-base font-bold text-slate-800 truncate leading-none"
            title={sale?.storeName || ''}
          >
            {sale?.storeName || 'Carregando…'}
          </span>

          {sale?.storeCode && (
            <span className="text-[11px] font-bold text-slate-500 bg-[#F3F1EA] border border-[#E5E2D9] px-2 py-1 rounded-md leading-none shrink-0">
              PDV · {sale.storeCode}
            </span>
          )}

          <div className="flex-1" />

          {/* Botão Pausadas — sempre visível; chip compacto */}
          <button
            onClick={() => setShowOpenList(true)}
            className={`relative text-xs px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 font-bold shrink-0 transition text-slate-600 bg-white border ${
              openCount > 0
                ? 'border-[#CDA434] hover:bg-[#FBF6E6]'
                : 'border-slate-200 hover:border-[#CDA434] hover:bg-[#FBF6E6]'
            }`}
            title={openCount > 0 ? `${openCount} venda(s) pausada(s)` : 'Nenhuma venda pausada agora — clique pra ver histórico recente'}
          >
            <Pause className="w-3.5 h-3.5 text-[#B8912B]" />
            <span className="hidden xl:inline">Pausadas</span>
            <span className={`text-[10px] font-black rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 ${
              openCount > 0 ? 'bg-[#CDA434] text-black' : 'bg-slate-100 text-slate-500'
            }`}>
              {openCount}
            </span>
          </button>

          {/* Totais operacionais ficam ocultos até a abertura deste resumo. */}
          <button
            type="button"
            onClick={() => setShowStoreSummary(true)}
            disabled={!storeCode}
            className="text-xs px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 font-bold shrink-0 bg-white hover:bg-[#FBF6E6] text-slate-600 border border-slate-200 hover:border-[#CDA434] transition disabled:opacity-40 disabled:cursor-not-allowed"
            title="Ver peças vendidas hoje e estoque atual da loja"
          >
            <Package className="w-3.5 h-3.5 text-[#B8912B]" />
            <span className="hidden xl:inline">Resumo da Loja</span>
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
                className={`relative text-xs px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 font-bold shrink-0 transition ${
                  hasPaid
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-white ring-2 ring-emerald-300 animate-pulse'
                    : 'bg-white hover:bg-[#FBF6E6] text-slate-600 border border-slate-200 hover:border-[#CDA434]'
                }`}
                title={
                  hasPaid
                    ? `${paidCount} pagamento(s) confirmado(s) — clique pra finalizar`
                    : `${totalLinks} link(s) aguardando pagamento`
                }
              >
                <span className="text-sm leading-none">🔗</span>
                <span className="hidden xl:inline">
                  {hasPaid ? `${paidCount} PAGO${paidCount > 1 ? 'S' : ''}!` : 'Online'}
                </span>
                <span className={`text-[10px] font-black rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 ${
                  hasPaid ? 'bg-white text-emerald-700' : 'bg-[#D4AF37] text-black'
                }`}>
                  {totalLinks}
                </span>
              </button>
            );
          })()}

          {/* Vendedora da venda (quando já definida). Alguns fluxos gravam o
              nome da LOJA em vendedorName — nesse caso não mostra (ficaria
              duplicado com o título da loja no lado esquerdo). */}
          {(() => {
            const nome = (sale?.sellerName || sale?.vendedorName || '').trim();
            if (!nome) return null;
            if (nome.toLowerCase() === (sale?.storeName || '').trim().toLowerCase()) return null;
            return (
              <span className="hidden md:flex items-center gap-1.5 text-xs font-semibold text-slate-500 shrink-0">
                <User className="w-3.5 h-3.5 text-slate-400" />
                {nome.split(' ')[0]}
              </span>
            );
          })()}

          <span className="hidden md:block"><HeaderClock /></span>
          <span className="hidden sm:block"><ConnBadge compact /></span>

          {/* Preferência local deste computador; não interfere na venda aberta. */}
          <button
            type="button"
            onClick={toggleColorTheme}
            className="flex text-xs px-2.5 py-1.5 rounded-lg items-center gap-1.5 font-bold shrink-0 bg-white hover:bg-[#FBF6E6] text-slate-600 border border-slate-200 hover:border-[#CDA434] transition"
            title={nightMode ? 'Voltar ao modo claro neste computador' : 'Escurecer o PDV neste computador'}
            aria-label={nightMode ? 'Ativar modo claro' : 'Ativar modo noturno'}
            aria-pressed={nightMode}
          >
            {nightMode ? <Sun className="w-3.5 h-3.5 text-[#D4AF37]" /> : <Moon className="w-3.5 h-3.5 text-slate-500" />}
            <span className="hidden xl:inline">{nightMode ? 'Modo claro' : 'Modo noturno'}</span>
          </button>

          {/* Rollback instantâneo do piloto visual — preferência local deste caixa. */}
          <button
            type="button"
            onClick={toggleCheckoutLayout}
            className="hidden lg:flex text-xs px-2.5 py-1.5 rounded-lg items-center gap-1.5 font-bold shrink-0 bg-white hover:bg-[#FBF6E6] text-[#8C7325] border border-[#CDA434] transition"
            title={checkoutLayout === 'highlighted' ? 'Voltar agora ao visual anterior' : 'Ativar novamente o novo visual'}
          >
            {checkoutLayout === 'highlighted'
              ? <RotateCcw className="w-3.5 h-3.5" />
              : <Sparkles className="w-3.5 h-3.5" />}
            {checkoutLayout === 'highlighted' ? 'Visual anterior' : 'Usar visual novo'}
          </button>

          {/* Botão Modo Treinamento — só aparece quando NÃO está em treino. */}
          <TrainingModeButton className="text-xs px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 font-bold shrink-0 bg-white hover:bg-[#FBF6E6] text-[#B58A1E] border border-[#CDA434]" />
        </div>
      </header>

      {/* CONTAINER PRINCIPAL: rail de ícones (esquerda) + carrinho (centro) +
          painel de pagamento (direita). pb-12 deixa espaço pro rodapé fino
          fixo de status. */}
      <div className="flex-1 w-full max-w-[1700px] mx-auto flex flex-col lg:flex-row items-start gap-4 px-3 lg:px-5 pt-4 pb-14 bg-[#FAFAF7]">

      {/* ─── MENU LATERAL ESQUERDO (padrão da referência) ───────────────────
          Linhas horizontais: ícone + label à esquerda, atalho real à direita.
          "Venda" (tela atual) ativa em dourado. "Recolher menu" encolhe pra
          coluna de ícones. Rodapé com o logotipo + versão. Em mobile (<lg)
          some — PdvMobilePill horizontais continuam pra mesma navegação.

          ⚠️ O MENU NÃO DEPENDE DE EXISTIR VENDA (12/08/2026).
          A condição era `sale?.status === 'open'`. Com a venda passando a
          nascer só no PRIMEIRO BIPE, a tela vazia ficou sem venda — e o menu
          inteiro sumia junto: Produtos (F10), Baixa crediário, Marcados,
          Trocas, Retiradas, Fechamento. Pra consultar um preço ou receber uma
          parcela a vendedora tinha que bipar uma peça antes. Menu é navegação,
          não estado da venda: aparece com a tela vazia e enquanto carrega.
          Só some com a venda finalizada/cancelada, que é quando a tela vira
          o fecho da venda. */}
      {(!sale || sale.status === 'open') && (() => {
        const rowBase = menuCollapsed
          ? 'w-full flex items-center justify-center rounded-lg py-2.5 transition text-slate-600 hover:bg-[#FBF6E6] hover:text-[#8C7325]'
          : 'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 transition text-slate-600 hover:bg-[#FBF6E6] hover:text-[#8C7325]';
        const rowLabel = menuCollapsed ? 'hidden' : 'text-[13px] font-semibold leading-none truncate';
        const rowKey = menuCollapsed ? 'hidden' : 'ml-auto text-[9px] font-mono font-bold bg-slate-100 text-slate-400 border border-slate-200 rounded px-1 py-0.5 shrink-0';
        const rowIcon = 'w-[18px] h-[18px] shrink-0';
        return (
        <aside className={`${menuCollapsed ? 'w-[76px]' : 'w-[220px]'} shrink-0 hidden lg:flex flex-col sticky self-start top-[64px] transition-all`}>
          <div className="bg-white border border-[#E5E2D9] rounded-2xl p-2 flex flex-col gap-1 shadow-sm max-h-[calc(100vh-120px)] overflow-y-auto">
            <span
              className={`${menuCollapsed ? 'w-full flex items-center justify-center py-2.5' : 'w-full flex items-center gap-2.5 px-3 py-2'} rounded-lg bg-[#FBF6E6] text-[#8C7325] ring-1 ring-[#D4AF37]/50`}
              title="Venda (tela atual)"
            >
              <ShoppingCart className={rowIcon} />
              <span className={menuCollapsed ? 'hidden' : 'text-[13px] font-black leading-none'}>Venda</span>
            </span>
            <Link href="/minha-loja/consultar" className={rowBase} title="Consulta de produtos (F10)">
              <Search className={rowIcon} />
              <span className={rowLabel}>Produtos</span>
              <span className={rowKey}>F10</span>
            </Link>
            <Link
              href="/minha-loja/pdv/devolucao"
              onClick={() => {
                try {
                  if (sale?.id) localStorage.setItem('lurds_pdv_attach_to_sale_id', JSON.stringify({ id: sale.id, ts: Date.now(), items: sale.items?.length || 0 }));
                  else localStorage.removeItem('lurds_pdv_attach_to_sale_id');
                } catch {}
              }}
              className={rowBase}
              title="Trocas / Devolução (F4)"
            >
              <ArrowRightLeft className={rowIcon} />
              <span className={rowLabel}>Trocas</span>
              <span className={rowKey}>F4</span>
            </Link>
            <Link href="/site/trocas" className={rowBase} title="Troca de pedido do site (lurds.com.br)">
              <Globe className={rowIcon} />
              <span className={rowLabel}>Troca site</span>
            </Link>
            <Link href="/minha-loja/pdv/marcados" className={rowBase} title="Marcados (provar em casa)">
              <Tag className={rowIcon} />
              <span className={rowLabel}>Marcados</span>
            </Link>
            <Link href="/minha-loja/pdv/recebimentos" className={rowBase} title="Baixa de Crediário — receber parcelas">
              <Receipt className={rowIcon} />
              <span className={rowLabel}>Baixa crediário</span>
            </Link>
            <Link href="/minha-loja/pdv/caixa" className={rowBase} title="Retiradas, sangria, suprimento (F3)">
              <DollarSign className={rowIcon} />
              <span className={rowLabel}>Retiradas</span>
              <span className={rowKey}>F3</span>
            </Link>
            <Link href="/minha-loja/pdv/produtos-vendidos" className={rowBase} title="Conferir vendas + trocas do turno">
              <History className={rowIcon} />
              <span className={rowLabel}>Produtos vendidos</span>
            </Link>
            <Link href="/minha-loja/pdv/notas" className={rowBase} title="Notas Fiscais emitidas">
              <FileText className={rowIcon} />
              <span className={rowLabel}>Notas fiscais</span>
            </Link>
            <Link href="/minha-loja/pdv/config-impressora" className={rowBase} title="Configurar impressoras térmica e A4">
              <Printer className={rowIcon} />
              <span className={rowLabel}>Impressoras</span>
            </Link>

            <div className="h-px bg-[#EDEAE1] mx-2 my-1" />

            <button
              type="button"
              onClick={() => setShowSimular(true)}
              disabled={restanteVenda(sale) <= 0}
              className={`${rowBase} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
              title="Simular parcelamento"
            >
              <CreditCard className={rowIcon} />
              <span className={rowLabel}>Simular</span>
            </button>
            <Link href="/minha-loja" className={`${rowBase} relative`} title="Pedidos do site (e-commerce)">
              <Globe className={rowIcon} />
              <span className={rowLabel}>Pedidos site</span>
              {pedidosSitePending > 0 && (
                <span className={`${menuCollapsed ? 'absolute top-1 right-1.5' : 'ml-auto'} bg-[#D4AF37] text-black text-[9px] font-black rounded-full min-w-[16px] h-4 flex items-center justify-center px-1 shrink-0`}>
                  {pedidosSitePending}
                </span>
              )}
            </Link>
            {/* CARRINHOS ABANDONADOS DENTRO DO PDV (17/08).
                O botão de importar existia só na retaguarda — e os PDVs NÃO
                TÊM ACESSO À RETAGUARDA. Ou seja: a ferramenta que resolve as
                5 vendas/dia que não entram no sistema era inalcançável por
                quem precisa dela. Medido em 17/08: 7 carrinhos recuperados no
                dia, 2 registrados. Aqui a menina abre a lista sem sair da tela
                em que trabalha, clica na cliente e a venda monta pronta.

                SÓ NA LOJA 13 (SITE) — decisão do dono: é o time do carrinho
                abandonado que trabalha esses contatos. Loja física não vê
                carrinho de cliente que não é dela. */}
            {storeCode === CARRINHOS_STORE_CODE && (
              <button
                type="button"
                onClick={() => setShowCarrinhos(true)}
                className={`${rowBase} relative`}
                title="Carrinhos abandonados do site — fechar a venda aqui"
              >
                <ShoppingCart className={rowIcon} />
                <span className={rowLabel}>Carrinhos</span>
              </button>
            )}
            <Link href="/minha-loja/realinhamento" className={`${rowBase} relative`} title="Realinhamento de estoque inter-lojas">
              <Shuffle className={rowIcon} />
              <span className={rowLabel}>Realinhar</span>
              {realignPending > 0 && (
                <span className={`${menuCollapsed ? 'absolute top-1 right-1.5' : 'ml-auto'} bg-[#D4AF37] text-black text-[9px] font-black rounded-full min-w-[16px] h-4 flex items-center justify-center px-1 shrink-0`}>
                  {realignPending}
                </span>
              )}
            </Link>
            <Link href="/minha-loja/pdv/fechamento" className={rowBase} title="Fechamento diário">
              <Wallet className={rowIcon} />
              <span className={rowLabel}>Fechamento</span>
            </Link>

            <div className="h-px bg-[#EDEAE1] mx-2 my-1" />

            <button
              type="button"
              onClick={toggleMenu}
              className={rowBase}
              title={menuCollapsed ? 'Expandir menu' : 'Recolher menu'}
            >
              <ChevronRight className={`${rowIcon} transition-transform ${menuCollapsed ? '' : 'rotate-180'}`} />
              <span className={rowLabel}>Recolher menu</span>
            </button>

            {/* Rodapé do menu — logotipo + versão */}
            <div className={`flex flex-col items-${menuCollapsed ? 'center' : 'start'} gap-0.5 px-3 pt-2 pb-1`}>
              <div className="relative w-16 h-8">
                <Image src="/lurds-logo.png" alt="Lurd's" fill sizes="64px" className="object-contain object-left" />
              </div>
              {!menuCollapsed && (
                <span className="text-[10px] text-slate-400 font-medium">Versão 1.0.0</span>
              )}
            </div>
          </div>
        </aside>
        );
      })()}

      {/* Centro + resumo. No visual novo, as bandeiras acompanham o carrinho e
          as demais formas de pagamento acompanham o painel de totais. */}
      <div className="flex-1 min-w-0 w-full flex flex-col lg:flex-row lg:flex-wrap items-start gap-4">

      <main className="flex-1 min-w-0 space-y-3 w-full lg:basis-0">
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
        {/* A barra de bipe aparece TAMBÉM sem venda aberta — é ela que cria a
            venda no primeiro bipe (antes a venda nascia junto com a tela e
            enchia o banco de registro vazio). */}
        {(!sale || sale.status === 'open') && (
          <ScanBar
            ref={scanBarRef}
            saleId={sale?.id ?? null}
            ensureSaleId={ensureSaleId}
            onScanResult={(fresh) => {
              // flash verde no item recém-adicionado + atualiza a venda.
              flashAddedItem(sale?.items || [], fresh.items || []);
              setSale(fresh);
            }}
            onError={setError}
            onRequestManualItem={() => setShowManualItem(true)}
            onAbrirPromoCheck={() => setPromoCheckOpen(true)}
          />
        )}

        {/* Carrinho */}
        {loadingSale ? (
          <div className="text-center py-10 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin inline-block" />
          </div>
        ) : sale && sale.items?.length > 0 ? (
          <div className="bg-white rounded-2xl border border-[#E5E2D9] shadow-sm overflow-hidden">
            {/* Cabeçalho do card — contador de PEÇAS em DESTAQUE (soma das qtds,
                não nº de linhas: linha com qty 3 conta 3 peças). */}
            <div className={`${checkoutLayout === 'highlighted' ? 'px-4 pt-2.5 pb-2' : 'px-4 pt-3.5 pb-2.5'} flex items-baseline justify-between`}>
              {(() => {
                const totalPecas = sale.items.reduce((s, i) => s + i.qty, 0);
                return (
                  <>
                    <span className="tabular-nums leading-none" title="Total de peças (soma das quantidades). Último item bipado aparece no topo.">
                      <span className="text-3xl font-black text-slate-900">{totalPecas}</span>
                      <span className="text-base font-bold text-slate-500 ml-1.5">{totalPecas === 1 ? 'peça' : 'peças'}</span>
                    </span>
                    {totalPecas !== sale.items.length && (
                      <span className="text-xs font-semibold text-slate-400">
                        {sale.items.length} {sale.items.length === 1 ? 'linha' : 'linhas'}
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
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
              </div>
              {/* Recalcular preços — resgata o preço ATUAL (promoção) de cada
                  item. Itens puxados de MARCADO vêm com o preço original. */}
              <button
                type="button"
                onClick={recalcularPrecos}
                disabled={recalculando}
                className="mt-1.5 w-full text-xs py-1.5 px-1 rounded font-bold border border-[#D4AF37] bg-white text-[#8C7325] hover:bg-[#FBF6E6] transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
                title="Reconsulta o preço atual (promoção vigente) de cada item — corrige peças marcadas que vieram com o preço original"
              >
                {recalculando ? '⏳ Recalculando…' : '🔄 Recalcular preços (promoção)'}
              </button>
            </div>
            )}
            <div className={`divide-y divide-[#F0EEE6] ${checkoutLayout === 'highlighted' ? 'lg:max-h-[min(460px,calc(100vh-410px))] lg:min-h-[300px] overflow-y-auto overscroll-contain' : ''}`}>
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
                    className={`${checkoutLayout === 'highlighted' ? 'px-4 py-2' : 'px-4 py-3'} flex items-center gap-3 bg-[#FAF6E8] border-l-4 border-[#D4AF37]`}
                    title="Vale-troca aplicado — abate da venda"
                  >
                    <div className="w-11 h-11 rounded-lg bg-white border border-[#E5E2D9] flex items-center justify-center text-[#8C7325] text-xl shrink-0">↺</div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-slate-900">Devolução (vale-troca)</div>
                      <div className="text-xs text-[#8C7325] font-mono mt-0.5">{code || 'VALE'}</div>
                    </div>
                    <div className="text-right text-sm font-bold text-rose-700 tabular-nums shrink-0">−{brl(Number(p.valor) || 0)}</div>
                    <button
                      onClick={async () => {
                        if (!confirm(`Remover vale-troca ${code}?\n\nO codigo TROCA volta a ficar disponivel.`)) return;
                        try {
                          const r = await api<any>(`/pdv/sales/${sale.id}/payments/${p.id}`, { method: 'DELETE' });
                          const fresh = await saleFromResponse(r, sale.id);
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
                  className={`${checkoutLayout === 'highlighted' ? 'px-4 py-2' : 'px-4 py-3'} flex items-center gap-3 transition-colors duration-500 ${
                    it.id === lastAddedItemId
                      ? 'bg-emerald-200/80 ring-2 ring-inset ring-emerald-500'
                      : isLast
                      ? 'bg-[#FAF6E8]/70 shadow-[inset_3px_0_0_0_#D4AF37]'
                      : 'hover:bg-[#FAF6E8]/50'
                  }`}
                >
                  {/* THUMBNAIL — busca foto do WooCommerce; fallback avatar */}
                  <ProductThumb sku={it.sku} refCode={it.ref} compact={checkoutLayout === 'highlighted'} />

                  {/* NOME + linha "ref · tamanho" (espec). EAN/SKU ficam no title. */}
                  <div className="min-w-0 flex-1" title={`SKU ${it.sku}${it.ean ? ` · EAN ${it.ean}` : ''}`}>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-bold text-slate-900 truncate">
                        {it.descricao || it.ref || it.sku}
                      </span>
                      {/* Badge de promoção (pedido do dono 14/07): 30% maior e
                          código de cor fixo — AZUL = fora/sem promoção (básico),
                          VERMELHO = participando de promoção. MANUAL segue cinza. */}
                      {it.promoTag && (() => {
                        const semPromo =
                          it.promoTag === 'SEM_PROMO' || /SEM PROMO/i.test(it.promoTag);
                        return (
                          <span
                            className={`text-[12px] font-bold px-2 py-1 rounded shrink-0 ${
                              semPromo
                                ? 'bg-blue-600 text-white border border-blue-700'
                                : it.promoTag === 'MANUAL'
                                ? 'bg-slate-600 text-white border border-slate-600'
                                : 'bg-red-600 text-white border border-red-700'
                            }`}
                            title={semPromo ? 'Fora da promoção (não participa)' : `Desconto: ${brl(it.desconto)}`}
                          >
                            {semPromo
                              ? (it.promoTag === 'SEM_PROMO' ? '🚫 Fora da promo' : `🚫 ${it.promoTag}`)
                              : it.promoTag === 'MANUAL'
                              ? '✏️ MANUAL'
                              : `🎁 ${it.promoTag}`}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="text-xs text-slate-400 font-medium mt-0.5 truncate">
                      ref {it.ref || it.sku}
                      {it.tamanho ? ` · ${it.tamanho}` : ''}
                      {it.qty > 1 ? ` · ${it.qty} × ${brl(it.precoUnit)}` : ''}
                    </div>
                  </div>

                  {/* QTD — stepper − / valor / + (espec). Valor continua editável. */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => { if (it.qty > 1) updateItem(it.id, { qty: it.qty - 1 }); }}
                      disabled={sale.status !== 'open' || it.qty <= 1}
                      className="w-9 h-9 rounded-md border border-[#E5E2D9] bg-white text-slate-500 hover:bg-[#FAF6E8] hover:text-[#8C7325] flex items-center justify-center transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Diminuir quantidade"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
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
                      className="w-10 h-9 text-center font-bold tabular-nums text-sm text-slate-900 border-0 bg-transparent focus:outline-none focus:ring-2 focus:ring-[#D4AF37]/50 rounded disabled:opacity-60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <button
                      onClick={() => { if (it.qty < 99) updateItem(it.id, { qty: it.qty + 1 }); }}
                      disabled={sale.status !== 'open' || it.qty >= 99}
                      className="w-9 h-9 rounded-md border border-[#E5E2D9] bg-white text-slate-500 hover:bg-[#FAF6E8] hover:text-[#8C7325] flex items-center justify-center transition active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Aumentar quantidade"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>

                  {/* TOTAL DA LINHA */}
                  <div className="text-right w-[92px] shrink-0">
                    <div className="font-bold text-slate-900 tabular-nums text-sm">{brl(it.total)}</div>
                    {it.desconto > 0 && (
                      <div className="text-[10px] text-slate-400 line-through tabular-nums">{brl(bruto)}</div>
                    )}
                  </div>

                  {/* AÇÕES — % desconto + 🗑 remover, discretos à direita */}
                  {sale.status === 'open' ? (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() =>
                          setShowDiscount({ kind: 'item', itemId: it.id, bruto, atual: it.desconto || 0 })
                        }
                        className={`w-9 h-9 rounded-lg flex items-center justify-center transition active:scale-95 ${
                          it.desconto > 0 && it.promoTag === 'MANUAL'
                            ? 'bg-amber-500 text-white hover:bg-amber-600'
                            : 'text-slate-300 hover:text-amber-600 hover:bg-amber-50'
                        }`}
                        title={
                          it.desconto > 0 && it.promoTag === 'MANUAL'
                            ? `Desconto manual: ${brl(it.desconto)} (clique pra alterar)`
                            : 'Aplicar desconto neste item (% ou R$)'
                        }
                      >
                        <Percent className="w-4 h-4" />
                      </button>
                      {/* Botão de PROMOÇÃO por item (campanha ativa). Um só botão,
                          conforme o estado:
                            🎁 verde  = SEM_PROMO → voltar ao automático
                            ⬆️ azul   = BÁSICO → COLOCAR na promoção (força, ignora
                                        só o filtro básico; data/coleção seguem)
                            ⬇️ azul   = FORÇADO → tirar da promo forçada (volta básico)
                            🚫 cinza  = promo automática → tirar da promoção */}
                      {sale.activePromotion && sale.activePromotion !== 'NONE' && (() => {
                        const semPromoTag = it.promoTag === 'SEM_PROMO';
                        const isForced = !!it.forcarPromo;
                        const basicoTag = !isForced && /b[áa]sico/i.test(it.promoTag || '');
                        const autoPromo = !isForced && it.desconto > 0 && /^(PROMO|4 LEVA)/.test(it.promoTag || '');
                        if (semPromoTag) {
                          return (
                            <button
                              onClick={() => updateItem(it.id, { excludePromo: false })}
                              className="w-9 h-9 rounded-lg flex items-center justify-center text-[15px] leading-none transition active:scale-95 bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                              title="Incluir este item na promoção (volta ao automático)"
                            >🎁</button>
                          );
                        }
                        if (isForced) {
                          return (
                            <button
                              onClick={() => updateItem(it.id, { forcePromo: false })}
                              className="w-9 h-9 rounded-lg flex items-center justify-center text-[15px] leading-none transition active:scale-95 bg-blue-600 text-white hover:bg-blue-700"
                              title="Tirar da promoção forçada (volta a básico)"
                            >⬇️</button>
                          );
                        }
                        if (basicoTag) {
                          return (
                            <button
                              onClick={() => updateItem(it.id, { forcePromo: true })}
                              className="w-9 h-9 rounded-lg flex items-center justify-center text-[15px] leading-none transition active:scale-95 bg-blue-100 text-blue-700 hover:bg-blue-200"
                              title="Colocar este item na promoção (aplica o desconto mesmo sendo básico)"
                            >⬆️</button>
                          );
                        }
                        if (autoPromo) {
                          return (
                            <button
                              onClick={() => updateItem(it.id, { excludePromo: true })}
                              className="w-9 h-9 rounded-lg flex items-center justify-center text-[15px] leading-none transition active:scale-95 bg-slate-200 text-slate-700 hover:bg-slate-300"
                              title="Tirar este item da promoção (não participa)"
                            >🚫</button>
                          );
                        }
                        return null;
                      })()}
                      <button
                        onClick={() => removeItem(it.id)}
                        className="w-9 h-9 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 flex items-center justify-center transition active:scale-95"
                        title="Remover item"
                      >
                        <Trash2 className="w-4 h-4" />
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

        {checkoutLayout === 'highlighted' && sale?.status === 'open' && (
          <QuickCardBrandDock
            disabled={(sale.items?.length ?? 0) === 0 || (sale.total || 0) <= 0}
            onCredit={(brand) => venderCredito(brand)}
            onDebit={(brand) => venderDebito(brand)}
          />
        )}
      </main>

      {/* PAINEL DIREITO: cliente + totais + controles operacionais. */}
      {sale?.status === 'open' && (() => {
        const podePagar = (sale.items?.length ?? 0) > 0 && (sale.total || 0) > 0;
        const paid = (sale.payments || []).reduce((s: number, p: any) => s + (Number(p.valor) || 0), 0);
        const liquido = Math.round((sale.total - paid) * 100) / 100;
        const ehCredito = liquido < -0.01;
        const temPgtoParcial = paid > 0.01 && paid < sale.total - 0.01;
        const descontoItens = sale.items.reduce((s, i) => s + (i.desconto || 0), 0);
        const economiaTotal = descontoItens + (sale.desconto || 0);
        const valeTrocaPago = (sale.payments || []).reduce(
          (s: number, p: any) => p.method === 'vale_troca' ? s + (Number(p.valor) || 0) : s,
          0,
        );
        const payBtnCls = 'flex items-center gap-2 border border-[#E5E2D9] rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-700 bg-white hover:bg-[#FBF6E6] hover:border-[#CDA434] hover:text-[#8C7325] transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-[#E5E2D9] disabled:hover:text-slate-700';
        return (
      <>
      <aside className="w-full lg:w-[320px] shrink-0 flex flex-col gap-3 lg:sticky self-start lg:top-[64px]">

        {/* Card do CLIENTE — clique abre o modal de identificação (F6) */}
        <button
          onClick={() => setShowCustomer(true)}
          className="w-full bg-white rounded-2xl border border-[#E5E2D9] shadow-sm px-4 py-3 flex items-center gap-3 text-left hover:border-[#CDA434] hover:bg-[#FBF6E6]/40 transition group"
          title="Identificar / trocar cliente (atalho F6)"
        >
          <div className="w-10 h-10 rounded-full bg-[#F3F1EA] border border-[#E5E2D9] flex items-center justify-center shrink-0">
            {sale.customerName ? (
              <span className="text-xs font-black text-[#8C7325]">
                {sale.customerName.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('')}
              </span>
            ) : (
              <User className="w-5 h-5 text-slate-400" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            {sale.customerName || sale.customerCpf ? (
              <>
                <div className="text-sm font-bold text-slate-900 truncate">{sale.customerName || 'Cliente'}</div>
                <div className="text-xs text-slate-400 font-medium mt-0.5 truncate">
                  {sale.customerCpf
                    ? `CPF ${String(sale.customerCpf).replace(/\D/g, '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.***.***-$4')}`
                    : 'Sem CPF'}
                </div>
                {clientePessoa && ((clientePessoa.origem && !clientePessoa.origem.daLojaAtual) || clientePessoa.cashbackBalanceCents > 0) && (
                  <div className="text-[10px] font-bold mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
                    {clientePessoa.origem && !clientePessoa.origem.daLojaAtual && (
                      <span className="text-sky-700 truncate">
                        {clientePessoa.origem.source === 'woo'
                          ? '🌐 Cliente do SITE'
                          : `🏬 Cliente da loja ${clientePessoa.origem.storeName || clientePessoa.origem.storeCode || '—'}`}
                      </span>
                    )}
                    {clientePessoa.cashbackBalanceCents > 0 && (
                      <span className="text-emerald-700">💰 {brl(clientePessoa.cashbackBalanceCents / 100)} cashback</span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-sm font-bold text-slate-500">Identificar cliente</div>
                <div className="text-xs text-slate-400 font-medium mt-0.5">CPF / nome / telefone</div>
              </>
            )}
          </div>
          <span className="text-slate-300 group-hover:text-[#8C7325] transition shrink-0 flex items-center gap-1">
            <kbd className="text-[9px] font-mono bg-slate-100 text-slate-400 border border-slate-200 rounded px-1 py-0.5">F6</kbd>
            <ChevronRight className="w-4 h-4" />
          </span>
        </button>

        {/* Card TOTAIS + PAGAMENTO */}
        <div className="bg-white rounded-2xl border border-[#E5E2D9] shadow-sm p-4 space-y-3">
          <div className="space-y-1.5 text-sm">
            {/* Contador de PEÇAS — soma das quantidades (linha qty 3 = 3 peças).
                Sempre visível, mesmo com carrinho vazio. */}
            <div className="flex justify-between items-center">
              <span className="text-slate-500 font-medium">Peças</span>
              <span className="font-semibold text-slate-800 tabular-nums">
                {(sale.items || []).reduce((s, i) => s + i.qty, 0)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500 font-medium">Subtotal</span>
              <span className="font-semibold text-slate-800 tabular-nums">{brl(sale.subtotal)}</span>
            </div>
            {economiaTotal > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-[#2E7D46] font-medium">Desconto</span>
                <span className="font-semibold text-[#2E7D46] tabular-nums">− {brl(economiaTotal)}</span>
              </div>
            )}
            {valeTrocaPago > 0.01 && (
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Devolução / Vale</span>
                <span className="font-semibold text-rose-600 tabular-nums">− {brl(valeTrocaPago)}</span>
              </div>
            )}
            {temPgtoParcial && (
              <div className="flex justify-between items-center">
                <span className="text-slate-500 font-medium">Já pago</span>
                <span className="font-semibold text-emerald-600 tabular-nums">✓ {brl(paid)}</span>
              </div>
            )}
          </div>

          <div className="border-t border-[#F0EEE6] pt-2.5 flex justify-between items-baseline">
            <span className="text-sm font-semibold text-slate-600">
              {ehCredito ? 'Sobra crédito' : temPgtoParcial ? 'Falta a pagar' : 'Total a pagar'}
            </span>
            <span className={`text-[28px] font-black tabular-nums leading-none ${ehCredito ? 'text-rose-600' : 'text-[#2E7D46]'}`}>
              {ehCredito ? `− ${brl(Math.abs(liquido))}` : brl(liquido)}
            </span>
          </div>

          {/* Grade de formas de pagamento — 2 colunas (espec) */}
          <div className={checkoutLayout === 'legacy' ? 'grid grid-cols-2 gap-2' : 'hidden'}>
            <button onClick={() => venderOutro('pix')} disabled={!podePagar} className={payBtnCls} title="Receber em PIX">
              <QrCode className="w-4 h-4 shrink-0" /> PIX
            </button>
            <button onClick={() => venderOutro('dinheiro')} disabled={!podePagar} className={payBtnCls} title="Receber em dinheiro">
              <Banknote className="w-4 h-4 shrink-0" /> Dinheiro
            </button>
            <button onClick={() => venderDebito()} disabled={!podePagar} className={payBtnCls} title="Cartão de débito (bandeira no próximo passo)">
              <CreditCard className="w-4 h-4 shrink-0" /> Débito
            </button>
            <button onClick={() => venderCredito()} disabled={!podePagar} className={payBtnCls} title="Cartão de crédito (bandeira e parcelas no próximo passo)">
              <CreditCard className="w-4 h-4 shrink-0" /> Crédito
            </button>
            <button onClick={() => venderOutro('crediario')} disabled={!podePagar} className={payBtnCls} title="Crediário próprio">
              <Receipt className="w-4 h-4 shrink-0" /> Crediário
            </button>
            <button onClick={() => setShowValeTroca(true)} disabled={(sale.items?.length ?? 0) === 0} className={payBtnCls} title="Aplicar vale-troca">
              <Tag className="w-4 h-4 shrink-0" /> Vale-troca
            </button>
          </div>

          {/* Linha secundária — venda online + marcar + vale presente (fluxos especiais) */}
          <div className={checkoutLayout === 'legacy' ? 'grid grid-cols-3 gap-2' : 'hidden'}>
            <button
              onClick={() => setShowGiftVoucher(true)}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-500 border border-dashed border-[#E5E2D9] rounded-lg px-2 py-1.5 hover:bg-[#FBF6E6] hover:text-[#8C7325] hover:border-[#CDA434] transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Vender VALE PRESENTE — valor livre, código sai no cupom, cliente usa depois como vale-troca"
            >
              🎁 Vale Presente
            </button>
            <button
              onClick={() => venderOutro('venda_online')}
              disabled={!podePagar}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-500 border border-dashed border-[#E5E2D9] rounded-lg px-2 py-1.5 hover:bg-[#FBF6E6] hover:text-[#8C7325] hover:border-[#CDA434] transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Venda online (WhatsApp/Instagram) — pagamento já recebido por fora"
            >
              <Globe className="w-3.5 h-3.5" /> V. Online
            </button>
            <button
              ref={markSaleButtonRef}
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
                    setSale(null); // a próxima venda nasce no próximo bipe
                  } else {
                    toast('error', 'Falha ao marcar', r.error || 'Tente de novo');
                  }
                };
                try {
                  await doMarcar(false);
                } catch (e: any) {
                  const msg = String(e?.message || '');
                  // Erro de limite estourado — oferece override.
                  // Casa a FRASE do backend, não pedaço solto: `em marca` é
                  // substring de "po·dem marca·r", então "só clientes A podem
                  // marcar" era lido como limite estourado. A vendedora recebia
                  // "MARCAR MESMO ASSIM?", o force não relaxa classificação, e
                  // o resultado era "Falha mesmo com override" — escondendo que
                  // o problema era a ficha sem Avaliação A.
                  const isLimite = /maior que limite dispon[ií]vel/i.test(msg);
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
              disabled={(sale.items?.length ?? 0) === 0}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-500 border border-dashed border-[#E5E2D9] rounded-lg px-2 py-1.5 hover:bg-[#FBF6E6] hover:text-[#8C7325] hover:border-[#CDA434] transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Marcar — cliente leva pra provar em casa (exige CPF)"
            >
              <span className="text-sm leading-none">📋</span> Marcar
            </button>
          </div>

          {/* ERRO DO ÚLTIMO FINALIZE — fixo até a próxima tentativa */}
          {finalizeError && (
            <div className="bg-rose-50 border-2 border-rose-400 rounded-lg px-3 py-2 text-xs text-rose-900">
              <b>⚠️ A venda NÃO finalizou:</b> {finalizeError}
            </div>
          )}

          {/* FINALIZAR VENDA — verde, F8 (abre a tela de pagamento) */}
          {checkoutLayout === 'legacy' && (
            <button
              onClick={() => {
                if (sale.items?.length > 0) {
                  setPaymentFilter('all');
                  setShowPayment(true);
                }
              }}
              disabled={(sale.items?.length ?? 0) === 0}
              className="w-full py-3.5 rounded-xl text-white font-bold text-base flex items-center justify-center gap-2 transition hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
              style={{ background: '#2E7D46' }}
              title="Abrir pagamento e finalizar (atalho F8)"
            >
              <Check className="w-5 h-5" />
              Finalizar venda
              <kbd className="text-[10px] font-mono font-semibold bg-white/20 rounded px-1.5 py-0.5 ml-1">F8</kbd>
            </button>
          )}

          {/* FINALIZAR DIRETO — aparece SÓ quando a venda já está 100% paga
              (ex: vale-troca cobriu todo o total numa TROCA PAR). Sem esse
              botão, vendedora ficava travada sem saber onde clicar pra fechar. */}
          {sale.items?.length > 0 && (() => {
            const restante = Math.round((sale.total - paid) * 100) / 100;
            const jaCoberto = sale.total >= 0 && Math.abs(restante) < 0.01 && paid > 0;
            const trocaParZero = Math.abs(sale.total) < 0.01 && paid === 0;
            if (!jaCoberto && !trocaParZero) return null;
            return (
              <button
                onClick={() => finalizeSale('')}
                disabled={finalizing}
                className={`w-full py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-black rounded-xl flex items-center justify-center gap-2 text-base shadow-md ${trocaParZero ? '' : 'ring-4 ring-emerald-300/60 pdv-cta-attention'}`}
                title={trocaParZero ? 'Troca par sem diferença — clique pra finalizar' : 'Venda já está 100% paga (vale-troca cobriu tudo). Clique pra finalizar.'}
              >
                {finalizing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Check className="w-5 h-5" />}
                {finalizing ? 'Finalizando...' : 'FINALIZAR'}
              </button>
            );
          })()}

          {/* GERAR VALE DO SALDO — aparece quando vale_troca > total (cliente
              tem credito sobrando e nao quer levar outra peca). */}
          {sale.items?.length > 0 && (() => {
            const valeAplicado = (sale.payments || [])
              .filter((p: any) => String(p.method).toLowerCase() === 'vale_troca')
              .reduce((s: number, p: any) => s + (Number(p.valor) || 0), 0);
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
                className="w-full py-3 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-black rounded-xl flex items-center justify-center gap-2 text-base shadow-md ring-4 ring-rose-300/60 pdv-cta-attention"
                title={`Cria vale de R$ ${valorResidual.toFixed(2)} pra cliente usar depois`}
              >
                <span>💰</span>
                <span>Gerar vale R$ {valorResidual.toFixed(2).replace('.', ',')}</span>
              </button>
            );
          })()}

          {/* Ações da venda — discretas abaixo do finalizar */}
          <div className="flex items-center justify-between gap-1 pt-1 border-t border-[#F0EEE6]">
            <button
              onClick={cancelSale}
              className="flex-1 text-xs font-semibold text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg px-2 py-2 flex items-center justify-center gap-1 transition"
              title="Cancelar venda"
            >
              <X className="w-3.5 h-3.5" /> Cancelar
            </button>
            <button
              onClick={fecharDepois}
              disabled={!sale?.items?.length}
              className="flex-1 text-xs font-semibold text-slate-500 hover:text-[#8C7325] hover:bg-[#FBF6E6] rounded-lg px-2 py-2 flex items-center justify-center gap-1 transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Pausar venda (volta na lista Pausadas)"
            >
              <Pause className="w-3.5 h-3.5" /> Pausar
            </button>
            <button
              onClick={() => setShowDiscount({ kind: 'sale' })}
              className="flex-1 text-xs font-semibold text-slate-500 hover:text-[#8C7325] hover:bg-[#FBF6E6] rounded-lg px-2 py-2 flex items-center justify-center gap-1 transition"
              title="Aplicar desconto na venda toda (atalho F2)"
            >
              <Percent className="w-3.5 h-3.5" /> Desconto
            </button>
          </div>
        </div>

        {checkoutLayout === 'highlighted' && (
          <QuickSecondaryPaymentPanel
            disabled={!podePagar}
            itemsDisabled={(sale.items?.length ?? 0) === 0}
            convenioNome={quickConvenioAtivo?.nome || null}
            onPix={() => venderOutro('pix')}
            onMoney={() => venderOutro('dinheiro')}
            onCrediario={() => venderOutro('crediario')}
            onValeTroca={() => setShowValeTroca(true)}
            onVendaOnline={() => venderOutro('venda_online')}
            onValePresente={() => setShowGiftVoucher(true)}
            onMarcar={() => markSaleButtonRef.current?.click()}
            onConvenio={() => venderOutro('convenio')}
          />
        )}
      </aside>
      </>
        );
      })()}

      </div>{/* fim centro + resumo + pagamento rápido */}
      </div>{/* fim do flex main+sidebar */}

      {/* MOBILE BAR — em telas <lg, mostra ações em scroll horizontal acima do rodapé de status */}
      <div className="lg:hidden fixed bottom-11 left-0 right-0 z-10 px-3">
        <div className="max-w-4xl mx-auto bg-white/95 backdrop-blur border border-slate-200 rounded-2xl p-2 shadow-lg flex gap-2 overflow-x-auto">
          <PdvMobilePill tone="rose"   href="/minha-loja/pdv/recebimentos" icon={Receipt}    label="Crediário" />
          <PdvMobilePill tone="amber"  onClick={() => setShowSimular(true)} disabled={restanteVenda(sale) <= 0} icon={CreditCard} label="Simular" />
          <PdvMobilePill tone="sky"    href="/minha-loja/consultar"        icon={Search}     label="Estoque" />
          <PdvMobilePill tone="purple" href="/minha-loja"                  icon={Globe}      label="Site" badge={pedidosSitePending} />
          <PdvMobilePill tone="green"  href="/minha-loja/pdv/caixa"        icon={DollarSign} label="Caixa" />
          <PdvMobilePill tone="orange" href="/minha-loja/pdv/devolucao" onClick={() => { try { if (sale?.id) localStorage.setItem('lurds_pdv_attach_to_sale_id', JSON.stringify({ id: sale.id, ts: Date.now(), items: sale.items?.length || 0 })); else localStorage.removeItem('lurds_pdv_attach_to_sale_id'); } catch {} }} icon={ArrowRightLeft} label="Trocar" />
          <PdvMobilePill tone="slate"  onClick={() => setShowOpenList(true)} disabled={openCount === 0} icon={Pause} label="Pausa" badge={openCount} />
          <PdvMobilePill tone="orange" href="/minha-loja/realinhamento"    icon={Shuffle}    label="Realin." badge={realignPending} />
        </div>
      </div>

      {/* Rodapé fino de status — conexão / impressora / ambiente (espec) */}
      <StatusFooter density={density} onDensity={applyDensity} />

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
          exigirCompleto={exigirDadosOnline}
          exigirEndereco={!!entregaDoCadastro && pecaViaja(entregaDoCadastro)}
          onClose={() => { setShowCustomer(false); setExigirDadosOnline(false); }}
          onSave={saveCustomer}
        />
      )}

      {/* ── MOTIVO DO CANCELAMENTO (11/08) ──
          4 botões grandes em vez de texto livre. O motivo entra no
          cancel_reason e vira relatório: dá pra separar desistência da
          cliente (normal no provador) de erro nosso (que a gente conserta). */}
      {showCancelReason && sale && (
        <div
          className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4"
          onClick={() => setShowCancelReason(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-black text-slate-800">Cancelar esta venda</h3>
            <p className="text-sm text-slate-500 mt-0.5 mb-4">
              {(sale.items || []).length} peça(s) · R$ {Number(sale.total || 0).toFixed(2)} — por que
              não foi pra frente?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[
                { m: 'cliente desistiu', desc: 'provou e não levou' },
                { m: 'errei a venda', desc: 'peça/preço errado' },
                { m: 'trocou o pagamento', desc: 'vai refazer de outro jeito' },
                { m: 'cliente volta depois', desc: 'vai pensar / buscar dinheiro' },
              ].map((o) => (
                <button
                  key={o.m}
                  type="button"
                  onClick={() => confirmarCancelamento(o.m)}
                  className="text-left px-4 py-3 rounded-xl border-2 border-slate-200 hover:border-rose-300 hover:bg-rose-50 transition"
                >
                  <span className="block text-sm font-bold text-slate-800 capitalize">{o.m}</span>
                  <span className="block text-[11px] text-slate-500">{o.desc}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowCancelReason(false)}
              className="mt-4 w-full px-4 py-2.5 rounded-xl border-2 border-slate-200 text-slate-600 text-sm font-bold hover:bg-slate-50"
            >
              Voltar — não cancelar
            </button>
          </div>
        </div>
      )}

      {/* Modal Vendedora */}
      {showConfirmSale && sale && (
        <ConfirmSaleModal
          sale={sale}
          storeCode={sale.storeCode}
          onCancel={() => {
            // Cancelou → descarta finalize pendente (evita finalize "fantasma"
            // disparar numa escolha de vendedora futura). Volta pro pagamento.
            pendingFinalizeRef.current = null;
            setShowConfirmSale(false);
          }}
          onConfirm={saveVendedora}
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
          hasSeller={!!sale.sellerName}
          onNeedSeller={() => setShowConfirmSale(true)}
          clienteOnline={clienteOnline}
          onNeedCustomer={abrirCadastroOnline}
          stores={stores}
        />
      )}

      {showStoreSummary && storeCode && (
        <StoreSummaryModal
          storeCode={storeCode}
          storeName={sale?.storeName || stores.find((store) => store.code === storeCode)?.name || storeCode}
          onClose={() => setShowStoreSummary(false)}
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
          {...overlayClose(() => setShowOnlinePending(false))}
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
                              <span className="bg-emerald-600 text-white text-[10px] font-black px-2 py-0.5 rounded">
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
                                const msg = String(e?.message || '');
                                if (/cadastro completo/i.test(msg)) {
                                  toast(
                                    'warning',
                                    `Venda #${p.saleCode} — cadastro incompleto`,
                                    `${msg} Retome a venda em "Pausadas" e complete antes de finalizar.`,
                                  );
                                } else {
                                  toast(
                                    'error',
                                    'Erro ao finalizar venda',
                                    msg || 'Tente reabrir manualmente.',
                                  );
                                }
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
            setTimeout(() => scanBarRef.current?.focus(), 50);
          }}
        />
      )}

      {/* Modal Vale Presente — vende um vale (código VP- no cupom) */}
      {showGiftVoucher && sale && (
        <GiftVoucherModal
          saleId={sale.id}
          onClose={() => setShowGiftVoucher(false)}
          onAdded={async (code) => {
            const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
            setSale(fresh);
            setShowGiftVoucher(false);
            toast('success', `Vale presente ${code} no carrinho`, 'O código sai impresso no cupom — ele ATIVA quando a venda finalizar');
            setTimeout(() => scanBarRef.current?.focus(), 50);
          }}
        />
      )}

      {/* Modal Simulador de Parcelamento Cartão */}
      {/* BUG FIX: em TROCA (vale-troca aplicado) ou pagamento parcial, simula
          sobre o que FALTA pagar — não sobre o total bruto do carrinho. Cliente
          com vale de R$ 269,90 num carrinho de R$ 539,80 parcela só R$ 269,90. */}
      {showSimular && sale && (() => {
        const restante = restanteVenda(sale);
        if (restante <= 0) return null;
        return (
          <SimularParcelasModal
            total={restante}
            temAbatimento={restante < (sale.total || 0) - 0.01}
            onClose={() => setShowSimular(false)}
          />
        );
      })()}

      {showCarrinhos && (
        <CarrinhosAbandonadosModal
          onClose={() => setShowCarrinhos(false)}
          onImportado={(saleId) => {
            // Venda montada pelo backend: grava a chave que o PDV usa pra
            // retomar e recarrega. Não navega pra fora — ela já está na tela
            // certa, é só a venda aparecer.
            try { localStorage.setItem(`lurds_pdv_sale_${storeCode}`, saleId); } catch {}
            window.location.reload();
          }}
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
      <PromoCheckModal open={promoCheckOpen} onClose={() => setPromoCheckOpen(false)} />
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// VendedoraModal — busca funcionária na tabela `funcionarios` do Giga.
// Aparece ao clicar no botão "Vendedora" do header (e idealmente automático
// ao abrir venda nova). Necessário pra atribuir comissão.
// ─────────────────────────────────────────────────────────────────────────
function ConfirmSaleModal({
  sale,
  storeCode,
  onCancel,
  onConfirm,
}: {
  sale: Sale;
  storeCode?: string;
  onCancel: () => void;
  onConfirm: (d: { codigo: string; nome: string }) => void;
}) {
  // Animação de abertura (fade + zoom)
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Vendedora selecionada no popup (pré-seleciona se a venda já tiver uma).
  const [selected, setSelected] = useState<{ codigo: string; nome: string } | null>(
    sale.sellerName ? { codigo: sale.sellerId || '', nome: sale.sellerName } : null,
  );

  // Resumo da venda (lê do `sale`, nada é calculado aqui)
  const qtdPecas = (sale.items || []).reduce((s, i) => s + (i.qty || 0), 0);
  const formasPgto = sale.payments || [];
  const pgtoLabel = (m: string) =>
    PAYMENT_METHODS.find((p) => p.id === m)?.label ||
    String(m || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const [searchTerm, setSearchTerm] = useState('');
  // apelido: definido no cadastro da funcionária (retaguarda/vendedoras) —
  // é o que aparece e o que fica gravado na venda como nome da vendedora
  const [results, setResults] = useState<Array<{ codigo: string; nome: string; apelido?: string | null; loja?: string }>>([]);
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
        const ativas = await api<Array<{ codigo: string; nome: string; apelido?: string | null }>>(
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
      return whitelist.filter((f) =>
        f.nome.toLowerCase().includes(term) || (f.apelido || '').toLowerCase().includes(term),
      );
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
      if (pick) setSelected({ codigo: pick.codigo, nome: pick.apelido || pick.nome });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-3 sm:p-4">
      <div
        className={`bg-white rounded-2xl shadow-2xl w-[min(96vw,560px)] max-h-[94vh] flex flex-col overflow-hidden transition-all duration-200 ease-out ${
          mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Cabeçalho */}
        <div className="px-5 pt-5 pb-3 shrink-0">
          <h2 className="text-lg font-extrabold tracking-tight text-slate-900 text-center">CONFIRMAR VENDA</h2>

          {/* Resumo da venda */}
          <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 text-sm space-y-1.5">
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">Cliente</span>
              <span className="font-semibold text-slate-800 text-right truncate">{sale.customerName || 'Não identificado'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">Itens</span>
              <span className="font-semibold text-slate-800">{qtdPecas} {qtdPecas === 1 ? 'peça' : 'peças'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">Pagamento</span>
              <span className="font-semibold text-slate-800 text-right">
                {formasPgto.length > 0
                  ? formasPgto.map((p) => pgtoLabel(p.method)).join(' + ')
                  : '—'}
              </span>
            </div>
            {sale.desconto > 0 && (
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Desconto</span>
                <span className="font-semibold text-rose-600">− {brl(sale.desconto)}</span>
              </div>
            )}
            <div className="flex justify-between gap-3 pt-1.5 mt-1.5 border-t border-slate-200">
              <span className="text-slate-600 font-bold">TOTAL</span>
              <span className="font-extrabold text-emerald-700 text-base">{brl(sale.total)}</span>
            </div>
          </div>

          {/* Destaque: quem vendeu */}
          <div className="mt-4 text-center">
            <p className="text-base font-bold text-slate-900">Quem realizou esta venda?</p>
            <p className="text-xs text-slate-500">Selecione a vendedora responsável antes de concluir.</p>
          </div>

          {/* Busca (aparece se houver muitas vendedoras) */}
          <div className="mt-3 flex items-center gap-2 border-2 border-slate-200 bg-white rounded-xl px-3 py-2.5 focus-within:border-[#D4AF37]">
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Buscar vendedora pelo nome…"
              className="flex-1 bg-transparent text-sm focus:outline-none"
              autoFocus
              autoComplete="off"
            />
            {searching && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
          </div>
        </div>

        {/* Cartões grandes de vendedora */}
        <div className="px-5 pb-2 flex-1 overflow-y-auto">
          {visibleResults.length === 0 && !searching && (
            <div className="text-center text-sm text-slate-400 py-8">
              {searchTerm ? 'Nenhuma vendedora encontrada' : 'Carregando…'}
            </div>
          )}
          {visibleResults.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {visibleResults.map((f, idx) => {
                // APELIDO do cadastro vence; senão primeiro nome
                const rotulo = (f as any).apelido || f.nome.split(/\s+/)[0];
                const nomeEscolhido = (f as any).apelido || f.nome;
                const isSel = selected?.codigo === f.codigo && selected?.nome === nomeEscolhido;
                return (
                  <button
                    key={f.codigo + f.nome}
                    type="button"
                    data-vendedora-idx={idx}
                    onClick={() => setSelected({ codigo: f.codigo, nome: nomeEscolhido })}
                    title={f.nome}
                    className={`relative flex flex-col items-center justify-center gap-2 rounded-2xl border-2 p-4 min-h-[112px] transition active:scale-[0.97] ${
                      isSel
                        ? 'border-[#D4AF37] bg-[#FFFBEB] ring-2 ring-[#D4AF37] shadow'
                        : 'border-slate-200 bg-white hover:border-[#D4AF37]/60 hover:bg-amber-50/40'
                    }`}
                  >
                    {isSel && (
                      <span className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-[#D4AF37] text-white grid place-items-center shadow">
                        <Check className="w-4 h-4" strokeWidth={3} />
                      </span>
                    )}
                    <span className={`w-12 h-12 rounded-full grid place-items-center ${
                      isSel ? 'bg-[#D4AF37]/15 text-[#9A7B16]' : 'bg-slate-100 text-slate-500'
                    }`}>
                      <User className="w-7 h-7" />
                    </span>
                    <span className={`text-[13px] font-bold text-center leading-tight line-clamp-2 ${
                      isSel ? 'text-[#7A5E0E]' : 'text-slate-700'
                    }`} title={f.nome}>
                      {rotulo}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Rodapé */}
        <div className="px-5 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-5 py-3.5 rounded-xl font-bold text-slate-600 bg-white border border-slate-300 hover:bg-slate-100 active:scale-[0.98]"
          >
            CANCELAR
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && onConfirm(selected)}
            className={`flex-1 px-5 py-3.5 rounded-xl font-extrabold text-white transition active:scale-[0.98] flex items-center justify-center gap-2 ${
              selected
                ? 'bg-emerald-600 hover:bg-emerald-700 shadow-lg'
                : 'bg-slate-300 cursor-not-allowed'
            }`}
          >
            <Check className="w-5 h-5" /> FINALIZAR VENDA
          </button>
        </div>
      </div>
    </div>
  );
}

function CustomerModal({
  initial,
  exigirCompleto = false,
  exigirEndereco = false,
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
  /**
   * VENDA ONLINE (dono 18/08): contato obrigatório — nome e sobrenome, CPF
   * válido, WhatsApp e e-mail. Sem isso a venda vira pedido sem destinatário
   * de verdade: etiqueta sai "Cliente" e ninguém consegue avisar a cliente.
   * No balcão fica tudo opcional, como sempre foi.
   */
  exigirCompleto?: boolean;
  /**
   * A PEÇA VIAJA nesta venda (SEDEX/PAC/MOTOBOY) → endereço obrigatório
   * também. Em RETIRADA EM LOJA fica `false`: a cliente busca no balcão e
   * não quer passar endereço só pra fechar (dono 18/08). Também `false`
   * enquanto a forma de entrega não foi escolhida — aí o endereço aparece
   * como opcional, e vira obrigatório assim que ela declarar SEDEX/PAC/
   * MOTOBOY no modal de pagamento.
   */
  exigirEndereco?: boolean;
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
  /**
   * Vermelho, asterisco e "Falta:" no bloco de endereço só quando ele é
   * cobrado — ou seja, quando a peça VIAJA. Na retirada em loja o bloco
   * continua na tela (a vendedora pode preencher se quiser), mas não trava
   * nada.
   */
  const obrigaEndereco = exigirCompleto && exigirEndereco;
  // Já aberto quando o endereço é cobrado (a peça viaja) ou quando a cliente
  // já tem endereço no cadastro. Na RETIRADA fica fechado: é justamente o
  // bloco que a cliente não quer preencher.
  const [showEndereco, setShowEndereco] = useState(
    obrigaEndereco || !!(initial.cep || initial.endereco || initial.cidade),
  );
  const [cepLoading, setCepLoading] = useState(false);
  const [cepError, setCepError] = useState<string | null>(null);

  // ── O QUE AINDA FALTA (só cobra em venda online) ──────────────────────
  // Mesma régua do backend (`common/dados-cliente-online.ts`): a tela mostra
  // campo a campo o que está de pé e o servidor recusa o pagamento com a
  // MESMA lista. Régua diferente entre quem mostra e quem cobra é como nasce
  // o "preenchi tudo e não deixa fechar".
  const campos = {
    cpf, name, email, phone, cep, endereco, numero, bairro, cidade, uf,
    // RETIRADA (ou entrega ainda não escolhida) não cobra endereço — a régua
    // é a MESMA do servidor, que decide pelo `entregaTipo` da venda.
    entregaTipo: exigirEndereco ? 'sedex' : 'retirada',
  };
  const okCampo = checarDadosClienteOnline(campos);
  const faltaOnline = exigirCompleto ? faltandoDadosClienteOnline(campos) : [];
  // Vermelho só depois de tentar salvar OU quando o campo já tem coisa
  // digitada — abrir o modal com tudo pintado de erro é ruído.
  const [tentouSalvar, setTentouSalvar] = useState(false);
  const errado = (ok: boolean, valor: string) =>
    exigirCompleto && !ok && (tentouSalvar || !!String(valor || '').trim());
  // Endereço na RETIRADA não pinta de vermelho nem trava — não é cobrado.
  const erradoEndereco = (ok: boolean, valor: string) =>
    obrigaEndereco && errado(ok, valor);
  const clsEndereco = (ok: boolean, valor: string, base: string) =>
    `${base} ${erradoEndereco(ok, valor) ? 'border-rose-400 bg-rose-50' : ''}`;
  const cls = (ok: boolean, valor: string, base: string) =>
    `${base} ${errado(ok, valor) ? 'border-rose-400 bg-rose-50' : ''}`;

  // ── FOCO NA BUSCA AO ABRIR ────────────────────────────────────────────
  // A vendedora abre o modal e já digita o CPF, sem clicar. Vai na BUSCA e não
  // no campo CPF de baixo de propósito: buscar ACHA a cliente que já existe
  // (trazendo cashback, endereço e histórico), enquanto o campo de baixo só
  // preenche a venda — e digitar ali uma cliente que já existe é como nasce
  // cadastro duplicado.
  //
  // `autoFocus` sozinho é instável em modal que entra com animação: o navegador
  // foca antes de o elemento estar posicionado e o teclado do PDV às vezes
  // perde. O timer curto espera a montagem terminar.
  const buscaRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => buscaRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, []);

  // ── O QUE JÁ SE SABE DA CLIENTE ───────────────────────────────────────
  // Assim que o CPF fica completo, busca a ficha dela e preenche e-mail e
  // endereço. O CPF é a pessoa: se ela já comprou em QUALQUER loja ou no site,
  // o dado existe e não faz sentido pedir de novo.
  //
  // Sem isto o cadastro único guardava o endereço e nunca devolvia: a
  // atendente digitava, salvava certo, e na venda seguinte a tela vinha em
  // branco porque só lia da VENDA — e venda nova nasce vazia. Foi o "não
  // salvou" relatado três vezes.
  //
  // NUNCA sobrescreve o que a atendente já digitou: só preenche campo vazio.
  const [buscandoFicha, setBuscandoFicha] = useState(false);
  const cpfDigitos = cpf.replace(/\D/g, '');
  useEffect(() => {
    if (cpfDigitos.length !== 11) return;
    let cancelado = false;
    setBuscandoFicha(true);
    api<any>(`/pdv/customer-resume?cpf=${cpfDigitos}`)
      .then((r) => {
        if (cancelado || !r?.found) return;
        const c = r.customer || {};
        // NOME também (17/08 — pedido ON-000009 saiu "Cliente" na etiqueta).
        // O painel VIP mostrava o nome, o endereço vinha inteiro, e o campo
        // Nome ficava vazio: a atendente via tudo preenchido, salvava, e a
        // venda ia sem nome — Order, etiqueta, push e NF-e herdam "Cliente".
        if (!name && c.name) setName(c.name);
        if (!email && c.email) setEmail(c.email);
        if (!phone && c.whatsapp) setPhone(c.whatsapp);
        const e = c.endereco;
        if (!e) return;
        if (!cep && e.cep) setCep(e.cep);
        if (!endereco && e.logradouro) setEndereco(e.logradouro);
        if (!numero && e.numero) setNumero(e.numero);
        if (!complemento && e.complemento) setComplemento(e.complemento);
        if (!bairro && e.bairro) setBairro(e.bairro);
        if (!cidade && e.cidade) setCidade(e.cidade);
        if (!uf && e.uf) setUf(e.uf);
        // Abre a seção pra atendente VER que já veio preenchido — senão ela
        // acha que está vazio e digita tudo de novo.
        if (e.cep || e.logradouro || e.cidade) setShowEndereco(true);
      })
      .catch(() => { /* silencioso: é conveniência, não pode atrapalhar a venda */ })
      .finally(() => { if (!cancelado) setBuscandoFicha(false); });
    return () => { cancelado = true; };
  }, [cpfDigitos]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // Escopo por loja: só clientes DESTA loja (RESERVAS etc repetem por loja)
        let lojaParam = '';
        try {
          const lj = localStorage.getItem('lurds_pdv_store') || '';
          if (lj) lojaParam = `&loja=${encodeURIComponent(lj)}`;
        } catch { /* backend usa a loja do token */ }
        const r = await api<{ results: typeof results }>(`/pdv/customer-search?q=${encodeURIComponent(term)}&limit=20${lojaParam}`);
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
    // VENDA ONLINE: clicar no resultado PREENCHE, não salva. Salvar aqui
    // fechava o modal com nome+telefone só — e o resto (e-mail, endereço)
    // continuava faltando, agora com a tela fechada. Preenchido, o CPF ainda
    // dispara a busca da ficha e traz e-mail e endereço do CRM.
    if (exigirCompleto) {
      if (c.cpf) setCpf(c.cpf);
      if (c.nome) setName(c.nome);
      if (c.telefone) setPhone(c.telefone);
      setSearchTerm('');
      setShowResults(false);
      return;
    }
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
      className="fixed inset-0 bg-black/60 z-[65] flex items-end sm:items-center justify-center p-4"
      onMouseDown={backdropClose.onMouseDown}
      onClick={backdropClose.onClick}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-lg w-full max-w-md p-4 space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <User className="w-4 h-4" /> Identificar cliente
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        {/* VENDA ONLINE — o que ainda falta. A peça vai VIAJAR: sem cadastro
            completo a etiqueta sai "Cliente", o pedido sem CEP nem vira Order
            e ninguém consegue avisar a cliente. */}
        {exigirCompleto && (
          <div
            className={`rounded-lg border-2 p-2.5 text-xs ${
              faltaOnline.length
                ? 'border-rose-300 bg-rose-50 text-rose-900'
                : 'border-emerald-300 bg-emerald-50 text-emerald-900'
            }`}
          >
            <div className="font-black flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              {faltaOnline.length ? 'Venda online — cadastro incompleto' : 'Venda online — cadastro completo ✓'}
            </div>
            {faltaOnline.length > 0 && (
              <div className="mt-1 leading-snug">
                {obrigaEndereco ? (
                  <>A peça vai pelo correio: precisa de <b>tudo</b>. Falta </>
                ) : (
                  <>Falta </>
                )}
                <b>{faltaOnline.join(', ')}</b>.
              </div>
            )}
            {exigirCompleto && !exigirEndereco && (
              <div className="mt-1 leading-snug opacity-80">
                Retirada em loja: <b>endereço não é preciso</b>.
              </div>
            )}
          </div>
        )}

        {/* TYPEAHEAD — busca rápida por CPF ou nome (puxa do Giga) */}
        <div className="relative">
          <div className="flex items-center gap-2 border-2 border-violet-300 bg-violet-50 rounded px-2 py-2 focus-within:border-violet-500">
            <Search className="w-4 h-4 text-violet-600 shrink-0" />
            <input
              ref={buscaRef}
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

              {/* ORIGEM — cliente de outro canal: avisa e NÃO recadastra.
                  Os números abaixo já são a PESSOA inteira (soma de todos os
                  cadastros dela: lojas físicas + site). */}
              {c.origem && !c.origem.daLojaAtual && (
                <div className="bg-sky-100 border-2 border-sky-400 rounded-lg px-2 py-1.5 text-[11px] font-bold text-sky-900">
                  {c.origem.source === 'woo'
                    ? '🌐 Cliente do SITE'
                    : `🏬 Cliente da loja ${c.origem.storeName || c.origem.storeCode || '—'}`}
                  {' '}— cadastro único da rede, não recadastre
                </div>
              )}
              {Array.isArray(c.cadastrosEm) && c.cadastrosEm.length > 1 && (
                <div className="text-[10px] text-slate-500">
                  Cadastros em: {c.cadastrosEm.join(' · ')}
                </div>
              )}

              {/* Métricas */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 text-center">
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
            placeholder={exigirCompleto ? 'CPF *' : 'CPF'}
            className={cls(okCampo.cpf, cpf, 'w-full border rounded px-3 py-2 text-sm')}
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={exigirCompleto ? 'Nome e sobrenome *' : 'Nome'}
            className={cls(okCampo.name, name, 'w-full border rounded px-3 py-2 text-sm')}
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={exigirCompleto ? 'E-mail *' : 'E-mail (pra mandar nota)'}
            className={cls(okCampo.email, email, 'w-full border rounded px-3 py-2 text-sm')}
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={exigirCompleto ? 'WhatsApp com DDD *' : 'WhatsApp'}
            className={cls(okCampo.phone, phone, 'w-full border rounded px-3 py-2 text-sm')}
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
              <div
                className={`rounded p-2 text-[11px] border ${
                  obrigaEndereco
                    ? 'bg-rose-50 border-rose-200 text-rose-800'
                    : 'bg-cyan-50 border-cyan-200 text-cyan-800'
                }`}
              >
                {obrigaEndereco ? (
                  <>Endereço <b>completo é obrigatório</b> nesta venda — é pra onde a peça vai.</>
                ) : exigirCompleto ? (
                  <>
                    <b>Retirada em loja não precisa de endereço</b> — a cliente busca no
                    balcão. Preencha só se ela quiser deixar registrado.
                  </>
                ) : (
                  <>Obrigatório pra <b>Venda Online</b> (vai pelo correio). Opcional no balcão.</>
                )}
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
                    placeholder={obrigaEndereco ? 'CEP (só números) *' : 'CEP (só números)'}
                    maxLength={8}
                    inputMode="numeric"
                    className={clsEndereco(okCampo.cep, cep, 'w-full border rounded px-3 py-2 text-sm font-mono')}
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
                placeholder={obrigaEndereco ? 'Logradouro (rua/avenida) *' : 'Logradouro (rua/avenida)'}
                className={clsEndereco(okCampo.endereco, endereco, 'w-full border rounded px-3 py-2 text-sm')}
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  value={numero}
                  onChange={(e) => setNumero(e.target.value)}
                  placeholder={obrigaEndereco ? 'Nº *' : 'Nº'}
                  className={clsEndereco(okCampo.numero, numero, 'border rounded px-3 py-2 text-sm')}
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
                placeholder={obrigaEndereco ? 'Bairro *' : 'Bairro'}
                className={clsEndereco(okCampo.bairro, bairro, 'w-full border rounded px-3 py-2 text-sm')}
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  value={cidade}
                  onChange={(e) => setCidade(e.target.value)}
                  placeholder={obrigaEndereco ? 'Cidade *' : 'Cidade'}
                  className={clsEndereco(okCampo.cidade, cidade, 'col-span-2 border rounded px-3 py-2 text-sm')}
                />
                <input
                  value={uf}
                  onChange={(e) => setUf(e.target.value.toUpperCase().slice(0, 2))}
                  placeholder={obrigaEndereco ? 'UF *' : 'UF'}
                  maxLength={2}
                  className={clsEndereco(okCampo.uf, uf, 'border rounded px-3 py-2 text-sm font-mono uppercase')}
                />
              </div>
            </div>
          )}
        </div>

        {/* Em venda online o Salvar não passa incompleto: o que a vendedora
            digitou fica na tela (nada se perde) e a lista acima diz o que
            falta. Deixar salvar pela metade só empurra o erro pro fim — com a
            cobrança já mandada pra cliente. */}
        <button
          onClick={() => {
            if (exigirCompleto && faltaOnline.length) {
              setTentouSalvar(true);
              setShowEndereco(true);
              return;
            }
            onSave({
              cpf, name, email, phone,
              cep, endereco, numero, complemento, bairro, cidade, uf,
            });
          }}
          className={`w-full px-3 py-2 text-white font-bold rounded ${
            exigirCompleto && faltaOnline.length
              ? 'bg-slate-400 hover:bg-slate-500'
              : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
        >
          {exigirCompleto && faltaOnline.length ? `Falta: ${faltaOnline.join(', ')}` : 'Salvar'}
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
  hasSeller,
  onNeedSeller,
  clienteOnline,
  onNeedCustomer,
  stores = [],
}: {
  saleId: string;
  total: number;
  storeCode?: string;
  /** Lojas ativas — seletor "quem atende" da retirada/motoboy na venda online. */
  stores?: Array<{ code: string; name: string }>;
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
  /** Venda já tem vendedora gravada? (venda online exige escolher ANTES) */
  hasSeller?: boolean;
  /** Abre o popup de escolher vendedora no parent (sem finalizar) */
  onNeedSeller?: () => void;
  /**
   * VENDA ONLINE — cadastro da cliente que está na venda (dono 18/08). O que
   * FALTA é calculado aqui dentro, e não no parent, porque depende da forma
   * de entrega escolhida NESTE modal: RETIRADA EM LOJA não pede endereço.
   * Calcular no parent devolveria a lista da venda como ela estava no banco —
   * a vendedora clicaria em RETIRADA e a tela continuaria pedindo o CEP até o
   * refetch chegar.
   */
  clienteOnline?: DadosClienteOnline;
  /**
   * Abre o cadastro da cliente no parent, em modo "obrigatório". Recebe a
   * forma de entrega VIVA pro cadastro saber se cobra endereço.
   */
  onNeedCustomer?: (entregaTipo?: string | null) => void;
}) {
  const { toast } = usePdvToast();
  // Lista de pagamentos parciais já adicionados
  const [payments, setPayments] = useState(initialPayments || []);
  // SINCRONIZA com o servidor ao abrir (29/07): o modal confiava só no
  // initialPayments do parent — se um pagamento já tinha sido registrado e o
  // modal reabria (ex.: frete aplicado depois do link), o front recobrava o
  // TOTAL e a loja travava com 400 "maior que o restante".
  useEffect(() => {
    (async () => {
      try {
        const s = await api<any>(`/pdv/sales/${saleId}`);
        if (Array.isArray(s?.payments)) setPayments(s.payments);
        // Entrega já gravada (modal reaberto, PIX pendente, F5): mostra o que
        // está no banco em vez de obrigar a clicar de novo — e evita a tela
        // dizer "escolha a entrega" com a entrega já escolhida.
        if (s?.entregaTipo) {
          setEntregaTipo(s.entregaTipo);
          setEntregaStoreCode(s.entregaStoreCode || '');
        }
      } catch { /* sem rede: mantém o estado local */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId]);
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

  // ── CONVÊNIO (sindicato) ── a forma só aparece se a loja tem convênio ativo.
  // Associado vem da lista que o sindicato mandou (sem ficha de cliente).
  const [convenioAtivo, setConvenioAtivo] = useState<{ id: string; nome: string } | null>(null);
  const [convBusca, setConvBusca] = useState('');
  const [convResultados, setConvResultados] = useState<any[]>([]);
  const [convMembro, setConvMembro] = useState<any | null>(null);
  useEffect(() => {
    if (!storeCode) return;
    api<any>(`/pdv/convenio/ativo?storeCode=${encodeURIComponent(storeCode)}`)
      .then((c) => setConvenioAtivo(c && c.id ? c : null))
      .catch(() => setConvenioAtivo(null));
  }, [storeCode]);
  useEffect(() => {
    if (!convenioAtivo || selected !== 'convenio') return;
    const t = setTimeout(() => {
      api<any[]>(`/pdv/convenio/${convenioAtivo.id}/membros?q=${encodeURIComponent(convBusca)}`)
        .then((r) => setConvResultados(Array.isArray(r) ? r : []))
        .catch(() => setConvResultados([]));
    }, 300);
    return () => clearTimeout(t);
  }, [convBusca, convenioAtivo, selected]);

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
  // Cópia 1-clique da ficha de outra loja (banner "cliente é de outra loja")
  const [copiandoFicha, setCopiandoFicha] = useState(false);
  // FRETE à parte (venda online) — vira linha própria na venda
  const [freteStr, setFreteStr] = useState('');
  const [aplicandoFrete, setAplicandoFrete] = useState(false);
  // COMO A PEÇA SAI (14/08) — SEDEX / PAC / MOTOBOY / RETIRADA EM LOJA.
  // Sem isso o pedido online nascia "Correios R$ 0,00" e a matriz não sabia
  // se emitia etiqueta, chamava motoboy ou segurava a peça pra retirada.
  const [entregaTipo, setEntregaTipo] = useState<'sedex' | 'pac' | 'motoboy' | 'retirada' | null>(null);
  // LOJA QUE ATENDE (17/08) — só pra retirada (onde a cliente busca) e motoboy
  // (quem sai de moto). '' = esta loja. A loja-canal SITE fecha venda pra
  // cliente de qualquer cidade: quem atende quase nunca é quem vendeu.
  const [entregaStoreCode, setEntregaStoreCode] = useState<string>('');
  /**
   * A escolha VIVA da vendedora, ou a que já está gravada na venda enquanto o
   * `useEffect` de cima não trouxe o estado do servidor. Sem esse fallback o
   * modal abria uma venda JÁ marcada como retirada gritando "falta CEP" por
   * uma fração de segundo — e a vendedora ia atrás do endereço.
   */
  const entregaEfetiva = entregaTipo ?? clienteOnline?.entregaTipo ?? null;
  /**
   * O QUE FALTA NO CADASTRO — com a forma de entrega VIVA (a que a vendedora
   * acabou de clicar), não a que está no banco. Régua igual à do servidor
   * (`backend/src/common/dados-cliente-online.ts`): contato sempre, endereço
   * só quando a peça VIAJA. Vazio = pode gerar cobrança e fechar.
   */
  const dadosOnlineFaltando = useMemo(
    () => faltandoDadosClienteOnline({ ...(clienteOnline || {}), entregaTipo: entregaEfetiva }),
    [clienteOnline, entregaEfetiva],
  );
  /**
   * Só o endereço está segurando a venda? Então clicar em RETIRA NA LOJA
   * resolve sozinho — o aviso conta isso em vez de mandar a vendedora pedir
   * um CEP que a cliente não quer dar.
   */
  const soFaltaEndereco = useMemo(
    () => faltandoDadosBasicosClienteOnline(clienteOnline || {}).length === 0,
    [clienteOnline],
  );
  // Info do cliente vinda do Giga + pendências (pra banner de inadimplência)
  const [credCustomerInfo, setCredCustomerInfo] = useState<{
    found: boolean;
    cliente?: { codCliente: string; nome: string | null; cpf: string; viaFallback?: 'telefone' | 'nome' | null };
    pendencias?: Array<{ vencimento: string; valor: number; diasAtraso: number }>;
    totalDevido?: number;
    totalAtraso?: number;
    qtdPendencias?: number;
    qtdAtrasadas?: number;
    message?: string;
    /** true = falha de CONEXÃO com o Giga (não significa que o cliente não existe) */
    gigaError?: boolean;
    /** Cliente tem cadastro em OUTRA(S) loja(s), mas não na loja da venda */
    outraLoja?: { lojas: string[]; codCliente: string; nome: string | null };
  } | null>(null);
  const [credLoading, setCredLoading] = useState(false);
  // Contador pra forçar re-busca (botão "Tentar de novo" quando Giga falhou)
  const [credRefresh, setCredRefresh] = useState(0);

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
        // storeCode: escopo por loja — código de cliente do Wincred se repete
        // entre lojas (crediário é separado por loja). Admin/impersonate usa
        // a loja da venda; vendedora o backend já resolve pelo JWT.
        // nome/telefone: fallback quando o cadastro do Wincred está sem CPF.
        const qs = [
          `cpf=${encodeURIComponent(customerCpf)}`,
          storeCode ? `storeCode=${encodeURIComponent(storeCode)}` : '',
          customerName ? `nome=${encodeURIComponent(customerName)}` : '',
          customerPhone ? `telefone=${encodeURIComponent(customerPhone)}` : '',
        ].filter(Boolean).join('&');
        const r = await api<any>(`/pdv/customer-info?${qs}`);
        if (!cancelled) setCredCustomerInfo(r);
      } catch (e: any) {
        if (!cancelled) setCredCustomerInfo({ found: false, message: e?.message || 'Erro ao buscar cliente' });
      } finally {
        if (!cancelled) setCredLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, customerCpf, credRefresh]);

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
  // Config de PIX da loja. 'externo' = franquia SEM gateway (ex.: sem chave
  // Pagar.me): o PIX vira só "informar pagamento" — finaliza direto como
  // dinheiro/cartão, sem gerar QR nem esperar webhook. `pixProviderReady`
  // evita a corrida do auto-gerar (não dispara QR antes de saber que é externo).
  const [storePixProvider, setStorePixProvider] =
    useState<'auto' | 'pagbank' | 'pagarme' | 'externo'>('auto');
  const [pixProviderReady, setPixProviderReady] = useState(false);
  const pixExterno = storePixProvider === 'externo';
  useEffect(() => {
    if (!storeCode) { setPixProviderReady(true); return; }
    let alive = true;
    (async () => {
      try {
        const cfg = await api<{ provider: 'auto' | 'pagbank' | 'pagarme' | 'externo' }>(
          `/stores/by-code/${storeCode}/pix-provider`,
        );
        if (alive && cfg?.provider) setStorePixProvider(cfg.provider);
      } catch { /* mantém 'auto' */ }
      finally { if (alive) setPixProviderReady(true); }
    })();
    return () => { alive = false; };
  }, [storeCode]);
  const [copyMsg, setCopyMsg] = useState(false);
  // Valor com que o QR ATUAL foi gerado — base da regeneração automática
  // quando a vendedora altera o campo "Quanto cobrar com PIX?".
  const pixQrValorRef = useRef<number | null>(null);

  // VENDA ONLINE — sub-tipo (PIX direto ou Link externo). Vendedora informa
  // só pra ter no histórico. Sem geração de cobrança, sem NFC-e automática.
  const [vendaOnlineTipo, setVendaOnlineTipo] =
    useState<'pix' | 'link' | 'pagarme_link' | 'pix_gerar' | null>(null);

  /**
   * GERAR PIX NA VENDA ONLINE (dono 07/08) — PagBank.
   *
   * "PIX direto" sempre foi REGISTRO de venda já paga ("sem gerar cobrança",
   * diz o próprio aviso da tela). Faltava o caso mais comum do WhatsApp: a
   * cliente fechou, e a vendedora precisa MANDAR o código pra ela pagar.
   * Este botão gera a cobrança de verdade e devolve o copia-e-cola.
   *
   * Provider: PagBank, por decisão do dono. Sem fallback silencioso pro
   * Pagar.me — se o PagBank não responder, a vendedora precisa SABER, não
   * receber um QR de outro gateway sem perceber.
   */
  const [pixOnline, setPixOnline] = useState<{
    txid: string;
    payload: string;
    qrCodeDataUrl: string;
    expiresAt: string;
    valor: number;
  } | null>(null);
  const [pixOnlineLoading, setPixOnlineLoading] = useState(false);
  const [pixOnlineCopiado, setPixOnlineCopiado] = useState(false);
  const [pixOnlineErro, setPixOnlineErro] = useState<string | null>(null);
  const [pixOnlinePago, setPixOnlinePago] = useState(false);

  /**
   * O PIX MANDADO PRA CLIENTE PRECISA AVISAR QUE CAIU (12/08/2026).
   *
   * O painel prometia "a venda confirma sozinha quando ela pagar" e não
   * mostrava nada quando isso acontecia: a vendedora mandava o código e ficava
   * olhando pra tela parada, sem saber se o dinheiro entrou. Foi assim que
   * Sorocaba abriu chamado com a cliente já tendo mandado o comprovante.
   *
   * Poll leve (4s) só no status LOCAL — quem pergunta pro PagBank é o
   * reconciliador no servidor. Nada de bater no gateway pelo navegador: foi
   * exatamente esse padrão que derrubou a live de 01/07.
   */
  useEffect(() => {
    if (!pixOnline || pixOnlinePago || !saleId) return;
    let cancelado = false;
    let emVoo = false;
    const tick = async () => {
      if (emVoo) return;
      emVoo = true;
      try {
        const r = await api<{ status: string }>(`/pagbank/pix/status/${saleId}`);
        if (!cancelado && r?.status === 'paid') {
          setPixOnlinePago(true);
          toast('success', 'PIX recebido!', 'O pagamento caiu. Pode finalizar a venda.');
        }
      } catch {
        // silencioso — poll tolerante
      } finally {
        emVoo = false;
      }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => { cancelado = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixOnline, pixOnlinePago, saleId]);

  const gerarPixOnline = async () => {
    if (pixOnlineLoading || !saleId) return;
    // Cadastro completo ANTES da cobrança: PIX pago com cadastro pela metade
    // vira dinheiro na conta e venda que não fecha.
    if (dadosOnlineFaltando.length) {
      toast(
        'warning',
        'Complete o cadastro antes de mandar o PIX',
        `Falta: ${dadosOnlineFaltando.join(', ')}.`,
      );
      onNeedCustomer?.(entregaEfetiva);
      return;
    }
    setPixOnlineLoading(true);
    setPixOnlineErro(null);
    setPixOnlinePago(false);
    try {
      const pb = await api<{
        pagbankOrderId: string;
        qrCodeText: string;
        qrCodeImageB64: string;
        expiresAt: string;
        valor: number;
      }>('/pagbank/pix/create', {
        method: 'POST',
        body: JSON.stringify({
          saleId,
          valor: restante > 0 ? restante : total,
          storeCode,
          customerName: customerName || undefined,
          customerCpf: customerCpf || undefined,
          customerEmail: customerEmail || undefined,
          // Venda online: a cliente não está no balcão pra pagar em 15min.
          expiresInMinutes: 60,
        }),
      });
      setPixOnline({
        txid: pb.pagbankOrderId,
        payload: pb.qrCodeText,
        qrCodeDataUrl: pb.qrCodeImageB64 ? `data:image/png;base64,${pb.qrCodeImageB64}` : '',
        expiresAt: pb.expiresAt,
        valor: pb.valor,
      });
    } catch (e: any) {
      const msg = String(e?.message || e);
      setPixOnlineErro(
        /desabilitado/i.test(msg) ? 'PagBank está desligado nas configurações.'
          : /não configurado|Token/i.test(msg) ? 'PagBank sem token configurado pra esta loja.'
            : msg.slice(0, 140),
      );
    } finally {
      setPixOnlineLoading(false);
    }
  };

  // VENDA ONLINE exige VENDEDORA ANTES (dono 29/07): o fechamento pode
  // acontecer bem depois (link pago via webhook / "Liberar") — se não
  // escolher agora, a venda fica sem dona e some da comissão.
  useEffect(() => {
    if (selected === 'venda_online' && !hasSeller) onNeedSeller?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, hasSeller]);

  // Botão "Gerar Link Pagar.me" ficava fora da área visível (embaixo, atrás
  // do footer FINALIZAR) — rola a seção pra vista quando o tipo é escolhido
  // e quando o link é gerado (o card cresce).
  const pagarmeBoxRef = useRef<HTMLDivElement | null>(null);
  // Estado do Link Pagar.me gerado (URL + status)
  const [pagarmeLink, setPagarmeLink] = useState<{
    pagarmeOrderId: string;
    paymentUrl: string;
    /** O link que a gente MANDA (/pg/<token>) — ver comentário no envio. */
    shortUrl?: string;
    expiresAt: string;
  } | null>(null);
  const [pagarmeLinkLoading, setPagarmeLinkLoading] = useState(false);
  const [pagarmeLinkPaid, setPagarmeLinkPaid] = useState(false);
  const [pagarmeLinkCopied, setPagarmeLinkCopied] = useState(false);
  // E-mail/telefone usados NA COBRANÇA. Vêm do cadastro quando existe; quando
  // não, a vendedora digita aqui — é o dado que o antifraude pontua, e sem ele
  // o Flow mandava e-mail inventado e um telefone fixo igual pra rede inteira.
  const [linkEmail, setLinkEmail] = useState('');
  const [linkPhone, setLinkPhone] = useState('');
  useEffect(() => { setLinkEmail(customerEmail || ''); }, [customerEmail]);
  useEffect(() => { setLinkPhone(customerPhone || ''); }, [customerPhone]);
  const linkEmailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(linkEmail.trim());
  const linkPhoneOk = [10, 11].includes(linkPhone.replace(/\D/g, '').length);
  // Quantos links de cartão já rodaram NESTA venda. Insistir é o que mais
  // derruba: medido em 01/08, 1ª tentativa aprova 69%, 2ª 35% e da 3ª em
  // diante ZERO (0 de 21). Avisa antes de queimar mais uma.
  const [linkTentativas, setLinkTentativas] = useState(0);
  useEffect(() => {
    if (selected !== 'venda_online' || vendaOnlineTipo !== 'pagarme_link' || !saleId) return;
    let vivo = true;
    api<{ tentativas: number }>(`/pagarme/checkout/tentativas/${saleId}`)
      .then((r) => { if (vivo) setLinkTentativas(r.tentativas || 0); })
      .catch(() => { /* contador é aviso, não pode travar a venda */ });
    return () => { vivo = false; };
  }, [selected, vendaOnlineTipo, saleId]);

  useEffect(() => {
    if (selected !== 'venda_online' || vendaOnlineTipo !== 'pagarme_link') return;
    const t = setTimeout(
      () => pagarmeBoxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      80,
    );
    return () => clearTimeout(t);
  }, [selected, vendaOnlineTipo, pagarmeLink]);

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
      if (credCustomerInfo.gigaError) {
        toast('error', 'Giga fora do ar', 'Clique em "Tentar de novo" no banner antes de fechar no crediário');
      } else {
        toast('error', 'Cliente não cadastrado NESTA loja', credCustomerInfo.message || 'Cadastre no Wincred desta loja antes de fechar no crediário');
      }
      return;
    }
    if (selected === 'crediario' && !credVencto) {
      toast('warning', 'Defina o primeiro vencimento');
      return;
    }
    if (selected === 'convenio') {
      if (!convMembro) {
        toast('warning', 'Informe o associado', 'Digite o nome e confirme (conferência do limite é online no sindicato)');
        return;
      }
      // Limite só trava se foi cadastrado na retaguarda (limite > 0).
      // Associado sem limite no Flow = conferência online no sindicato.
      if (convMembro.id && (convMembro.limiteCents || 0) > 0 && Math.round(valor * 100) > (convMembro.disponivelCents ?? 0)) {
        toast('error', 'Limite do convênio insuficiente', `Disponível pra ${convMembro.nome}: ${brl((convMembro.disponivelCents || 0) / 100)}`);
        return;
      }
    }
    if (needsBandeira && !bandeira) {
      toast('warning', 'Escolha a bandeira', 'Visa, Master, Elo, Hipercard…');
      return;
    }
    // VENDA ONLINE — exige VENDEDORA + CPF do cliente + escolher PIX ou LINK
    if (selected === 'venda_online') {
      if (!hasSeller) {
        toast('warning', 'Escolha a vendedora', 'Venda online também tem dona — selecione quem vendeu.');
        onNeedSeller?.();
        return;
      }
      // CADASTRO COMPLETO (dono 18/08) — nome e sobrenome, CPF, WhatsApp,
      // e-mail e endereço inteiro. Só CPF, como era antes, deixava a peça
      // viajar sem destinatário de verdade.
      if (dadosOnlineFaltando.length) {
        toast(
          'warning',
          'Complete o cadastro da cliente',
          `Venda online precisa de: ${dadosOnlineFaltando.join(', ')}.`,
        );
        onNeedCustomer?.(entregaEfetiva);
        return;
      }
      if (!vendaOnlineTipo) {
        toast(
          'warning',
          'Escolha o tipo da venda online',
          'Gerar PIX / PIX recebido / Link externo / Link Pagar.me.',
        );
        return;
      }
      // COMO A PEÇA SAI — 1 clique, e é o que a matriz lê pra despachar.
      if (!entregaTipo) {
        toast(
          'warning',
          'Escolha a forma de entrega',
          'SEDEX, PAC, Motoboy ou Retirada em loja.',
        );
        return;
      }
      /**
       * GRAVA A ENTREGA ANTES DE CONFIRMAR (17/08). O POST do botão é
       * otimista (fire-and-forget) — se falhou, ou a venda nem existia no
       * clique, a tela mostra SEDEX e o banco está vazio: o pedido nascia
       * "Entrega (não informada)" (ON-000005/006), sem loja de retirada, e a
       * matriz roteava na mão. Aqui é AGUARDADO: se o servidor recusar (Regra
       * A do motoboy, loja inválida), a venda não fecha com entrega errada.
       */
      try {
        await api(`/pdv/sales/${saleId}/entrega`, {
          method: 'POST',
          body: JSON.stringify({ tipo: entregaTipo, entregaStoreCode: entregaStoreCode || null }),
        });
      } catch (e: any) {
        const h = humanizeError(e);
        toast('error', 'Entrega não gravada', e?.message || h.hint);
        return;
      }
      /**
       * Gerar PIX: exige o código criado E o pagamento confirmado.
       *
       * A régua era diferente da do Link Pagar.me logo abaixo — este exigia só
       * o código existir. Dava pra fechar a venda com a cliente ainda nem
       * tendo aberto o WhatsApp: peça baixada do estoque, valor no caixa e
       * nenhum dinheiro. Decisão do dono em 12/08: exigir pago, igual ao link.
       *
       * Isso só passou a ser viável agora porque o servidor CONFIRMA sozinho —
       * o reconciliador pergunta pro PagBank a cada 40s. A venda fica aberta
       * enquanto a cliente não paga e fecha sozinha quando o dinheiro entra,
       * mesmo com o PDV desligado. Ninguém precisa ficar olhando pra tela.
       */
      if (vendaOnlineTipo === 'pix_gerar') {
        if (!pixOnline) {
          toast(
            'warning',
            'Gere o PIX primeiro',
            'Clique em "Gerar PIX" pra criar o código e mandar pra cliente.',
          );
          return;
        }
        if (!pixOnlinePago) {
          toast(
            'warning',
            'O PIX ainda não caiu',
            'A venda fecha sozinha assim que o pagamento entrar — pode deixar aberta e seguir atendendo. ' +
              'Fechar antes é entregar peça sem dinheiro na conta.',
          );
          return;
        }
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
    // Loja 'externo' (franquia sem gateway): PIX não gera QR — finaliza direto
    // como dinheiro/cartão. Pula todas as travas de QR/webhook.
    if (selected === 'pix' && !pixExterno) {
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
    if (selected === 'convenio' && convMembro && convenioAtivo) {
      details.convenioId = convenioAtivo.id;
      details.convenioNome = convenioAtivo.nome;
      // Sem id = nome digitado no caixa; o backend cria/acha o associado
      if (convMembro.id) details.membroId = convMembro.id;
      details.membroNome = convMembro.nome;
      if (convMembro.matricula) details.membroMatricula = convMembro.matricula;
    }
    if (selected === 'pix') {
      if (pixExterno) {
        // Loja sem gateway: cliente pagou PIX na maquininha própria da loja.
        // Registra como PIX externo (entra no relatório como PIX, marcado).
        details.pixProvider = 'externo';
        details.pixExterno = true;
      } else if (pixCharge) {
        // pixCharge é GARANTIDO existir aqui — bloqueio acima impede passar sem.
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
      details.tipo = vendaOnlineTipo; // 'pix' | 'link' | 'pagarme_link' | 'pix_gerar'
      details.origem = 'whatsapp_instagram';
      if (vendaOnlineTipo === 'pagarme_link' && pagarmeLink) {
        details.pagarmeOrderId = pagarmeLink.pagarmeOrderId;
        details.pagarmePaymentUrl = pagarmeLink.paymentUrl;
        details.paidByWebhook = pagarmeLinkPaid;
      }
      // PIX gerado pra cliente: guarda a cobrança pra conciliar depois — sem
      // isso ninguém liga o dinheiro que caiu no PagBank a esta venda.
      if (vendaOnlineTipo === 'pix_gerar' && pixOnline) {
        details.pixTxid = pixOnline.txid;
        details.pixChave = 'PagBank';
        details.pixProvider = 'pagbank';
        details.pagbankOrderId = pixOnline.txid;
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
        // ── O RECONCILIADOR CHEGOU PRIMEIRO ──
        // O cron de PIX do backend viu o PagBank pago e já fechou a venda
        // com ESTE mesmo pagamento. Não é erro: a venda passou. Pula direto
        // pro encerramento (tela de finalizada + cupom + NFC-e) em vez de
        // empurrar um pagamento duplicado na lista.
        if (newPayment?.alreadyFinalized) {
          toast(
            'success',
            'Pagamento já confirmado automaticamente',
            'O sistema detectou o PIX pago e fechou a venda. Seguindo pro cupom.',
          );
          setSelected(null);
          setPixCharge(null);
          onPaymentsChange?.();
          onConfirm('', undefined);
          return;
        }
        setPayments((prev) => [...prev, newPayment]);
      }

      // CRIA PARCELAS NO GIGA (só se for crediário) — escreve N linhas em movimento
      if (selected === 'crediario' && valorFinanciado > 0) {
        try {
          const r = await postCrediarioComOverride(saleId, {
            parcelas,
            primeiroVencimento: credVencto,
            entrada: entradaNum,
            observacao: credObs || undefined,
          });
          toast(
            'success',
            r.idempotent
              ? `Parcelas já existiam no Giga (controle ${r.controle})`
              : `${parcelas}× parcela(s) criada(s) no Giga`,
            r.idempotent
              ? 'Crediário não foi duplicado.'
              : `Controle ${r.controle} · ${brl(valorFinanciado)} dividido em ${parcelas}×`,
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
      // REDE DE SEGURANÇA do caso acima: se o backend ainda respondeu
      // "Venda já fechada" (deploy antigo, ou pagamento que o backend não
      // reconheceu como equivalente), confere o estado REAL da venda antes
      // de assustar a vendedora. Venda finalizada = deu certo, segue pro
      // cupom. O erro seco levava ela a bipar tudo de novo — estoque em
      // dobro e caixa duplicado (caso Itanhaém, 10/08).
      if (/j[áa] fechada|j[áa] est[áa] finalized/i.test(String(e?.message || ''))) {
        try {
          const fresh = await api<any>(`/pdv/sales/${saleId}`);
          if (fresh?.status === 'finalized') {
            toast(
              'success',
              'Essa venda já foi fechada',
              'O pagamento entrou e o sistema finalizou sozinho. Seguindo pro cupom — NÃO bipe as peças de novo.',
            );
            setSelected(null);
            setPixCharge(null);
            onPaymentsChange?.();
            onConfirm('', undefined);
            return;
          }
        } catch { /* não deu pra conferir — cai no erro normal abaixo */ }
      }
      /**
       * VENDA QUE NÃO EXISTE MAIS NO SERVIDOR (11/08/2026).
       *
       * A auditoria achou cobranças PIX PAGAS cujo saleId não existe em tabela
       * nenhuma: a tela estava numa venda que o servidor não conhece (aba
       * velha, venda recriada), o QR foi gerado assim mesmo, a cliente pagou —
       * e a vendedora ficava presa num erro seco, sem saber que O DINHEIRO
       * ENTROU. O guard novo impede gerar QR nessa situação; se ainda assim
       * acontecer, o recado precisa dizer o que fazer com o pagamento.
       */
      if (/n[ãa]o encontrada/i.test(String(e?.message || '')) && (pixPaid || pixOnline)) {
        toast(
          'error',
          'ATENÇÃO: pagamento recebido, venda perdida',
          'A cliente PAGOU, mas esta venda não existe mais no servidor. NÃO cobre de novo. ' +
            'Anote o valor e avise a matriz — o pagamento aparece em "PIX órfãos" do admin. ' +
            'Depois recarregue o PDV (F5) e refaça a venda como VENDA ONLINE já paga.',
        );
        return;
      }
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
    // Loja com PIX externo (franquia sem gateway) NÃO gera cobrança nem QR —
    // o PIX é só "informar pagamento" e finaliza direto. Choke point único:
    // protege contra QUALQUER caminho que chame generatePix (auto-gerar,
    // clique no método, regeração por valor).
    if (pixExterno) return;
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
      // Registra o valor deste QR — a regeneração automática compara com o
      // campo "Quanto cobrar" pra saber se o QR ficou defasado.
      pixQrValorRef.current = valor;
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

      // Le configuracao da loja: qual gateway PIX usar.
      //   'auto'    = tenta PagBank, fallback Pagar.me
      //   'pagbank' = forca so PagBank (sem cair pra Pagar.me)
      //   'pagarme' = forca so Pagar.me
      // Default 'auto' se nao conseguir ler config (rede falhou, etc).
      let storePixProvider: 'auto' | 'pagbank' | 'pagarme' = 'auto';
      try {
        const cfg = await api<{ provider: 'auto' | 'pagbank' | 'pagarme' }>(
          `/stores/by-code/${storeCode}/pix-provider`,
        );
        if (cfg?.provider) storePixProvider = cfg.provider;
      } catch (e: any) {
        console.warn('[pdv] falha lendo pixProvider da loja, usando auto:', e?.message);
      }

      // Helpers: cada gateway encapsulado, retorna true se OK / false se falhou
      const tryPagbank = async (): Promise<boolean> => {
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
            qrCodeDataUrl: pb.qrCodeImageB64 ? `data:image/png;base64,${pb.qrCodeImageB64}` : '',
            provider: 'pagbank',
            pagbankOrderId: pb.pagbankOrderId,
            expiresAt: pb.expiresAt,
          });
          return true;
        } catch (e: any) {
          const msg = String(e?.message || e);
          let reason = '';
          if (/desabilitado/i.test(msg)) reason = 'desligado';
          else if (/não configurado|Token/i.test(msg)) reason = 'sem token';
          else reason = msg.slice(0, 80);
          failures.push(`PagBank: ${reason}`);
          console.warn('[pdv] PagBank PIX falhou:', msg);
          return false;
        }
      };

      const tryPagarme = async (): Promise<boolean> => {
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
          return true;
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
          return false;
        }
      };

      // Estrategia conforme config da loja:
      if (storePixProvider === 'pagbank') {
        // Forca PagBank — se falhar, NAO tenta Pagar.me, vai direto pro PIX local
        if (await tryPagbank()) return;
      } else if (storePixProvider === 'pagarme') {
        // Forca Pagar.me
        if (await tryPagarme()) return;
      } else {
        // AUTO: PagBank primeiro, depois Pagar.me
        if (await tryPagbank()) return;
        if (await tryPagarme()) return;
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
    // Espera saber o provider da loja antes de auto-gerar — senão, no instante
    // de abertura (antes do fetch resolver), geraria QR de gateway numa loja
    // que é 'externo'. Loja externo nunca auto-gera.
    if (!pixProviderReady) return;
    if (pixExterno) return;
    if (pixCharge || pixLoading) return;
    autoPixTriggeredRef.current = true;
    generatePix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, pixProviderReady]);

  // ── REGENERAÇÃO AUTOMÁTICA DO QR ──
  // Vendedora altera o "Quanto cobrar com PIX?" com QR já na tela → espera
  // 900ms ela terminar de digitar e regera o QR com o novo valor sozinho.
  // (Substituiu o botão "Regerar QR" — ela esquecia de clicar e o cliente
  // pagava o valor antigo.) Não roda se: sem QR, QR pago, ou já gerando.
  useEffect(() => {
    if (selected !== 'pix' || !pixCharge || pixPaid || pixLoading) return;
    const valorDigitado = Number((valorParcial || '0').replace(/\./g, '').replace(',', '.')) || 0;
    // Mesmo critério do generatePix — evita regerar por valor que ele ignoraria
    const valorEsperado =
      valorDigitado > 0 && valorDigitado <= restante + 0.01
        ? valorDigitado
        : restante > 0
        ? restante
        : total;
    const valorAtualQr = pixQrValorRef.current;
    if (valorAtualQr != null && Math.abs(valorEsperado - valorAtualQr) < 0.01) return;
    if (valorEsperado <= 0) return;
    const t = setTimeout(() => {
      autoPixTriggeredRef.current = false;
      setPixCharge(null);
      generatePix(valorEsperado);
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valorParcial, selected, pixCharge, pixPaid, pixLoading]);

  // ── POLLING (Pagar.me ou PagBank) ──
  // Estrategia 2-em-1: a cada 1s consulta o status local (que webhook
  // atualiza). MAS a cada 3s tambem chama /pix/check que consulta DIRETO
  // na API do gateway — assim NAO ficamos refens do webhook chegar.
  // Funciona mesmo se webhook estiver bloqueado/atrasado/desabilitado.
  useEffect(() => {
    if (!pixCharge || pixPaid) return;
    if (pixCharge.provider !== 'pagarme' && pixCharge.provider !== 'pagbank') return;

    const statusEndpoint =
      pixCharge.provider === 'pagarme'
        ? `/pagarme/pix/status/${saleId}`
        : `/pagbank/pix/status/${saleId}`;

    // Endpoint /pix/check vai direto na API do gateway perguntar
    // status atualizado (independente do webhook ter chegado).
    const orderId =
      pixCharge.provider === 'pagarme'
        ? pixCharge.pagarmeOrderId
        : pixCharge.pagbankOrderId;
    const checkEndpoint = orderId
      ? pixCharge.provider === 'pagarme'
        ? `/pagarme/pix/check/${orderId}`
        : `/pagbank/pix/check/${orderId}`
      : null;

    let cancelled = false;
    let tickCount = 0;
    // Guard de in-flight: NAO deixa o tick de 1s empilhar quando o status local
    // ou o /pix/check (POST no gateway) demoram >1s. Era o padrao do flood da live.
    let inFlight = false;

    const handleResult = (status: string, isFailed?: boolean) => {
      if (cancelled) return;
      if (status === 'paid') {
        setPixPaid(true);
      } else if (status === 'failed' || status === 'canceled' || isFailed) {
        toast(
          'error',
          'PIX falhou / cancelado',
          'Gateway reportou erro. NAO finalize — peca pra cliente pagar de novo ou trocar de forma.',
        );
        setPixCharge(null);
      }
    };

    const tick = async () => {
      if (inFlight) return; // poll anterior ainda em voo — pula este tick
      inFlight = true;
      tickCount++;
      try {
        // SEMPRE consulta status local (webhook pode ter chegado)
        try {
          const r = await api<{ status: string; isPaid?: boolean; isFailed?: boolean }>(statusEndpoint);
          handleResult(r.status, r.isFailed);
        } catch {
          // silencioso
        }

        // A cada 3 ticks (3s), FORCA consulta na API do gateway
        // pra cobrir caso de webhook nao ter chegado.
        if (checkEndpoint && tickCount % 3 === 0 && !cancelled) {
          try {
            const r = await api<{ status: string; paid?: boolean }>(checkEndpoint, {
              method: 'POST',
            });
            if (r.status === 'paid' || r.paid) {
              handleResult('paid');
            }
          } catch {
            // silencioso — endpoint check pode falhar temporariamente
          }
        }
      } finally {
        inFlight = false;
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

  // Volta pra grade de formas (trocar forma de pagamento). Sai do PIX, descarta
  // o QR/cobrança e REABRE todas as formas — o filtro 'pix' (quando o modal é
  // aberto pelo atalho PIX) escondia as outras e prendia a vendedora no QR.
  const trocarForma = () => {
    setSelected(null);
    setPixCharge(null);
    setPixPaid(false);
    setVendaOnlineTipo(null);
    setBandeira(null);
    setParcelas(1);
    setValorParcial('');
    setEffectiveFilter('all');
    setConvMembro(null);
    setConvBusca('');
  };

  const canConfirm = useMemo(() => {
    if (!selected) return false;
    if (selected === 'crediario' && !customerCpf) return false;
    // BUG FIX: valida recebido contra `restante`, NÃO `total`. Com vale-troca
    // aplicado, cliente só precisa cobrir o que falta — não a venda inteira.
    if (selected === 'dinheiro' && recebidoNum < restante) return false;
    if (needsBandeira && !bandeira) return false;
    // Venda online também precisa da FORMA DE ENTREGA (14/08) — é o que a
    // matriz lê pra despachar (etiqueta, motoboy ou retirada na loja).
    if (selected === 'venda_online' && (!customerCpf || !vendaOnlineTipo || !entregaTipo)) return false;
    if (selected === 'convenio' && !convMembro) return false;
    return true;
  }, [selected, bandeira, needsBandeira, recebidoNum, restante, customerCpf, vendaOnlineTipo, entregaTipo, convMembro]);

  const confirm = async () => {
    if (!selected) return;

    // ── Validações específicas pra CREDIÁRIO ──
    if (selected === 'crediario') {
      if (!customerCpf) {
        toast('warning', 'CPF obrigatório', 'Identifique o cliente antes');
        return;
      }
      if (credCustomerInfo && !credCustomerInfo.found) {
        if (credCustomerInfo.gigaError) {
          toast('error', 'Giga fora do ar', 'Clique em "Tentar de novo" no banner antes de fechar no crediário');
        } else {
          toast('error', 'Cliente não cadastrado NESTA loja', credCustomerInfo.message || 'Cadastre no Wincred desta loja antes de fechar no crediário');
        }
        return;
      }
      if (!credVencto) {
        toast('warning', 'Defina o primeiro vencimento');
        return;
      }
    }
    if (selected === 'convenio') {
      if (!convMembro) {
        toast('warning', 'Informe o associado do convênio');
        return;
      }
      const cobrar = restante > 0 ? restante : total;
      if (convMembro.id && (convMembro.limiteCents || 0) > 0 && Math.round(cobrar * 100) > (convMembro.disponivelCents ?? 0)) {
        toast('error', 'Limite do convênio insuficiente', `Disponível pra ${convMembro.nome}: ${brl((convMembro.disponivelCents || 0) / 100)}`);
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
    if (selected === 'convenio' && convMembro && convenioAtivo) {
      details.convenioId = convenioAtivo.id;
      details.convenioNome = convenioAtivo.nome;
      // Sem id = nome digitado no caixa; o backend cria/acha o associado
      if (convMembro.id) details.membroId = convMembro.id;
      details.membroNome = convMembro.nome;
      if (convMembro.matricula) details.membroMatricula = convMembro.matricula;
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
          const r = await postCrediarioComOverride(saleId, {
            parcelas,
            primeiroVencimento: credVencto,
            entrada: entradaNum,
            observacao: credObs || undefined,
          });
          toast(
            'success',
            r.idempotent
              ? `Parcelas já existiam no Giga (controle ${r.controle})`
              : `${parcelas}× parcelas criadas no Giga`,
            r.idempotent
              ? 'Crediário não foi duplicado.'
              : `Controle ${r.controle} · ${brl(valorFinanciado)} dividido`,
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
            <span className={`text-3xl font-black tabular-nums leading-none ${pago100 ? 'text-emerald-600' : payments.length > 0 ? 'text-rose-700' : 'text-[#2E7D46]'}`}>
              {pago100 ? brl(total) : brl(restante)}
            </span>
          </div>
          {/* Barra de progresso — fatias coloridas por forma de pagamento */}
          <div className="h-2.5 bg-slate-200 rounded-full overflow-hidden flex">
            {payments.map((p, i) => {
              const pct = (p.valor / total) * 100;
              const cor = paymentColor(p.method);
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
              const cor = paymentColor(p.method);
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
              {[
                ...PAYMENT_METHODS,
                // CONVÊNIO só aparece na loja que tem convênio ativo (ex.: Indaiatuba)
                ...(convenioAtivo ? [{ id: 'convenio', label: 'Convênio', icon: Handshake } as any] : []),
              ]
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
                          : 'border-[#CDA434] bg-[#FBF6E6] text-[#8C7325]'
                        : isVendaOnline
                        ? 'border-teal-300 bg-teal-50/40 text-teal-700 hover:border-teal-400'
                        : 'border-slate-200 hover:border-slate-300 text-slate-600'
                    }`}
                    title={
                      disabled
                        ? 'Crediário exige CPF do cliente'
                        : p.id === 'venda_online' && dadosOnlineFaltando.length
                          ? `Cadastro da cliente incompleto — falta: ${dadosOnlineFaltando.join(', ')}`
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
                  className={`pdv-brand-tile py-3 px-2 rounded-xl border-2 transition-all flex items-center justify-center min-h-[68px] ${
                    bandeira === b
                      ? 'border-[#CDA434] bg-[#FBF6E6] shadow-md'
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {/* GERAR PIX — o caso do WhatsApp: a cliente fechou e precisa
                  receber o código pra pagar. Vem primeiro por ser o mais usado. */}
              <button
                type="button"
                onClick={() => { setVendaOnlineTipo('pix_gerar'); setPagarmeLink(null); }}
                className={`py-3 px-2 rounded-lg border-2 font-bold text-xs flex flex-col items-center gap-1 transition-all ${
                  vendaOnlineTipo === 'pix_gerar'
                    ? 'border-emerald-600 bg-emerald-100 text-emerald-900 shadow-md ring-2 ring-emerald-300'
                    : 'border-emerald-400 hover:border-emerald-500 bg-emerald-50 text-emerald-800'
                }`}
              >
                <QrCode className="w-5 h-5" />
                Gerar PIX
                <span className="text-[9px] font-normal text-emerald-700 leading-tight font-bold">
                  Mandar p/ cliente
                </span>
              </button>
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
                PIX recebido
                <span className="text-[9px] font-normal text-slate-500 leading-tight">
                  Já caiu na conta
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
            {/* CADASTRO DA CLIENTE (dono 18/08) — sem nome e sobrenome, CPF,
                WhatsApp e e-mail a etiqueta sai "Cliente" e ninguém consegue
                avisar a cliente. O ENDEREÇO entra na conta só quando a peça
                VIAJA: em RETIRADA EM LOJA a cliente busca no balcão e não
                precisa passar CEP (dono 18/08). Enquanto a forma de entrega
                não é escolhida a régua cobra o endereço — é o lado seguro —
                e o aviso abaixo diz que clicar em RETIRA NA LOJA dispensa. */}
            {dadosOnlineFaltando.length > 0 ? (
              <div className="bg-rose-50 border-2 border-rose-300 text-rose-900 text-xs rounded-lg p-2.5 space-y-2">
                <div className="font-black">⚠ Cadastro da cliente incompleto</div>
                <div className="leading-snug">
                  Falta <b>{dadosOnlineFaltando.join(', ')}</b>.
                </div>
                {!entregaEfetiva && soFaltaEndereco && (
                  <div className="leading-snug bg-white/70 border border-rose-200 rounded p-1.5">
                    🏬 Se a cliente vai <b>retirar na loja</b>, escolha a forma de
                    entrega aqui embaixo — retirada <b>não precisa de endereço</b>.
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => onNeedCustomer?.(entregaEfetiva)}
                  className="w-full py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold"
                >
                  Completar cadastro da cliente
                </button>
              </div>
            ) : (
              <div className="bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs rounded p-2 font-semibold flex items-center justify-between gap-2">
                <span>✓ Cadastro completo — {customerName}</span>
                <button
                  type="button"
                  onClick={() => onNeedCustomer?.(entregaEfetiva)}
                  className="underline font-bold shrink-0"
                >
                  ver/editar
                </button>
              </div>
            )}

            {/* ── COMO A PEÇA SAI (14/08) — a matriz despacha por isto:
                SEDEX/PAC geram etiqueta dos Correios, MOTOBOY é entrega na
                mão e RETIRADA segura a peça na própria loja (o pedido nasce
                como retirada, sem etiqueta). Obrigatório na venda online. ── */}
            <div className="bg-white border-2 border-teal-200 rounded-lg p-2.5">
              <label className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider">
                Forma de entrega <span className="text-rose-600">*</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5 mt-1">
                {([
                  { id: 'sedex', label: '⚡ SEDEX' },
                  { id: 'pac', label: '📦 PAC' },
                  { id: 'motoboy', label: '🛵 MOTOBOY' },
                  { id: 'retirada', label: '🏬 RETIRA NA LOJA' },
                ] as const).map((op) => (
                  <button
                    key={op.id}
                    type="button"
                    onClick={async () => {
                      // Trocar de forma zera a loja escolhida — SEDEX/PAC não
                      // têm loja que atende, e retirada→motoboy é outra escolha.
                      const lojaAtende = op.id === entregaTipo ? entregaStoreCode : '';
                      setEntregaTipo(op.id);
                      setEntregaStoreCode(lojaAtende);
                      if (!saleId) return;
                      try {
                        await api(`/pdv/sales/${saleId}/entrega`, {
                          method: 'POST',
                          body: JSON.stringify({ tipo: op.id, entregaStoreCode: lojaAtende || null }),
                        });
                      } catch (e: any) {
                        const h = humanizeError(e);
                        if (op.id === 'motoboy' && (e?.status === 400 || /motoboy/i.test(String(e?.message || '')))) {
                          // REGRA A (dono, 17/08): motoboy só sai desta loja. O
                          // servidor disse que falta peça aqui — a escolha NÃO
                          // fica. Deixar marcado seria fechar a venda com uma
                          // entrega que o fechamento vai recusar de novo.
                          setEntregaTipo(null);
                          toast('error', 'Motoboy não disponível', e?.message || h.hint);
                          return;
                        }
                        // Outros erros: a escolha fica na tela; o finalize
                        // regrava. Nunca travar a venda por registro da entrega.
                        toast('error', h.title, h.hint);
                      }
                    }}
                    className={`rounded-lg border-2 py-2 text-xs font-bold transition ${
                      entregaTipo === op.id
                        ? 'border-teal-500 bg-teal-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-teal-300'
                    }`}
                  >
                    {op.label}
                  </button>
                ))}
              </div>

              {/* LOJA QUE ATENDE (17/08) — retirada: onde a cliente busca;
                  motoboy: quem sai de moto. Padrão = esta loja. A loja-canal
                  SITE vende pra cliente de qualquer cidade e não tem balcão
                  nem moto — sem isto o pedido nascia "retira NA LOJA 13" e a
                  matriz roteava na mão (ON-000006, 2 dias parado). */}
              {(entregaTipo === 'retirada' || entregaTipo === 'motoboy') && (
                <div className="mt-2">
                  <label className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider">
                    {entregaTipo === 'retirada' ? 'Cliente retira em qual loja?' : 'Qual loja manda o motoboy?'}
                  </label>
                  <select
                    value={entregaStoreCode}
                    onChange={async (e) => {
                      const code = e.target.value;
                      const anterior = entregaStoreCode;
                      setEntregaStoreCode(code);
                      if (!saleId) return;
                      try {
                        await api(`/pdv/sales/${saleId}/entrega`, {
                          method: 'POST',
                          body: JSON.stringify({ tipo: entregaTipo, entregaStoreCode: code || null }),
                        });
                      } catch (err: any) {
                        // Voltou pra "esta loja" e o servidor recusou (Regra A
                        // do motoboy sem estoque aqui): desfaz a escolha.
                        setEntregaStoreCode(anterior);
                        const h = humanizeError(err);
                        toast('error', h.title, err?.message || h.hint);
                      }
                    }}
                    className="mt-1 w-full rounded-lg border-2 border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 focus:border-teal-400 focus:outline-none"
                  >
                    <option value="">🏬 Esta loja ({storeCode})</option>
                    {stores
                      .filter((s) => s.code !== storeCode)
                      .map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.name} ({s.code})
                        </option>
                      ))}
                  </select>
                  <p className="text-[10px] text-teal-700 mt-1 font-semibold">
                    {entregaTipo === 'retirada'
                      ? entregaStoreCode
                        ? 'O card nasce na loja escolhida. O que ela não tiver chega por transferência antes da cliente buscar.'
                        : 'A peça fica reservada nesta loja — o pedido nasce como retirada, sem etiqueta.'
                      : entregaStoreCode
                        ? 'O card nasce na loja escolhida: ela separa (recebe por transferência o que faltar) e manda o motoboy.'
                        : 'Motoboy sai desta loja: a peça já baixa aqui e ninguém mais separa. Só vale se você tem tudo na arara.'}
                  </p>
                </div>
              )}
            </div>

            {/* ── FRETE À PARTE (dono 23/07): vira linha própria na venda —
                soma no total, entra no caixa como receita e fica FORA da
                base de comissão da vendedora ── */}
            <div className="bg-white border-2 border-teal-200 rounded-lg p-2.5">
              <label className="text-[10px] text-slate-600 uppercase font-semibold tracking-wider">
                Frete cobrado da cliente (R$) — opcional
              </label>
              <div className="flex gap-2 mt-1">
                <input
                  value={freteStr}
                  onChange={(e) => setFreteStr(e.target.value.replace(/[^\d.,]/g, ''))}
                  placeholder="0,00"
                  inputMode="decimal"
                  className="flex-1 rounded-lg border-2 border-slate-200 px-3 py-2 text-sm text-right tabular-nums focus:border-teal-400 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={aplicandoFrete}
                  onClick={async () => {
                    const v = Math.round((Number((freteStr || '0').replace(/\./g, '').replace(',', '.')) || 0) * 100) / 100;
                    setAplicandoFrete(true);
                    try {
                      const r = await api<{ ok: boolean; freteReais: number; total: number }>(
                        `/pdv/sales/${saleId}/frete`,
                        { method: 'POST', body: JSON.stringify({ valor: v }) },
                      );
                      onPaymentsChange?.();
                      toast(
                        'success',
                        v > 0 ? `Frete de ${brl(v)} aplicado` : 'Frete removido',
                        `Total da venda: ${brl(r.total)} — a linha FRETE aparece no carrinho`,
                      );
                    } catch (e: any) {
                      const h = humanizeError(e);
                      toast('error', h.title, h.hint);
                    } finally {
                      setAplicandoFrete(false);
                    }
                  }}
                  className="rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold px-4 disabled:opacity-50"
                >
                  {aplicandoFrete ? '...' : 'Aplicar frete'}
                </button>
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                Soma no total a cobrar · não baixa estoque · fora da comissão da vendedora.
              </p>
            </div>

            {/* ── PAINEL: Gerar PIX (PagBank) — código pra mandar pra cliente ── */}
            {vendaOnlineTipo === 'pix_gerar' && (
              <div className="border-2 border-emerald-300 rounded-lg p-3 bg-emerald-50/40 space-y-2">
                {!pixOnline ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void gerarPixOnline()}
                      disabled={pixOnlineLoading || !saleId}
                      className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm py-3 disabled:opacity-50"
                    >
                      {pixOnlineLoading ? 'Gerando PIX...' : `Gerar PIX de ${brl(restante > 0 ? restante : total)}`}
                    </button>
                    <p className="text-[10px] text-slate-500 text-center">
                      PagBank · vale 1 hora · a venda confirma sozinha quando ela pagar
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex items-start gap-3">
                      {pixOnline.qrCodeDataUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={pixOnline.qrCodeDataUrl}
                          alt="QR Code do PIX"
                          className="w-28 h-28 rounded border border-emerald-200 bg-white"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-bold text-emerald-800 uppercase tracking-wider">
                          PIX copia e cola
                        </p>
                        <p className="mt-1 text-[10px] font-mono break-all text-slate-600 leading-tight max-h-16 overflow-y-auto">
                          {pixOnline.payload}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(pixOnline.payload);
                            setPixOnlineCopiado(true);
                            setTimeout(() => setPixOnlineCopiado(false), 2500);
                          } catch {
                            setPixOnlineErro('Não consegui copiar — selecione o código acima à mão.');
                          }
                        }}
                        className="rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold py-2.5"
                      >
                        {pixOnlineCopiado ? '✓ Copiado' : 'Copiar código'}
                      </button>
                      <a
                        href={`https://api.whatsapp.com/send?${
                          customerPhone ? `phone=55${customerPhone.replace(/\D/g, '')}&` : ''
                        }text=${encodeURIComponent(
                          `Oi${customerName ? ` ${customerName.split(' ')[0]}` : ''}! Segue o PIX de ${brl(pixOnline.valor)} pra fechar seu pedido 💛\n\nÉ só copiar o código abaixo e colar no seu banco (PIX copia e cola):\n\n${pixOnline.payload}\n\nAssim que o pagamento cair a gente já separa tudo!`,
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2.5 flex items-center justify-center gap-1.5"
                      >
                        Mandar no WhatsApp
                      </a>
                    </div>
                    {pixOnlinePago ? (
                      <div className="rounded-lg bg-emerald-600 text-white text-center text-xs font-bold py-2.5">
                        ✓ PAGAMENTO CONFIRMADO — pode finalizar a venda
                      </div>
                    ) : (
                      <div className="rounded-lg bg-white border border-emerald-200 text-emerald-800 text-center text-[11px] font-semibold py-2">
                        Aguardando o pagamento cair… o sistema avisa aqui sozinho
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => { setPixOnline(null); setPixOnlineErro(null); setPixOnlinePago(false); }}
                      className="w-full text-[11px] text-slate-500 hover:text-slate-700 underline"
                    >
                      Gerar outro código (valor mudou)
                    </button>
                  </>
                )}
                {pixOnlineErro && (
                  <div className="bg-rose-50 border border-rose-300 text-rose-800 text-[11px] rounded p-2 font-semibold">
                    {pixOnlineErro}
                  </div>
                )}
              </div>
            )}

            {/* ── PAINEL: Link Pagar.me — gera URL + cliente paga + webhook ── */}
            {vendaOnlineTipo === 'pagarme_link' && customerCpf && (
              <div ref={pagarmeBoxRef} className="border-2 border-violet-300 rounded-lg p-2 bg-violet-50/30 space-y-2">
                {/* Cartão só passa com dado REAL da cliente. Medido em 01/08:
                    cobrança com dado inventado aprova 22,8%; com dado real,
                    63,1%. Preenchível AQUI — travar sem deixar preencher
                    pararia 69% dos links. */}
                {/* Reenviar cartão é o que MAIS derrubou aprovação: 3ª tentativa
                    em diante, zero passou em 21 medidas. Avisa e oferece saída
                    — mas não bloqueia, a decisão continua da vendedora. */}
                {!pagarmeLink && linkTentativas >= 2 && (
                  <div className="bg-rose-50 border-2 border-rose-300 rounded-lg p-2.5 text-[11px] text-rose-900">
                    <div className="font-bold mb-1">
                      ⚠ Já foram {linkTentativas} tentativas de cartão nesta venda
                    </div>
                    <p className="leading-snug mb-1.5">
                      Da 3ª em diante <b>nenhuma passou</b> (0 de 21 medidas) — e cada
                      reenvio piora a chance da próxima. O cartão dela não vai passar
                      insistindo.
                    </p>
                    <p className="leading-snug font-semibold">
                      Ofereça <b>PIX</b> (aprova 67%) ou a maquininha da loja.
                    </p>
                  </div>
                )}
                {!pagarmeLink && (
                  <div className="bg-white border-2 border-violet-200 rounded-lg p-2 space-y-1.5">
                    <div className="text-[10px] uppercase font-bold text-slate-600 tracking-wider">
                      Dados da cliente pra cobrança
                    </div>
                    <input
                      value={linkEmail}
                      onChange={(e) => setLinkEmail(e.target.value)}
                      placeholder="e-mail da cliente"
                      type="email"
                      inputMode="email"
                      className={`w-full rounded-lg border-2 px-3 py-2 text-sm focus:outline-none ${
                        linkEmailOk ? 'border-emerald-300' : 'border-amber-300 bg-amber-50'
                      }`}
                    />
                    <input
                      value={linkPhone}
                      onChange={(e) => setLinkPhone(e.target.value)}
                      placeholder="celular com DDD"
                      inputMode="tel"
                      className={`w-full rounded-lg border-2 px-3 py-2 text-sm focus:outline-none ${
                        linkPhoneOk ? 'border-emerald-300' : 'border-amber-300 bg-amber-50'
                      }`}
                    />
                    {(!linkEmailOk || !linkPhoneOk) && (
                      <p className="text-[10px] text-amber-800 leading-snug">
                        Peça pra cliente. Sem esse dado o antifraude reprova a maioria
                        das cobranças — <b>não é falha do link</b>.
                      </p>
                    )}
                  </div>
                )}
                {!pagarmeLink ? (
                  <>
                    <button
                      type="button"
                      disabled={pagarmeLinkLoading || !linkEmailOk || !linkPhoneOk || dadosOnlineFaltando.length > 0}
                      onClick={async () => {
                        // Mesma trava do PIX: link pago com cadastro pela
                        // metade = dinheiro na conta e venda travada.
                        if (dadosOnlineFaltando.length) {
                          toast(
                            'warning',
                            'Complete o cadastro antes de gerar o link',
                            `Falta: ${dadosOnlineFaltando.join(', ')}.`,
                          );
                          onNeedCustomer?.(entregaEfetiva);
                          return;
                        }
                        setPagarmeLinkLoading(true);
                        try {
                          const r = await api<{
                            pagarmeOrderId: string;
                            paymentUrl: string;
                            shortUrl?: string;
                            expiresAt: string;
                            tentativa?: number;
                          }>('/pagarme/checkout/create', {
                            method: 'POST',
                            body: JSON.stringify({
                              saleId,
                              valor: restante > 0 ? restante : total,
                              storeCode,
                              customerName,
                              customerCpf,
                              // Do cadastro quando existe, digitado quando não.
                              // O telefone nunca era enviado daqui — o backend
                              // então mandava um número FIXO pra Pagar.me em
                              // toda cobrança da rede, e o antifraude lia isso
                              // como fraude.
                              customerEmail: linkEmail.trim(),
                              customerPhone: linkPhone.replace(/\D/g, ''),
                              // maxInstallments OMITIDO de propósito: o backend
                              // usa PAGARME_MAX_PARCELAS (Railway) — mandar um
                              // número aqui IGNORA a variável da rede.
                              // expiresInMinutes OMITIDO de propósito: quem
                              // manda é PAGARME_LINK_HORAS (72h) no Railway.
                              // Chumbar 1440 aqui IGNORAVA a variável e matava
                              // o link em 24h — link mandado no fim da tarde
                              // vencia antes da cliente decidir.
                              acceptPix: true,
                              acceptCreditCard: true,
                            }),
                          });
                          setPagarmeLink(r);
                          if (r.tentativa) setLinkTentativas(r.tentativa);
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
                      <span>🔗 LINK GERADO · 72h</span>
                      {pagarmeLinkPaid && (
                        <span className="bg-emerald-600 text-white px-1.5 py-0.5 rounded">✓ PAGO</span>
                      )}
                    </div>
                    {/* O que a loja copia é o link NOSSO (/pg/<token>). A URL
                        crua da Pagar.me é de uso único: paga ou vencida, vira
                        "404 — não encontramos seu pedido" na mão da cliente. */}
                    <div className="bg-white border border-violet-300 rounded px-2 py-1 font-mono text-[10px] text-violet-900 truncate">
                      {pagarmeLink.shortUrl || pagarmeLink.paymentUrl}
                    </div>
                    {/* Linha 2: 4 botões em grid compacto */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(pagarmeLink.shortUrl || pagarmeLink.paymentUrl);
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
                          `Olá ${customerName?.split(' ')[0] || ''}! Link pra pagamento (${brl(restante > 0 ? restante : total)}):\n\n${pagarmeLink.shortUrl || pagarmeLink.paymentUrl}\n\nPIX ou cartão até 12x sem juros. O link vale 3 dias.`,
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
        {/* ── CONVÊNIO: busca e seleção do associado (lista do sindicato) ── */}
        {selected === 'convenio' && convenioAtivo && (
          <div className="space-y-2 bg-[#FBF6E6] border-2 border-[#E6DFC8] rounded-xl p-3">
            <div className="text-xs font-bold text-[#8C7325] flex items-center gap-1.5">
              <Handshake className="w-4 h-4" /> {convenioAtivo.nome}
            </div>
            {convMembro ? (
              <div className="bg-white border-2 border-emerald-300 rounded-lg p-2.5 flex items-center justify-between gap-2">
                <div>
                  <div className="font-bold text-sm text-slate-800">{convMembro.nome}</div>
                  <div className="text-[11px] text-slate-500">
                    {convMembro.matricula ? `Mat. ${convMembro.matricula} · ` : ''}
                    {convMembro.id && (convMembro.limiteCents || 0) > 0 ? (
                      <>Disponível: <b className="text-emerald-700">{brl((convMembro.disponivelCents || 0) / 100)}</b></>
                    ) : (
                      <b className="text-[#8C7325]">Confira o limite no sistema do sindicato (online)</b>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setConvMembro(null); setConvBusca(''); }}
                  className="text-[11px] font-bold text-slate-500 underline decoration-dotted shrink-0"
                >
                  trocar
                </button>
              </div>
            ) : (
              <>
                <input
                  value={convBusca}
                  onChange={(e) => setConvBusca(e.target.value.toUpperCase())}
                  placeholder="Nome do associado…"
                  autoFocus
                  className="w-full rounded-lg border-2 border-[#E6DFC8] px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none"
                />
                <div className="max-h-44 overflow-y-auto space-y-1">
                  {convResultados.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setConvMembro(m)}
                      disabled={(m.limiteCents || 0) > 0 && (m.disponivelCents || 0) <= 0}
                      className="w-full text-left bg-white border border-[#E7E2D8] rounded-lg px-3 py-2 hover:border-[#D4AF37] disabled:opacity-40 flex items-center justify-between gap-2"
                    >
                      <span className="text-sm font-medium text-slate-700">{m.nome}</span>
                      <span className={`text-xs font-bold tabular-nums ${(m.limiteCents || 0) <= 0 ? 'text-[#8C7325]' : (m.disponivelCents || 0) > 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                        {(m.limiteCents || 0) <= 0 ? 'online' : brl((m.disponivelCents || 0) / 100)}
                      </span>
                    </button>
                  ))}
                  {/* Sem lista do sindicato — conferência é ONLINE: o caixa digita
                      o nome, confere o limite no sistema do sindicato e usa direto */}
                  {convBusca.trim().length >= 3 &&
                    !convResultados.some((m) => m.nome === convBusca.trim().toUpperCase()) && (
                    <button
                      type="button"
                      onClick={() => setConvMembro({ id: null, nome: convBusca.trim().toUpperCase() })}
                      className="w-full text-left bg-white border-2 border-dashed border-[#D4AF37] rounded-lg px-3 py-2 hover:bg-[#FBF6E6] text-sm font-bold text-[#8C7325]"
                    >
                      ➕ Usar &quot;{convBusca.trim().toUpperCase()}&quot; — conferido online no sindicato
                    </button>
                  )}
                  {convResultados.length === 0 && convBusca.trim().length < 3 && (
                    <div className="text-[11px] text-slate-400 px-1 py-2">
                      Digite o nome do associado (a conferência do limite é online, no sistema do sindicato).
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {selected === 'crediario' && customerCpf && (
          <div className="space-y-2 pt-2 border-t">
            {credLoading && (
              <div className="text-xs text-slate-500 flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Buscando cliente no Giga…
              </div>
            )}
            {credCustomerInfo && !credCustomerInfo.found && credCustomerInfo.gigaError && (
              <div className="bg-amber-50 border-2 border-amber-300 rounded-lg p-2.5 text-xs text-amber-900 space-y-2">
                <div>
                  <b>⚠️ Giga fora do ar agora.</b> {credCustomerInfo.message}
                </div>
                <button
                  type="button"
                  onClick={() => setCredRefresh((n) => n + 1)}
                  className="w-full py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs"
                >
                  🔄 Tentar de novo
                </button>
              </div>
            )}
            {credCustomerInfo && !credCustomerInfo.found && !credCustomerInfo.gigaError && (
              <div className="bg-rose-50 border-2 border-rose-300 rounded-lg p-2.5 text-xs text-rose-900 space-y-2">
                <div>
                  <b>⚠️ {credCustomerInfo.outraLoja ? 'Cliente é de outra loja.' : 'Cliente não encontrado no Giga.'}</b>{' '}
                  {credCustomerInfo.message}
                </div>
                {credCustomerInfo.outraLoja && (
                  <div className="text-[10px] text-rose-700">
                    Cadastro encontrado: <b>{credCustomerInfo.outraLoja.nome || '—'}</b> · cód{' '}
                    {credCustomerInfo.outraLoja.codCliente} · loja {credCustomerInfo.outraLoja.lojas.join(', ')}
                  </div>
                )}
                {/* CÓPIA 1-CLIQUE (caso Jéssica 23/07): cria a ficha NESTA loja
                    copiando a da outra (sem limite/avaliação — crédito é por
                    loja). Réplica pro Wincred leva ~30s; re-busca automática. */}
                {credCustomerInfo.outraLoja && (
                  <button
                    type="button"
                    disabled={copiandoFicha}
                    onClick={async () => {
                      setCopiandoFicha(true);
                      try {
                        const r = await api<any>('/pdv/clientes-giga/copiar-para-loja', {
                          method: 'POST',
                          body: JSON.stringify({
                            lojaOrigem: credCustomerInfo.outraLoja!.lojas[0],
                            codigoOrigem: credCustomerInfo.outraLoja!.codCliente,
                            lojaDestino: storeCode,
                            nome: credCustomerInfo.outraLoja!.nome,
                            cpf: customerCpf,
                          }),
                        });
                        if (r?.ok && r.replicado) {
                          // Gravou no Wincred na hora — re-busca rapidinho
                          toast(
                            'success',
                            r.jaExistia ? 'Ficha já existia nesta loja' : `Ficha criada nesta loja (cód ${r.codigo})`,
                            'Gravada no Wincred ✓ — buscando de novo…',
                          );
                          setTimeout(() => setCredRefresh((n) => n + 1), 3000);
                        } else if (r?.ok) {
                          // Criou no Flow mas a gravação no Wincred falhou agora —
                          // o outbox segue tentando; mostra o motivo real
                          toast(
                            'warning',
                            `Ficha criada (cód ${r.codigo}) — Wincred pendente`,
                            r.replicaErro
                              ? `Erro na gravação: ${String(r.replicaErro).slice(0, 120)} — re-tento automático; busque de novo em ~1 min`
                              : 'Gravando no Wincred — busco de novo em ~35s',
                          );
                          setTimeout(() => setCredRefresh((n) => n + 1), 35000);
                        } else {
                          toast('error', 'Não deu pra copiar a ficha', r?.erro || 'Tente cadastrar no Wincred');
                        }
                      } catch (e: any) {
                        const h = humanizeError(e);
                        toast('error', h.title, h.hint);
                      } finally {
                        setCopiandoFicha(false);
                      }
                    }}
                    className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs disabled:opacity-50"
                  >
                    {copiandoFicha ? '⏳ Copiando ficha…' : '🏪 Copiar cadastro pra ESTA loja (1 clique)'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCredRefresh((n) => n + 1)}
                  className="w-full py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-xs"
                  title="Buscar de novo depois de cadastrar no Wincred"
                >
                  🔄 Já cadastrei no Wincred — buscar de novo
                </button>
              </div>
            )}
            {credCustomerInfo?.found && credCustomerInfo.qtdPendencias === 0 && (
              <div className="bg-emerald-50 border border-emerald-200 rounded px-2.5 py-1.5 text-xs text-emerald-800 flex items-center gap-2">
                <Check className="w-3.5 h-3.5" />
                Cliente <b>{credCustomerInfo.cliente?.nome || '—'}</b> sem pendências.
              </div>
            )}
            {credCustomerInfo?.found && credCustomerInfo.cliente?.viaFallback && (
              <div className="bg-amber-50 border border-amber-300 rounded px-2.5 py-1.5 text-[11px] text-amber-800">
                ⚠️ Achada pelo <b>{credCustomerInfo.cliente.viaFallback}</b> (cód{' '}
                {credCustomerInfo.cliente.codCliente}) — o cadastro no Wincred está sem o CPF.
                Complete depois pra busca ficar exata.
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
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
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
              {/* As 12 opções ficam visíveis em uma grade compacta (4×3 em
                  desktop), sem mudar o cálculo nem o atalho de seleção. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
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
                      className={`flex flex-col items-center justify-center gap-0.5 px-2 py-2 min-h-[68px] rounded-lg transition-all border-2 shrink-0 ${
                        ativo
                          ? 'bg-[#B8912B] border-[#8C7325] text-white shadow-md'
                          : 'bg-white border-slate-200 hover:border-[#CDA434] hover:bg-[#FBF6E6] text-slate-700'
                      }`}
                    >
                      <span className={`text-sm font-black tabular-nums leading-none shrink-0 ${
                        ativo ? 'text-white' : 'text-[#8C7325]'
                      }`}>{p}×</span>
                      <span className={`text-center text-[9px] uppercase tracking-wide font-semibold leading-tight ${
                        ativo ? 'text-white/85' : 'text-slate-400'
                      }`}>
                        {p === 1 ? 'à vista' : todasIguais ? 'de' : `de · última ${brl(calc.ultima)}`}
                      </span>
                      <span className={`text-sm sm:text-base font-black tabular-nums leading-none ${
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
            {pixExterno ? (
              <div className="rounded-lg border-2 border-sky-200 bg-sky-50 p-4 text-center space-y-1">
                <div className="text-sm font-bold text-sky-900">PIX externo — maquininha da loja</div>
                <div className="text-[12px] text-sky-800">
                  Cobre o PIX na sua maquininha/app do banco. Ao confirmar, a venda
                  finaliza direto — o sistema só registra que foi PIX (não gera QR).
                </div>
              </div>
            ) : pixLoading ? (
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
                          ? 'bg-emerald-600 text-white'
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

                {/* Regeneração AUTOMÁTICA: mudou o "Quanto cobrar com PIX?" →
                    o QR regera sozinho (useEffect com debounce de 900ms).
                    O botão manual "Regerar QR" foi removido a pedido do dono. */}
                {!pixPaid && (
                  <div className="text-[10px] text-slate-400 text-center">
                    Mudou o valor? O QR atualiza sozinho.
                  </div>
                )}

                {pixCharge.provider === 'pagarme' || pixCharge.provider === 'pagbank' ? (
                  pixPaid ? (
                    <div className="bg-emerald-100 border-2 border-emerald-400 rounded-lg p-3 text-sm text-emerald-900 font-bold text-center">
                      ✓ Pagamento confirmado pelo {pixCharge.provider === 'pagarme' ? 'Pagar.me' : 'PagBank'}! Pode adicionar abaixo.
                    </div>
                  ) : (
                    <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs text-emerald-900">
                      <b>✓ Confirmação automática:</b> assim que o cliente pagar, o {pixCharge.provider === 'pagarme' ? 'Pagar.me' : 'PagBank'} avisa
                      o sistema e a venda finaliza sozinha.
                      <div className="mt-1 text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-1">
                        💡 <b>Caiu na conta e não confirmou?</b> Confira no app do banco e use o
                        botão <b>&quot;✓ FINALIZAR&quot;</b> aí embaixo — registra o PIX na mão e libera a venda.
                      </div>
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

            {/* Voltar / trocar forma de pagamento — sai do PIX e reabre TODAS
                as formas. Antes, com o QR gerado, a vendedora ficava presa no
                PIX sem como trocar a forma de pagamento. Escondido se o PIX já
                foi confirmado como PAGO (trocar descartaria dinheiro recebido). */}
            {!pixPaid && (
              <button
                type="button"
                onClick={trocarForma}
                className="w-full px-3 py-2.5 bg-white hover:bg-slate-50 border-2 border-slate-200 hover:border-slate-300 text-slate-600 rounded-lg text-sm font-bold flex items-center justify-center gap-1.5 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" /> Trocar forma de pagamento
              </button>
            )}
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
                  (selected === 'crediario' && !customerCpf) ||
                  (selected === 'venda_online' && dadosOnlineFaltando.length > 0) ||
                  (selected === 'convenio' && !convMembro)
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
              className="w-full px-3 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-base disabled:opacity-40 flex items-center justify-center gap-2 ring-4 ring-emerald-300/60 pdv-cta-attention"
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

  // Formata CPF (11) → 286.655.298-96 ou CNPJ (14) → 04.174.338/0001-10
  const fmtCpf = (raw: string | null) => {
    if (!raw) return '';
    const d = String(raw).replace(/\D/g, '');
    if (d.length === 11) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
    if (d.length === 14) return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
    return d;
  };

  // Salva diretamente um CPF passado por parâmetro (versão pra debounce/flush)
  async function salvarCpfDireto(cpfLimpo: string, opts?: { silent?: boolean }): Promise<boolean> {
    if (cpfLimpo.length !== 11 && cpfLimpo.length !== 14) {
      if (!opts?.silent) toast('error', 'Documento invalido', 'Digite 11 digitos (CPF) ou 14 digitos (CNPJ)');
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
    if (cpfLimpo.length !== 11 && cpfLimpo.length !== 14) return;
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
      return editing && (cpfLimpo.length === 11 || cpfLimpo.length === 14) && cpfLimpo !== lastSavedCpf;
    },
    flushPendingSave: async () => {
      const cpfLimpo = cpfInput.replace(/\D/g, '');
      if ((cpfLimpo.length !== 11 && cpfLimpo.length !== 14) || cpfLimpo === lastSavedCpf) return false;
      return await salvarCpfDireto(cpfLimpo, { silent: true });
    },
  }), [cpfInput, editing, lastSavedCpf]);

  // Já tem CPF + não está editando: mostra resumido
  if (sale.customerCpf && !editing) {
    return (
      <div className="bg-blue-50 border-2 border-blue-200 rounded p-2.5 flex items-center gap-2">
        <Check className="w-4 h-4 text-blue-700 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs text-blue-700 font-bold uppercase">{sale.customerCpf && sale.customerCpf.replace(/\D/g, '').length === 14 ? 'CNPJ na nota' : 'CPF na nota'}</div>
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
      <label className="text-xs font-bold text-blue-900 uppercase">CPF / CNPJ do cliente</label>
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
          disabled={saving || ![11, 14].includes(cpfInput.replace(/\D/g, '').length)}
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
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErro(null);
    api<typeof info>(`/pdv/marcados/cliente?cpf=${customerCpf}`)
      .then((r) => { if (!cancelled) setInfo(r as any); })
      .catch((e) => {
        // Falha aqui SOME com o botão. A vendedora fica sem marcado e sem
        // explicação — foi assim que a checagem quebrada passou despercebida.
        if (!cancelled) { setInfo(null); setErro(e?.message || String(e)); }
      })
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
    if (!info) {
      // Sem resposta da checagem: mostra o motivo em vez de sumir calado.
      return (
        <details className="bg-rose-50 border border-rose-200 rounded p-2 text-xs text-rose-800">
          <summary className="cursor-pointer font-bold">
            ⚠️ Não deu pra conferir o limite de marcado
          </summary>
          <div className="mt-1">
            {erro || 'A consulta não respondeu.'}
            <div className="mt-1">
              A cliente pode ter limite — o que falhou foi a checagem. Tente o botão
              📋 <b>Marcar</b> da tela da venda, que mostra o erro exato.
            </div>
          </div>
        </details>
      );
    }
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
    // Antes: usava api.qrserver.com (CDN externo) — falhava na impressao silenciosa
    // do Electron porque a imagem nao carregava a tempo OU bloqueada por sandbox.
    // Agora: gera QR Code 100% local via qrcode-generator inline no proprio HTML
    // do cupom. Zero dependencia de internet.

    // ── Quantidade total de itens ────────────────────────────────────
    const qtdItens = sale.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);

    // ── VALE-TROCA no cupom = DESCONTO (espelha o XML da nota) ────────
    // O total da NOTA é sale.total − vale; os pagamentos exibidos são só os
    // reais (PIX/cartão/dinheiro). Sem isso o cupom saía "VALOR TOTAL R$
    // 1.429 / MULTIPLO" numa troca com vale de R$ 559,80 (nota 94, 21/07).
    const salePays = ((sale as any).payments || []) as Array<{ method: string; valor: number }>;
    const isVale = (m: string) => ['vale_troca', 'vale', 'troca'].includes(String(m || '').toLowerCase());
    const cupomVale = salePays.filter((p) => isVale(p.method)).reduce((s, p) => s + (Number(p.valor) || 0), 0);
    const cupomTotalNota = Math.max(0, Math.round((sale.total - cupomVale) * 100) / 100);
    const cupomPagsReais = salePays.filter((p) => !isVale(p.method));
    const nomePag = (m: string) => String(m || '').replace(/_/g, ' ').toUpperCase();
    const cupomPagLinhas = cupomPagsReais.length
      ? cupomPagsReais
          .map((p) => `<div class="row sm bold"><span>${nomePag(p.method)}</span><span>${brl(Number(p.valor) || 0)}</span></div>`)
          .join('')
      : `<div class="row sm bold"><span>${(sale.paymentMethod || 'SPLIT').toUpperCase()}</span><span>${brl(cupomTotalNota)}</span></div>`;

    // QR gerado AQUI (lib local 'qrcode', mesma da página DANFE) e embutido
    // como <img data:>. O script antigo no HTML nunca rodava certo: referenciava
    // qrUrl sem interpolação (ReferenceError engolido pelo catch → cupom SEM QR,
    // caso Moema 21/07) e ainda dependia de CDN externo na janela do Electron.
    let qrDataUrl = '';
    if (qrUrl) {
      try {
        qrDataUrl = await QRCode.toDataURL(qrUrl, { errorCorrectionLevel: 'M', margin: 0, width: 220 });
      } catch (e) {
        // Cupom sai sem QR, mas sai — e agora o erro aparece no console
        // pra diagnóstico em vez de morrer calado.
        console.error('[nfce] falha ao gerar QR do cupom:', e);
      }
    }
    if (!qrDataUrl) {
      console.warn('[nfce] cupom SEM QR: qrUrl=', qrUrl ? 'ok' : 'VAZIO',
        'chave=', sale.nfceChave ? 'ok' : 'VAZIA', 'xml=', xmlForQr ? 'ok' : 'VAZIO');
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>NFC-e ${sale.nfceNumber || ''}</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  /* Preto puro em TUDO + fonte mais grossa pra impressora térmica */
  body {
    font-family: 'Courier New', monospace;
    font-size: 11px;
    font-weight: 600;  /* mais grosso que normal */
    /* Papel 80mm tem área imprimível ~72mm — 78mm cortava a direita
       (valores "comidos" no cupom de Moema 21/07; mesma correção da
       página DANFE de reimpressão). */
    width: 72mm;
    max-width: 72mm;
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

  <!-- Totais — VALE-TROCA é DESCONTO na nota (não pagamento): o cupom tem
       que espelhar o XML (vNF = total − vale; caso NFC-e 94 Moema 21/07) -->
  <div class="row sm"><span>QTD. TOTAL DE ITENS</span><span>${qtdItens}</span></div>
  ${cupomVale > 0 ? `
  <div class="row sm"><span>SUBTOTAL R$</span><span>${brl(sale.total)}</span></div>
  <div class="row sm bold"><span>DESCONTO VALE-TROCA</span><span>-${brl(cupomVale)}</span></div>` : ''}
  <div class="row bold lg"><span>VALOR TOTAL R$</span><span>${brl(cupomTotalNota)}</span></div>
  <div class="row sm"><span>FORMA PAGAMENTO</span><span>VALOR PAGO</span></div>
  ${cupomPagLinhas}
  <div class="sep"></div>

  <!-- Tributos (Lei 12.741) -->
  <div class="center xs">Tributos totais incidentes (Lei Federal 12.741/2012):</div>
  <div class="center xs bold">R$ ${(cupomTotalNota * 0.0996).toFixed(2).replace('.', ',')} (Fonte: IBPT)</div>
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

  <!-- QR Code (imagem embutida — sem script, sem CDN, sem corrida) -->
  ${qrDataUrl ? `<img src="${qrDataUrl}" width="180" height="180" class="qr" style="image-rendering:pixelated;" />` : ''}

  <!-- Protocolo -->
  <div class="center xs">Protocolo de autorização:</div>
  <div class="center xs bold">${sale.nfceProtocolo || '—'}</div>
  <div class="sep"></div>

  <!-- Rodapé -->
  <div class="center sm bold">Obrigado pela preferência!</div>
  <div class="center xs">Volte sempre 💖</div>

  <!-- SEM script: QR já vem como <img data:> embutida (gerada antes do HTML).
       SEM window.print() (10/07): quem imprime é o main do Electron
       (silencioso, térmica 80mm configurada). -->
</body></html>`;

    // NFC-e SEMPRE vai direto pra impressora fiscal térmica 80mm configurada.
    // Sem preview, sem popup — fluxo silencioso pra não atrapalhar venda.
    try {
      const { loadPrinterConfig, isElectron } = await import('@/lib/printer-router');
      const electron = (window as any).electronAPI;
      if (isElectron() && electron?.silentPrintHTML) {
        const cfg = loadPrinterConfig();
        // Força modo SILENCIOSO + térmica 80mm configurada (10/07): o toggle
        // "com diálogo" do tray do app NÃO vale pra NFC-e — o diálogo/preview
        // abria com margens de A4 e o cupom saía desalinhado. Nota fiscal vai
        // SEMPRE direto pra impressora cadastrada.
        await electron.setConfig({
          ...(cfg.termica ? { printer: cfg.termica } : {}),
          silentPrint: true,
        });
        await electron.silentPrintHTML(html);
        return;
      }
      // APP ANTIGO (sem silentPrintHTML) ou Chrome puro (10/07, caso Suzano
      // PDV-17): antes só mostrava toast "App desktop necessário" e a NFC-e
      // NÃO saía na emissão — só na reimpressão. Agora imprime pelo MESMO
      // caminho da reimpressão que funciona: routePrint na página da DANFE
      // (app antigo com silentPrintUrl sai silencioso; sem nada, diálogo do
      // Chrome — que lembra a ELGIN escolhida na 1ª vez).
      const { routePrint } = await import('@/lib/printer-router');
      const r = await routePrint({
        kind: 'nfce',
        url: `/minha-loja/pdv/nfce/${sale.id}?autoprint=1`,
        warnIfMissing: true,
      });
      if (!r.ok) {
        toast(
          'warning',
          'Impressão NFC-e',
          'Não consegui mandar pra impressora. Atualize o app desktop (fechar e abrir instala a atualização) e confira a térmica em /pdv/config-impressora.',
        );
      }
    } catch (e: any) {
      console.warn('[nfce] impressão falhou:', e);
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

          {/* ─── VALE PRESENTE vendido nesta venda: imprimir certificado ─── */}
          {(() => {
            const vales = (sale.items || [])
              .map((it: any) => String(it.descricao || '').match(/^VALE PRESENTE (VP-[A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1])
              .filter(Boolean) as string[];
            if (!vales.length) return null;
            return (
              <div className="rounded border-2 border-[#ECD9A0] bg-[#FBF6E6]/60 p-3 space-y-2">
                <div className="text-sm font-bold text-[#8C7325]">
                  🎁 Vale presente ativado! Imprima o certificado pra cliente:
                </div>
                {vales.map((code) => (
                  <button
                    key={code}
                    onClick={() =>
                      window.open(`/minha-loja/pdv/vale-presente/${encodeURIComponent(code)}`, '_blank', 'noopener')
                    }
                    className="w-full rounded-lg bg-[#B8912B] hover:bg-[#A07F22] px-3 py-2.5 text-sm font-extrabold text-white flex items-center justify-center gap-2"
                  >
                    🖨 Imprimir vale {code}
                  </button>
                ))}
              </div>
            );
          })()}

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
    return <span className="text-base font-bold text-slate-700">{brand}</span>;
  }
  // VISA ELECTRON usa logo VISA + sublabel ELECTRON pra distinguir do VISANET (crédito)
  if (brand === 'VISA ELECTRON') {
    return (
      <div className="flex flex-col items-center justify-center leading-none gap-0.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="Visa Electron" className="h-7 w-auto max-w-full object-contain" />
        <span className="text-[10px] font-bold tracking-wider text-[#1A1F71]">
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
      className="h-9 max-h-9 w-auto max-w-full object-contain"
      loading="lazy"
    />
  );
}

type QuickCardBrandDockProps = {
  disabled: boolean;
  onCredit: (brand: string) => void;
  onDebit: (brand: string) => void;
};

/** Bandeiras alinhadas exclusivamente à coluna do carrinho. */
function QuickCardBrandDock({
  disabled,
  onCredit,
  onDebit,
}: QuickCardBrandDockProps) {
  const brandButton = (brand: string, onClick: () => void) => (
    <button
      key={brand}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="pdv-brand-button h-14 min-w-0 rounded-lg border border-transparent bg-transparent px-2 flex items-center justify-center hover:border-[#CDA434]/70 hover:bg-[#FBF6E6]/40 transition disabled:opacity-35 disabled:cursor-not-allowed overflow-hidden"
      title={brand}
    >
      <BandeiraLogo brand={brand} />
    </button>
  );

  return (
    <section
      className="hidden lg:block w-full bg-white rounded-2xl border border-[#CDA434]/70 shadow-sm p-2"
      aria-label="Bandeiras de cartão"
    >
      <div className="flex items-end gap-3">
        <div className="flex-[5] min-w-0">
          <div className="text-[10px] uppercase tracking-wider font-black text-[#8C7325] text-center mb-0.5">Crédito</div>
          <div className="grid grid-cols-5 gap-1">
            {BANDEIRAS_CREDITO.map((brand) => brandButton(brand, () => onCredit(brand)))}
          </div>
        </div>
        <div className="w-px h-14 bg-[#EDEAE1] shrink-0" />
        <div className="flex-[3] min-w-0">
          <div className="text-[10px] uppercase tracking-wider font-black text-[#8C7325] text-center mb-0.5">Débito</div>
          <div className="grid grid-cols-3 gap-1">
            {BANDEIRAS_DEBITO.map((brand) => brandButton(brand, () => onDebit(brand)))}
          </div>
        </div>
      </div>
    </section>
  );
}

type QuickSecondaryPaymentPanelProps = {
  disabled: boolean;
  itemsDisabled: boolean;
  convenioNome?: string | null;
  onPix: () => void;
  onMoney: () => void;
  onCrediario: () => void;
  onValeTroca: () => void;
  onVendaOnline: () => void;
  onValePresente: () => void;
  onMarcar: () => void;
  onConvenio: () => void;
};

/** Demais formas de pagamento, abaixo do resumo e sem regras próprias. */
function QuickSecondaryPaymentPanel({
  disabled,
  itemsDisabled,
  convenioNome,
  onPix,
  onMoney,
  onCrediario,
  onValeTroca,
  onVendaOnline,
  onValePresente,
  onMarcar,
  onConvenio,
}: QuickSecondaryPaymentPanelProps) {
  const actionClass = 'min-h-[58px] min-w-0 rounded-xl border border-[#E5E2D9] bg-white px-2.5 py-2 flex items-center justify-center gap-2 text-xs font-extrabold text-slate-700 hover:border-[#CDA434] hover:bg-[#FBF6E6] hover:text-[#8C7325] transition disabled:opacity-35 disabled:cursor-not-allowed whitespace-nowrap';

  return (
    <section
      className="hidden lg:grid grid-cols-2 gap-2 bg-white rounded-2xl border border-[#CDA434]/70 shadow-sm p-2.5"
      aria-label="Outras formas de pagamento"
    >
        <button type="button" onClick={onPix} disabled={disabled} className={actionClass}><QrCode className="w-4 h-4 shrink-0" />PIX</button>
        <button type="button" onClick={onMoney} disabled={disabled} className={actionClass}><Banknote className="w-4 h-4 shrink-0" />Dinheiro</button>
        <button type="button" onClick={onCrediario} disabled={disabled} className={actionClass}><Receipt className="w-4 h-4 shrink-0" />Crediário</button>
        <button type="button" onClick={onValeTroca} disabled={itemsDisabled} className={actionClass}><Tag className="w-4 h-4 shrink-0" />Vale-troca</button>
        <button type="button" onClick={onValePresente} className={actionClass}><Sparkles className="w-4 h-4 shrink-0" />Vale Presente</button>
        <button type="button" onClick={onMarcar} disabled={itemsDisabled} className={actionClass}><ShoppingCart className="w-4 h-4 shrink-0" />Marcar</button>
        <button type="button" onClick={onVendaOnline} disabled={disabled} className={`${actionClass} col-span-2`}><Globe className="w-4 h-4 shrink-0" />Venda Online</button>
        {convenioNome && (
          <button type="button" onClick={onConvenio} disabled={disabled} className={`${actionClass} col-span-2`} title={convenioNome}>
            <Handshake className="w-4 h-4 shrink-0" />Convênio
          </button>
        )}
    </section>
  );
}

function StoreSummaryModal({
  storeCode,
  storeName,
  onClose,
}: {
  storeCode: string;
  storeName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<StoreSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const activeRef = useRef(true);

  const loadSummary = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      const result = await api<StoreSummary>(
        `/pdv/store-summary?storeCode=${encodeURIComponent(storeCode)}`,
      );
      if (!activeRef.current) return;
      setData(result);
      setError(null);
    } catch (e: any) {
      if (activeRef.current) setError(e?.message || 'Não foi possível atualizar');
    } finally {
      busyRef.current = false;
      if (activeRef.current) setLoading(false);
    }
  }, [storeCode]);

  useEffect(() => {
    activeRef.current = true;
    void loadSummary();
    return () => {
      activeRef.current = false;
    };
  }, [loadSummary]);

  const number = (value: number | undefined) =>
    value === undefined ? '—' : value.toLocaleString('pt-BR');
  const updatedAt = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      {...overlayClose(onClose)}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-summary-title"
        className="bg-white rounded-2xl border border-[#CDA434]/70 shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-[#E5E2D9] flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-[#FBF6E6] border border-[#E4C968] flex items-center justify-center shrink-0">
            <Package className="w-5 h-5 text-[#8C7325]" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="store-summary-title" className="text-lg font-black text-slate-900">Resumo da Loja</h2>
            <p className="text-xs text-slate-500 truncate">{storeName} · PDV {storeCode}</p>
          </div>
          <button
            type="button"
            onClick={loadSummary}
            disabled={loading}
            className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-[#8C7325] hover:border-[#CDA434] hover:bg-[#FBF6E6] transition disabled:opacity-50"
            title="Atualizar agora"
            aria-label="Atualizar resumo agora"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
            aria-label="Fechar resumo"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto" aria-live="polite">
          {error && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2.5 flex items-center gap-2 text-xs text-rose-700">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="flex-1">Não foi possível atualizar. {error}</span>
              <button type="button" onClick={loadSummary} className="font-black underline underline-offset-2">
                Tentar novamente
              </button>
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <article className="rounded-2xl border-2 border-[#D4AF37] bg-[#FBF6E6] p-5 min-h-[150px] flex flex-col justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider font-black text-[#8C7325]">Vendido hoje</div>
                <div className="text-[11px] text-slate-500 mt-1">peças vendidas − devolvidas</div>
              </div>
              <div className={`text-5xl font-black tabular-nums leading-none ${
                (data?.netSoldTodayQty ?? 0) < 0 ? 'text-rose-600' : 'text-[#8C7325]'
              }`}>
                {number(data?.netSoldTodayQty)}
              </div>
            </article>

            <article className="rounded-2xl border-2 border-sky-300 bg-sky-50 p-5 min-h-[150px] flex flex-col justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider font-black text-sky-800">Estoque atual</div>
                <div className="text-[11px] text-slate-500 mt-1">peças disponíveis nesta loja</div>
              </div>
              <div className="text-5xl font-black tabular-nums leading-none text-sky-700">
                {number(data?.stockQty)}
              </div>
            </article>
          </div>

          <section className="rounded-2xl border border-slate-200 overflow-hidden bg-white">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-black text-slate-900">Ranking de vendas líquidas hoje</h3>
                <p className="text-[11px] text-slate-500 mt-0.5">Venda atual − vale-troca aplicado</p>
              </div>
              <span className="text-[10px] font-black uppercase tracking-wider text-[#8C7325] bg-[#FBF6E6] border border-[#E4C968] rounded-full px-2.5 py-1">
                Em valor
              </span>
            </div>

            {loading && !data ? (
              <div className="px-4 py-7 flex items-center justify-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Calculando ranking…
              </div>
            ) : (data?.sellerRanking || []).length === 0 ? (
              <div className="px-4 py-7 text-center text-sm text-slate-500">
                Nenhuma venda finalizada hoje.
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {(data?.sellerRanking || []).map((seller, index) => (
                  <div
                    key={`${seller.sellerName}-${index}`}
                    className={`px-4 py-3 flex items-center gap-3 ${index === 0 ? 'bg-[#FFFCF3]' : 'bg-white'}`}
                  >
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-sm font-black border ${
                      index === 0
                        ? 'bg-[#F7E7A9] border-[#D4AF37] text-[#6E591C]'
                        : index === 1
                          ? 'bg-slate-100 border-slate-300 text-slate-600'
                          : index === 2
                            ? 'bg-amber-100 border-amber-300 text-amber-800'
                            : 'bg-white border-slate-200 text-slate-500'
                    }`}>
                      {index < 3 ? ['1º', '2º', '3º'][index] : `${index + 1}º`}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-black text-slate-900 truncate">{seller.sellerName}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Bruto {brl(seller.grossSalesValue)} · Trocas − {brl(seller.returnsAppliedValue)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Líquido</div>
                      <div className="text-lg font-black tabular-nums text-[#2E7D46]">{brl(seller.netSalesValue)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
            <span>{updatedAt ? `Atualizado às ${updatedAt}` : 'Consultando dados atuais…'}</span>
            <span>Atualiza somente ao abrir ou clicar no botão</span>
          </div>
        </div>
      </section>
    </div>
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
    // Guard de in-flight: o backend consulta a Pagar.me ao vivo se pending, entao
    // um tick pode passar de 1s. Sem guard, os ticks de 1s empilhavam.
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return; // poll anterior ainda em voo — pula este tick
      inFlight = true;
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
      } finally {
        inFlight = false;
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
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
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
// Thumbnail do produto no carrinho do PDV (foto do WooCommerce).
//
// ANTES: CADA miniatura abria a sua própria requisição — carrinho de 12
// peças = 12 chamadas, e as fotos entravam piscando uma a uma.
// AGORA: o carrinho pede TODAS de uma vez em /pdv/product-images e guarda no
// cache do módulo; a miniatura só lê o cache. Sem foto, mantém o avatar com
// a inicial da REF.
const PRODUCT_IMG_CACHE = new Map<string, string | null>();
const PRODUCT_IMG_INFLIGHT = new Set<string>();
const PRODUCT_IMG_LISTENERS = new Set<() => void>();

/** Busca em LOTE as fotos que ainda não estão em cache. */
async function prefetchProductImages(skus: Array<string | null | undefined>) {
  const faltando = Array.from(
    new Set(
      skus
        .map((s) => String(s || '').trim())
        .filter((s) => s && !PRODUCT_IMG_CACHE.has(s) && !PRODUCT_IMG_INFLIGHT.has(s)),
    ),
  );
  if (!faltando.length) return;
  faltando.forEach((s) => PRODUCT_IMG_INFLIGHT.add(s));
  try {
    const r = await api<{ urls: Record<string, string | null> }>(
      `/pdv/product-images?skus=${encodeURIComponent(faltando.join(','))}`,
    );
    for (const s of faltando) PRODUCT_IMG_CACHE.set(s, r?.urls?.[s] ?? null);
  } catch {
    // Miniatura é enfeite: falhou, marca como "sem foto" e segue a venda.
    for (const s of faltando) PRODUCT_IMG_CACHE.set(s, null);
  } finally {
    faltando.forEach((s) => PRODUCT_IMG_INFLIGHT.delete(s));
    PRODUCT_IMG_LISTENERS.forEach((fn) => fn());
  }
}

function ProductThumb({ sku, refCode, compact = false }: { sku: string; refCode: string | null; compact?: boolean }) {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const notificar = () => forceRender((n) => n + 1);
    PRODUCT_IMG_LISTENERS.add(notificar);
    // Rede de segurança: peça que entrou fora do lote (ex.: item manual)
    // ainda pede a foto — mas em lote de um, pelo mesmo caminho.
    void prefetchProductImages([sku]);
    return () => { PRODUCT_IMG_LISTENERS.delete(notificar); };
  }, [sku]);
  const url = PRODUCT_IMG_CACHE.get(sku);

  const letter = (refCode || sku || '?').charAt(0).toUpperCase();

  if (url) {
    return (
      <div className={`${compact ? 'w-11 h-11' : 'w-12 h-12'} rounded-lg overflow-hidden bg-slate-100 border border-slate-200 shrink-0`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={refCode || sku} className="w-full h-full object-cover" />
      </div>
    );
  }
  // Fallback: tile neutro cinza-claro com inicial (espec do layout claro)
  return (
    <div className={`${compact ? 'w-11 h-11' : 'w-12 h-12'} rounded-lg bg-[#F3F1EA] border border-[#E5E2D9] flex items-center justify-center text-[#8C7325] font-black text-lg shrink-0`}>
      {letter}
    </div>
  );
}

// ── SIMULADOR DE PARCELAMENTO CARTÃO ──────────────────────────────────
// Mostra pra cliente quanto fica cada parcela de 1× a 12×, SEMPRE SEM JUROS.
// Vendedora fala em voz alta pra cliente "fica 5× de R$ 31,04". A tela cabe
// todas as 12 parcelas em grade 2 colunas — sem scroll, sem configuração.
// `total` já vem líquido de vale-troca/parciais; `temAbatimento` troca o
// rótulo pra "Falta a pagar" pra vendedora não confundir com o total bruto.
/**
 * CARRINHOS ABANDONADOS DENTRO DO PDV (17/08) — só na loja-canal SITE.
 *
 * Medido em 17/08: 7 carrinhos recuperados no dia e 2 registrados no sistema.
 * Os 5 restantes foram pagos por fora (PIX, PayPal, link) e ninguém lançou —
 * cada um custa estoque que não baixa, NF que não sai, dinheiro fora do caixa,
 * comissão que a vendedora não recebe e o carrinho seguindo como "abandonado".
 *
 * A causa era FRICÇÃO em dois níveis: remontar 11 peças à mão, e o botão de
 * importar existir só na retaguarda — que o PDV NÃO ACESSA. Aqui a lista abre
 * sem sair da tela de venda: clica na cliente e a venda monta pronta.
 */
function CarrinhosAbandonadosModal({
  onClose,
  onImportado,
}: {
  onClose: () => void;
  onImportado: (saleId: string) => void;
}) {
  const { toast } = usePdvToast();
  type Carrinho = {
    id: number;
    order_id?: number | null;
    order_number?: string | null;
    /**
     * Contato capturado no checkout (`CheckoutRecovery.id`). Quando vem, é
     * ELE que importa a venda — a linha não tem pedido por trás, e o `id`
     * numérico dela é sintético (970.000.000 + posição).
     */
    recovery_id?: string;
    /** 'ecommerce' = chegou a tocar no pagamento · 'ecommerce-contact' = parou na etapa 1. */
    source?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    cart_total?: number;
    items_count?: number;
    time?: string | null;
    utmCampaign?: string | null;
  };
  const [itens, setItens] = useState<Carrinho[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [importando, setImportando] = useState<number | null>(null);
  const [busca, setBusca] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // Só o carrinho do site NOVO: é o único cujos itens têm SKU nosso, e
        // portanto o único que dá pra montar a venda automaticamente.
        //
        // Rota do PDV, NÃO a da retaguarda: `/abandoned-carts/*` tem
        // AdminOnlyGuard e as meninas entram como `role: store` — batiam em
        // "Apenas matriz". Esta é travada na loja-canal no backend.
        const r = await api<{ items?: Carrinho[] }>(
          '/pdv/carrinhos-abandonados?status=abandoned',
        );
        setItens(Array.isArray(r?.items) ? r.items : []);
      } catch (e: any) {
        setErro(humanizeError(e).hint || 'Não consegui carregar os carrinhos.');
      } finally {
        setCarregando(false);
      }
    })();
  }, []);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return itens;
    return itens.filter((c) =>
      [c.first_name, c.last_name, c.email, c.phone, c.order_number]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [itens, busca]);

  async function importar(c: Carrinho) {
    setImportando(c.id);
    try {
      const r = await api<{
        saleId: string;
        importados: number;
        total?: number;
        faltaram?: string[];
        precoMudou?: string[];
      }>(
        '/pdv/sales/importar-carrinho',
        {
          method: 'POST',
          body: JSON.stringify(
            c.recovery_id ? { recoveryId: c.recovery_id } : { wcOrderId: c.order_id ?? c.id },
          ),
        },
      );
      // PREÇO DA VITRINE ≠ PREÇO DO CAIXA. São duas réguas diferentes de
      // propósito e podem não bater na mesma peça. Ela combinou um valor no
      // WhatsApp — não pode descobrir a diferença só quando a cliente
      // reclamar. Quem decide o que cobrar é ela, o sistema só não deixa
      // passar em silêncio.
      if (r.precoMudou?.length) {
        toast(
          'warning',
          'Preço do caixa é diferente do site',
          `${r.precoMudou.slice(0, 3).join(' · ')}${r.precoMudou.length > 3 ? ` e mais ${r.precoMudou.length - 3}` : ''}`,
        );
      }
      if (r.faltaram?.length) {
        // Avisa ANTES de abrir a venda: no PDV ela não teria como saber que
        // faltou peça e fecharia incompleta sem perceber.
        toast(
          'warning',
          `${r.importados} de ${r.total ?? r.importados} peça(s) entraram`,
          `Bipe na mão: ${r.faltaram.slice(0, 3).join(' · ')}${r.faltaram.length > 3 ? ` e mais ${r.faltaram.length - 3}` : ''}`,
        );
      }
      onImportado(r.saleId);
    } catch (e: any) {
      const h = humanizeError(e);
      toast('error', h.title, e?.message || h.hint);
      setImportando(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-2 sm:p-4 overflow-y-auto" {...overlayClose(onClose)}>
      <div
        className="bg-white rounded-xl w-full max-w-2xl my-4 max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[#EDEAE1] flex items-center gap-3">
          <ShoppingCart className="w-5 h-5 text-[#B8912B]" />
          <div className="flex-1">
            <div className="font-black text-[#2B2B2B]">Carrinhos abandonados</div>
            <div className="text-[11px] text-slate-500">
              Cliente fechou com você? Clica nela que a venda abre pronta — você só escolhe como recebeu.
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2">×</button>
        </div>

        <div className="p-3 border-b border-[#EDEAE1]">
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por nome, telefone ou e-mail…"
            className="w-full rounded-lg border-2 border-slate-200 px-3 py-2 text-sm focus:border-[#D4AF37] focus:outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {carregando && <div className="text-center text-sm text-slate-500 py-8">Carregando…</div>}
          {erro && <div className="text-center text-sm text-rose-700 font-semibold py-8">{erro}</div>}
          {!carregando && !erro && filtrados.length === 0 && (
            <div className="text-center text-sm text-slate-500 py-8">
              {itens.length === 0 ? 'Nenhum carrinho abandonado agora. 🎉' : 'Nada com esse termo.'}
            </div>
          )}
          {filtrados.map((c) => {
            const nome = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Sem nome';
            // Parou na etapa 1 do checkout: a captura pede NOME e WHATSAPP e
            // mais nada. A venda online exige cadastro completo pra fechar, e
            // é melhor ela já pedir CPF/e-mail/endereço no telefone do que
            // descobrir na hora de gerar o PIX.
            const soContato = c.source === 'ecommerce-contact';
            return (
              <div key={c.id} className="rounded-lg border-2 border-slate-200 p-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[180px]">
                  <div className="font-bold text-sm text-[#2B2B2B]">{nome}</div>
                  <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-2">
                    {c.phone && <span>{c.phone}</span>}
                    {c.items_count ? <span>{c.items_count} peça(s)</span> : null}
                    {c.order_number && <span>{c.order_number}</span>}
                    {/* Campanha de origem: é o que liga a venda ao anúncio. */}
                    {c.utmCampaign && <span className="text-emerald-700">via {c.utmCampaign}</span>}
                  </div>
                  {soContato && (
                    <div className="text-[11px] text-violet-700 font-semibold mt-0.5">
                      Só nome e WhatsApp — peça CPF, e-mail e endereço pra fechar
                    </div>
                  )}
                </div>
                <div className="font-black tabular-nums text-[#2E7D46]">
                  {brl(Number(c.cart_total || 0))}
                </div>
                <button
                  type="button"
                  disabled={importando !== null}
                  onClick={() => importar(c)}
                  className="rounded-lg bg-[#2E7D46] hover:bg-[#256b3a] disabled:opacity-50 px-4 py-2 text-sm font-bold text-white"
                >
                  {importando === c.id ? 'Abrindo…' : 'Fechar venda'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SimularParcelasModal({
  total,
  temAbatimento,
  onClose,
}: {
  total: number;
  temAbatimento?: boolean;
  onClose: () => void;
}) {
  const parcelas = Array.from({ length: 12 }, (_, idx) => idx + 1);
  const valorParcela = (n: number) => total / n;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-2 sm:p-4" {...overlayClose(onClose)}>
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
          <span className="text-[10px] text-emerald-700 font-bold uppercase tracking-wide">
            {temAbatimento ? 'Falta a pagar' : 'Total da venda'}
          </span>
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
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4" {...overlayClose(onClose)}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
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

// ── VALE PRESENTE MODAL ───────────────────────────────────────────────
// Vende um vale presente dentro da venda aberta: valor livre digitável +
// comprador/presenteado opcionais. Entra como item no carrinho (o código
// VP- sai impresso no cupom) e ATIVA quando a venda finaliza. O resgate é
// pela mesma tela do vale-troca, em qualquer loja, validade 12 meses.
function GiftVoucherModal({
  saleId,
  onClose,
  onAdded,
}: {
  saleId: string;
  onClose: () => void;
  onAdded: (code: string) => void;
}) {
  const [valor, setValor] = useState('');
  const [comprador, setComprador] = useState('');
  const [presenteado, setPresenteado] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseNum = (s: string) => {
    const n = Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  };

  const vender = async () => {
    setError(null);
    const v = parseNum(valor);
    if (v == null || v < 1 || v > 5000) {
      setError('Valor entre R$ 1,00 e R$ 5.000,00 (ex: 100 ou 149,90)');
      return;
    }
    setSaving(true);
    try {
      const r = await api<any>(`/pdv/sales/${saleId}/gift-voucher`, {
        method: 'POST',
        body: JSON.stringify({
          valor: v,
          compradorNome: comprador.trim() || undefined,
          presenteadoNome: presenteado.trim() || undefined,
        }),
      });
      onAdded(r?.voucher?.code || 'VP');
    } catch (e: any) {
      const h = humanizeError(e);
      setError(`${h.title}${h.hint ? ' · ' + h.hint : ''}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4" {...overlayClose(onClose)}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-black text-lg text-[#8C7325] flex items-center gap-2">
            🎁 Vale Presente
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <div className="bg-[#FBF6E6] border border-[#ECD9A0] rounded-lg p-2.5 text-[11px] text-[#8C7325] leading-snug">
          O vale entra no carrinho e o <b>código sai impresso no cupom</b>. Ele só vale
          depois da venda finalizada. Resgate em <b>qualquer loja</b> pela tela de
          vale-troca · validade <b>12 meses</b> · uso parcial gera vale residual · não vira troco.
        </div>

        <div>
          <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
            Valor do vale
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">R$</span>
            <input
              type="text"
              autoFocus
              inputMode="decimal"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && vender()}
              placeholder="100,00"
              className="w-full px-3 py-3 pl-10 text-xl font-bold tabular-nums border-2 border-emerald-200 rounded-xl text-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:border-emerald-400"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
              Quem compra (opcional)
            </label>
            <input
              type="text"
              value={comprador}
              onChange={(e) => setComprador(e.target.value.slice(0, 80))}
              placeholder="Nome da cliente"
              className="w-full px-3 py-2.5 text-sm border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-300 focus:border-rose-400"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase font-bold text-slate-600 mb-1 block">
              Quem ganha (opcional)
            </label>
            <input
              type="text"
              value={presenteado}
              onChange={(e) => setPresenteado(e.target.value.slice(0, 80))}
              onKeyDown={(e) => e.key === 'Enter' && vender()}
              placeholder="Nome de quem recebe"
              className="w-full px-3 py-2.5 text-sm border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-rose-300 focus:border-rose-400"
            />
          </div>
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2 text-sm">{error}</div>
        )}

        <button
          onClick={vender}
          disabled={saving}
          className="w-full py-3.5 rounded-xl bg-[#B8912B] hover:bg-[#A07F22] text-white font-extrabold text-base disabled:opacity-50"
        >
          {saving ? 'Gerando vale…' : '🎁 Adicionar vale ao carrinho'}
        </button>
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
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4" {...overlayClose(onClose)}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md p-5 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
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
    ['F10', 'Consultar produto (estoque / preço)'],
    ['Del', 'Remover último item do carrinho'],
    ['Esc', 'Fechar modal aberto'],
    ['F12 ou ?', 'Abrir / fechar esta ajuda'],
    ['0 + Enter', 'Lançar item manual (produto livre)'],
    ['REF + Espaço', 'Abrir a grade do modelo (tamanhos/cores)'],
  ];
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      {...overlayClose(onClose)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[80vh] overflow-y-auto"
      >
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div className="font-bold text-slate-800 text-base">Atalhos do PDV</div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
        <div className="p-5 space-y-1">
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

/**
 * "Essa peça entra na promoção?" — consulta pura (dono 01/08).
 *
 * Não cria venda, não lança item, não mexe em estoque. A regra dos 50% tem
 * três partes (ano de cadastro ≤ 2023, coleção -INV/-VER e o filtro de
 * BÁSICO) e a vendedora tinha que lembrar das três de cabeça com a cliente
 * na frente. O backend responde o veredito pronto — a mesma regra da venda.
 */
function PromoCheckModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [codigo, setCodigo] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [erro, setErro] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setCodigo(''); setRes(null); setErro(''); return; }
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  const consultar = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const termo = codigo.trim();
    if (!termo || busy) return;
    setBusy(true); setErro('');
    try {
      const r = await api<any>(`/pdv/promo-check?codigo=${encodeURIComponent(termo)}`);
      if (!r?.achou) { setRes(null); setErro(`Não achei nada com "${termo}"`); }
      else setRes(r);
      // Pronto pro próximo bipe sem tirar a mão do leitor.
      setCodigo('');
      inputRef.current?.focus();
    } catch (e: any) {
      setRes(null);
      setErro(e?.message || 'Falha na consulta');
    } finally { setBusy(false); }
  };

  if (!open) return null;
  const brlv = (n: number) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 pt-16" onClick={onClose}>
      <div className="w-full max-w-lg bg-[#FAFAF7] rounded-2xl shadow-xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 bg-white border-b border-[#E5E2D9] flex items-center gap-2.5">
          <Tag className="w-5 h-5 text-[#8C7325]" />
          <span className="font-bold text-slate-900">Consulta de promoção</span>
          <span className="ml-auto text-[11px] text-slate-400">não lança na venda</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5">
          <form onSubmit={consultar} className="flex items-center gap-2 bg-white rounded-xl border-2 border-[#E5E2D9] px-3 py-2 focus-within:border-[#D4AF37]">
            <Barcode className="w-5 h-5 text-slate-400 shrink-0" />
            <input
              ref={inputRef}
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              placeholder="Bipe a peça"
              className="flex-1 min-w-0 py-1.5 text-base font-semibold bg-transparent focus:outline-none text-slate-900 placeholder:font-normal placeholder:text-slate-400"
              autoComplete="off" spellCheck={false}
            />
            {busy && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
          </form>
          <p className="mt-1.5 text-[11px] text-slate-400">O resultado troca a cada leitura · Esc fecha</p>

          {erro && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{erro}</div>
          )}

          {res && (
            <div className="mt-4 bg-white rounded-xl border border-[#E5E2D9] p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-slate-900 leading-snug">{res.descricao}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    SKU {res.sku}{res.ref ? ` · ref ${res.ref}` : ''}
                    {res.cor ? ` · ${res.cor}` : ''}{res.tamanho ? ` · ${res.tamanho}` : ''}
                  </p>
                </div>
                <span className={`shrink-0 px-3 py-1 rounded-lg text-xs font-bold ${
                  res.entra ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
                }`}>
                  {res.entra ? 'Entra · 50%' : 'Fora · preço cheio'}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="bg-[#FAFAF7] rounded-lg px-3 py-2">
                  <div className="text-[11px] text-slate-500">Data de cadastro</div>
                  <div className="text-lg font-bold text-slate-900">
                    {res.dataCadastro ? res.dataCadastro.split('-').reverse().join('/') : '—'}
                  </div>
                </div>
                <div className="bg-[#FAFAF7] rounded-lg px-3 py-2">
                  <div className="text-[11px] text-slate-500">Classificação</div>
                  <div className={`text-lg font-bold ${res.classificacao === 'BASICO' ? 'text-amber-800' : 'text-slate-900'}`}>
                    {res.classificacao === 'BASICO' ? 'Básico' : 'Moda'}
                  </div>
                </div>
                <div className="bg-[#FAFAF7] rounded-lg px-3 py-2">
                  <div className="text-[11px] text-slate-500">{res.entra ? 'Preço na promoção' : 'Preço'}</div>
                  <div className="text-lg font-bold text-[#2E7D46]">
                    {brlv(res.precoPromo)}
                    {res.entra && <span className="ml-1.5 text-xs font-normal text-slate-400 line-through">{brlv(res.preco)}</span>}
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-600 flex items-start gap-2">
                {res.entra
                  ? <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-px" />
                  : <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-px" />}
                <span>{res.motivo}</span>
              </div>

              {res.avisoData && (
                <div className="mt-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-500">
                  A data do ERP muda quando alguém edita o cadastro (preço, descrição).
                  Peça antiga reeditada aparece nova aqui — confirme com a matriz antes de dar o desconto na mão.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
