'use client';

/**
 * /minha-loja/live-pdv — Console de Live Commerce (operado pela apresentadora/loja)
 *
 * Fluxo otimizado pra menos de 5s por item:
 *   1. Digita REF/código/SKU/nome → ENTER
 *   2. Clica no botão da cor/tamanho (grade)
 *   3. Confirma a cliente (modal rápido só na 1ª inclusão)
 *
 * Estoque consolidado da rede + por loja. Loja de origem escolhida
 * automaticamente. Pagamento via PIX com confirmação automática.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  BarChart3,
  Check,
  Link2,
  Loader2,
  Package,
  Pencil,
  Percent,
  QrCode,
  RefreshCw,
  Search,
  History,
  ShoppingCart,
  Store,
  Tag,
  Trash2,
  User,
  UserPlus,
  X,
  Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';

/* ─── Types ─── */
interface GradeCell {
  itemKey: string;
  // REF real da célula (pode diferir da REF base da grade quando é variante de
  // cor cadastrada com sufixo, ex.: 900658M). Enviada no addItem.
  ref?: string;
  cor: string | null;
  tamanho: string | null;
  codigos: string[];
  priceCents: number;
  available: number;
  perStore: Array<{ storeCode: string; storeName: string; qty: number }>;
}
interface GradeResult {
  found: boolean;
  ref?: string;
  descricao?: string;
  priceCents?: number;
  basePriceCents?: number;
  promoActive?: boolean;
  photoUrl?: string | null;
  totalRede?: number;
  cells?: GradeCell[];
  fromMirror?: boolean; // produto/estoque vieram do espelho (Giga fora do ar)
}
interface CartItem {
  id: string;
  refCode: string;
  descricao: string | null;
  cor: string | null;
  tamanho: string | null;
  qty: number;
  priceCents: number;
  originStoreCode: string;
  originStoreName: string;
  status: string;
  trackingCode?: string | null; // rastreio informado pela loja no despacho
}
interface Cart {
  id: string;
  cartNumber?: number | null;
  payCode?: string | null;
  customerName: string;
  customerPhone: string;
  customerInstagram: string | null;
  customerCpf?: string | null;
  customerEmail?: string | null;
  customerCep?: string | null;
  customerEndereco?: string | null;
  customerNumero?: string | null;
  customerComplemento?: string | null;
  customerBairro?: string | null;
  customerCidade?: string | null;
  customerUf?: string | null;
  status: string;
  subtotalCents: number;
  freteCents: number;
  totalCents: number;
  paymentMethod?: string | null; // 'pix' | 'link' — pra reabrir a cobrança pendente
  qrCodeText?: string | null;
  qrCodeImageUrl?: string | null;
  hasManychat?: boolean; // cliente tem vínculo ManyChat → DM automática funciona
  dmSentAt?: string | null; // carimbo de cobrança enviada (sincroniza os ✓ entre PCs)
  items: CartItem[];
}
interface ActiveCustomer {
  id: string;
  name: string;
  phone: string;
  instagram?: string | null;
}

const brl = (cents: number) =>
  ((cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Base dos LINKS QUE A CLIENTE RECEBE (cobrança/pagamento). O domínio oficial
// é www.lurdsplussize.com.br — o console pode estar rodando na vercel.app
// (app desktop), então NUNCA usar window.location.origin pra link de cliente.
// Em localhost (dev/preview) mantém o origin pra testar.
const publicBase = () =>
  typeof window !== 'undefined' && /localhost|127\.0\.0\.1/.test(window.location.hostname)
    ? window.location.origin
    : 'https://www.lurdsplussize.com.br';

const STATUS_LABEL: Record<string, string> = {
  open: 'Aberto',
  awaiting_payment: 'Aguardando pagamento',
  reserved: 'Reservado',
  paid: 'Pago',
  separating: 'Separação',
  shipped: 'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
  expired: 'Expirado',
};

const STATUS_PILL: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  awaiting_payment: 'bg-blue-100 text-blue-700',
  paid: 'bg-emerald-100 text-emerald-700',
  separating: 'bg-violet-100 text-violet-700',
  shipped: 'bg-slate-200 text-slate-700',
  delivered: 'bg-emerald-100 text-emerald-700',
};

/* ─── Grade (matriz cor × tamanho) ─── */
const SIZE_LETTER_ORDER = [
  'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG',
  'XXG', 'XXGG', '2G', '3G', '4G', '5G', '6G',
  'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7',
];
function sortSizes(a: string, b: string): number {
  const ua = (a || '').toUpperCase().trim();
  const ub = (b || '').toUpperCase().trim();
  const ai = SIZE_LETTER_ORDER.indexOf(ua);
  const bi = SIZE_LETTER_ORDER.indexOf(ub);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  const na = Number(ua);
  const nb = Number(ub);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return ua.localeCompare(ub);
}
function buildGrade(product: GradeResult) {
  const cells = product.cells || [];
  const sizeSet = new Set<string>();
  const colorSet = new Set<string>();
  const cellByKey = new Map<string, GradeCell>();
  const totalsByColor = new Map<string, number>();
  const totalsBySize = new Map<string, number>();
  for (const c of cells) {
    const cor = (c.cor || '—').trim();
    const tam = (c.tamanho || '—').trim();
    colorSet.add(cor);
    sizeSet.add(tam);
    cellByKey.set(`${cor}|${tam}`, c);
    totalsByColor.set(cor, (totalsByColor.get(cor) || 0) + c.available);
    totalsBySize.set(tam, (totalsBySize.get(tam) || 0) + c.available);
  }
  const sizes = Array.from(sizeSet).sort(sortSizes);
  const colors = Array.from(colorSet).sort((a, b) => {
    const ta = totalsByColor.get(a) || 0;
    const tb = totalsByColor.get(b) || 0;
    if (ta !== tb) return tb - ta;
    return a.localeCompare(b);
  });
  return { sizes, colors, cellByKey, totalsByColor, totalsBySize };
}

export default function LivePdvPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('');
  const [sessionStoreName, setSessionStoreName] = useState('');
  const [activeLive, setActiveLive] = useState<{ id: string; title: string; storeName?: string } | null>(null);
  // Modal "nova live": título + LOJA ANFITRIÃ (obrigatório escolher — antes o
  // backend caía num padrão fixo e toda live saía como Anália Franco).
  const [newLiveOpen, setNewLiveOpen] = useState(false);
  const [newLiveTitle, setNewLiveTitle] = useState('');
  const [newLiveStore, setNewLiveStore] = useState('');
  const [newLiveStores, setNewLiveStores] = useState<Array<{ code: string; name: string }>>([]);
  const [creatingLive, setCreatingLive] = useState(false);
  // Trocar a loja anfitriã da live ABERTA (live criada com a loja errada,
  // sem precisar fechar — pedido do dono 07/07).
  const [swapStoreOpen, setSwapStoreOpen] = useState(false);
  const [swapStoreCode, setSwapStoreCode] = useState('');
  const [swapStores, setSwapStores] = useState<Array<{ code: string; name: string }>>([]);
  const [swappingStore, setSwappingStore] = useState(false);
  // "Cobrar todas": fila semi-automática de cobrança em massa. Pra cada cliente
  // copia a mensagem com o link /p/ dela e abre Direct (colar) ou WhatsApp
  // (já vai preenchido). O Instagram não permite DM automática sem ManyChat API.
  const [chargeAllOpen, setChargeAllOpen] = useState(false);
  const [chargeAllDone, setChargeAllDone] = useState<Record<string, boolean>>({});
  const [sendingDm, setSendingDm] = useState(false);
  const [dmResult, setDmResult] = useState<string | null>(null);
  // Liberação da separação (pós-pagamento): operadora confere os dados e envia
  const [releasing, setReleasing] = useState(false);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<'console' | 'dashboard'>('console');
  // Legenda da Live — atalhos curtos (01, 02...) → referência completa
  const [showLegenda, setShowLegenda] = useState(false);

  // Busca / grade
  const [term, setTerm] = useState('');
  const [product, setProduct] = useState<GradeResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [promoEditing, setPromoEditing] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const [cupomEditing, setCupomEditing] = useState(false);
  const [cupomInput, setCupomInput] = useState('20,00');
  const searchRef = useRef<HTMLInputElement>(null);

  // Cliente / carrinho
  const [activeCustomer, setActiveCustomer] = useState<ActiveCustomer | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [carts, setCarts] = useState<Cart[]>([]);
  const [clientFilter, setClientFilter] = useState(''); // busca de cliente por nome/@ na lista
  // Despoluição da grade: por padrão só quem TEM PEÇAS; vazios ficam atrás
  // de um chip (cliente puxada da fila que ainda não comprou = R$0 · 0 itens).
  const [cartView, setCartView] = useState<'pecas' | 'vazios' | 'todos'>('pecas');
  const [clearingEmpty, setClearingEmpty] = useState(false);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [pendingCell, setPendingCell] = useState<GradeCell | null>(null);
  // Aviso rápido "adicionado a Fulana" após fechar o carrinho.
  const [addedFlash, setAddedFlash] = useState<string | null>(null);
  // Aviso âmbar "QR da Fulana venceu" (cobrança resetada pelo backend).
  const [expiredFlash, setExpiredFlash] = useState<string | null>(null);
  const [editCustomerOpen, setEditCustomerOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  // Pagamento
  const [qr, setQr] = useState<{ text: string; img: string; valor: number; link?: string } | null>(null);
  const [paying, setPaying] = useState(false);
  // Cobrança pendente: ao clicar em cobrar, abre o cadastro (com endereço) e só
  // gera o PIX/link depois de salvar. null = nenhuma cobrança em andamento.
  const [pendingPay, setPendingPay] = useState<'pix' | 'link' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [paid, setPaid] = useState(false);

  // ─── Boot: NÃO adota live automaticamente ─────────────────────────────────
  // Se existir uma live aberta, guarda em `activeLive` e a tela inicial oferece
  // "Continuar" ou "Abrir nova" (que fecha a atual). Evita que carrinhos de uma
  // live antiga apareçam numa live nova.
  useEffect(() => {
    (async () => {
      try {
        const list = await api<any[]>('/live-pdv/sessions');
        const live = (list || []).find((s) => s.status === 'live');
        if (live) setActiveLive({ id: live.id, title: live.title, storeName: live.liveStoreName || '' });
      } catch {}
      setBooting(false);
    })();
  }, []);

  const refreshCarts = useCallback(async () => {
    if (!sessionId) return;
    try {
      const cs = await api<Cart[]>(`/live-pdv/sessions/${sessionId}/carts`);
      setCarts(cs || []);
    } catch {}
  }, [sessionId]);

  useEffect(() => {
    refreshCarts();
  }, [refreshCarts]);

  // Cadastradas pelo link do ManyChat (origem 'live', 24h) que ainda não têm
  // carrinho nesta sessão — a fila de "aguardando" que a apresentadora puxa.
  const [pendingRegs, setPendingRegs] = useState<
    Array<{ customerId: string; name: string | null; phone: string | null; instagram: string | null; createdAt: string }>
  >([]);
  const [pullingId, setPullingId] = useState<string | null>(null);
  const refreshPending = useCallback(async () => {
    if (!sessionId) { setPendingRegs([]); return; }
    try {
      const r = await api<any[]>(`/live-pdv/sessions/${sessionId}/pending-registrations`);
      setPendingRegs(r || []);
    } catch {}
  }, [sessionId]);
  useEffect(() => { refreshPending(); }, [refreshPending]);
  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(refreshPending, 30000); // novas cadastradas chegam durante a live
    return () => clearInterval(t);
  }, [sessionId, refreshPending]);
  async function pullRegisteredCustomer(customerId: string) {
    if (!sessionId || pullingId) return;
    setPullingId(customerId);
    try {
      await api(`/live-pdv/sessions/${sessionId}/add-customer`, {
        method: 'POST',
        body: JSON.stringify({ customerId }),
      });
      await refreshCarts();
      await refreshPending();
    } catch {
      alert('Não consegui puxar a cliente agora. Tenta de novo.');
    } finally {
      setPullingId(null);
    }
  }

  // Loja da sessão usa PIX externo? (franquia sem gateway Pagar.me/PagBank)
  // → esconde "Cobrar PIX/Link" e mostra confirmação manual "pagou por fora".
  // Descobre a loja pela sessão e consulta o pixProvider. Erro → não-externo.
  const [pixExterno, setPixExterno] = useState(false);
  useEffect(() => {
    if (!sessionId) { setPixExterno(false); return; }
    let alive = true;
    (async () => {
      try {
        const sessions = await api<any[]>('/live-pdv/sessions');
        const s = (sessions || []).find((x: any) => x.id === sessionId);
        const code = s?.liveStoreCode;
        if (!code) return;
        const cfg = await api<{ provider?: string }>(`/stores/by-code/${code}/pix-provider`);
        if (alive) setPixExterno(cfg?.provider === 'externo');
      } catch { /* mantém não-externo */ }
    })();
    return () => { alive = false; };
  }, [sessionId]);

  // Ref do carrinho aberto — pros handlers de socket enxergarem o atual sem
  // re-registrar listener a cada mudança de carrinho.
  const cartOpenRef = useRef<Cart | null>(null);
  useEffect(() => { cartOpenRef.current = cart; }, [cart]);

  // Realtime: atualiza listas quando algo muda.
  // (02/07) Endurecido pra live: entra na sala 'live-pdv-ops' (push chega
  // pra QUALQUER login, não só admin), re-entra e recarrega ao RECONECTAR
  // (wi-fi piscou ≠ lista congelada), trata QR vencido, e mantém um refresh
  // de segurança a cada 90s — 1 request bounded, nada a ver com o polling
  // antigo que empilhava.
  useEffect(() => {
    if (!sessionId) return;
    const socket = getSocket();
    const onChange = () => refreshCarts();

    // QR venceu (backend resetou a cobrança): atualiza lista, avisa, e se o
    // carrinho está ABERTO na tela, tira o QR morto da frente da operadora.
    const onChargeExpired = async (p: any) => {
      refreshCarts();
      setExpiredFlash(p?.customerName || 'cliente');
      setTimeout(() => setExpiredFlash(null), 6000);
      const aberto = cartOpenRef.current;
      if (p?.cartId && aberto?.id === p.cartId) {
        try {
          const fresh = await api<Cart>(`/live-pdv/carts/${p.cartId}`);
          setCart(fresh);
          if (fresh.status === 'open') { setQr(null); setPaid(false); }
        } catch { /* lista já atualizou */ }
      }
    };

    // Entra na sala da live (e re-entra a cada reconexão do socket).
    const join = () => socket.emit('live-pdv:join');
    const onConnect = () => {
      join();
      refreshCarts(); // recupera eventos perdidos enquanto esteve offline
    };
    if (socket.connected) join();
    socket.on('connect', onConnect);

    socket.on('live-pdv:cart-paid', onChange);
    socket.on('live-pdv:cart-updated', onChange);
    socket.on('live-pdv:reservations-expired', onChange);
    socket.on('live-pdv:item-shipped', onChange);
    socket.on('live-pdv:promo', onChange);
    socket.on('live-pdv:charge-expired', onChargeExpired);

    // Cinto de segurança: se socket E webhook falharem, a lista ainda
    // atualiza sozinha a cada 90s.
    const safety = setInterval(() => refreshCarts(), 90_000);

    return () => {
      socket.off('connect', onConnect);
      socket.off('live-pdv:cart-paid', onChange);
      socket.off('live-pdv:cart-updated', onChange);
      socket.off('live-pdv:reservations-expired', onChange);
      socket.off('live-pdv:item-shipped', onChange);
      socket.off('live-pdv:promo', onChange);
      socket.off('live-pdv:charge-expired', onChargeExpired);
      clearInterval(safety);
    };
  }, [sessionId, refreshCarts]);

  async function createSession() {
    if (
      activeLive &&
      !confirm(
        `Abrir uma nova live vai FECHAR a live atual "${activeLive.title}".\n\n` +
          `Os carrinhos dela ficam guardados (não somem), só saem da tela. Continuar?`,
      )
    )
      return;
    // Abre o modal (título + loja anfitriã). A loja do login vem pré-selecionada.
    setNewLiveTitle(`Live ${new Date().toLocaleDateString('pt-BR')}`);
    setNewLiveOpen(true);
    try {
      const [stores, me] = await Promise.all([
        api<any[]>('/stores').catch(() => [] as any[]),
        api<any>('/auth/me').catch(() => null),
      ]);
      const act = (stores || [])
        .filter((s: any) => s.active !== false)
        .map((s: any) => ({ code: String(s.code), name: String(s.name) }));
      setNewLiveStores(act);
      const mine = me?.storeCode && act.some((s: any) => s.code === String(me.storeCode))
        ? String(me.storeCode)
        : '';
      setNewLiveStore(mine || act[0]?.code || '');
    } catch { /* sem lista — o backend usa a loja padrão */ }
  }

  async function confirmCreateLive() {
    if (creatingLive) return;
    if (!newLiveStore && newLiveStores.length > 0) {
      alert('Escolha a loja anfitriã da live.');
      return;
    }
    setCreatingLive(true);
    try {
      const s = await api<any>('/live-pdv/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: newLiveTitle.trim() || undefined,
          liveStoreCode: newLiveStore || undefined,
        }),
      });
      setActiveLive(null);
      setSessionId(s.id);
      setSessionTitle(s.title);
      setSessionStoreName(s.liveStoreName || '');
      setNewLiveOpen(false);
    } catch (e: any) {
      alert('Erro ao criar sessão: ' + (e?.message || e));
    } finally {
      setCreatingLive(false);
    }
  }

  // Envia o carrinho PAGO pra separação nas lojas de origem. Se o endereço
  // estiver incompleto, o backend recusa com a lista do que falta — aí a gente
  // abre o "Editar cliente" já no endereço pra operadora completar.
  async function releaseSeparation() {
    if (!cart || releasing) return;
    setReleasing(true);
    try {
      const fresh = await api<Cart>(`/live-pdv/carts/${cart.id}/release-separation`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setCart(fresh);
      await refreshCarts();
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Não consegui enviar pra separação.';
      try {
        const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch { /* mensagem crua */ }
      alert(msg);
      // Falta endereço → abre o cadastro direto pra completar
      if (/endereço|CEP|rua|número|cidade|UF/i.test(msg)) setEditCustomerOpen(true);
    } finally {
      setReleasing(false);
    }
  }

  // Envio AUTOMÁTICO em massa via ManyChat (DM direto, sem colar nada).
  // Quem não tem vínculo ManyChat volta em "skipped" → fila manual abaixo.
  async function sendAllDm() {
    if (!sessionId || sendingDm) return;
    setSendingDm(true);
    setDmResult(null);
    try {
      const r = await api<{
        sent: Array<{ cartId: string; customerName: string }>;
        skipped: Array<{ cartId: string; customerName: string; reason: string }>;
      }>(`/live-pdv/sessions/${sessionId}/charge-all-dm`, { method: 'POST', body: JSON.stringify({}) });
      const jaEnviadas = r.skipped.filter((s) => /já enviada/i.test(s.reason));
      setChargeAllDone((s) => {
        const n = { ...s };
        for (const it of r.sent) n[it.cartId] = true;
        for (const it of jaEnviadas) n[it.cartId] = true; // recebeu antes — não repete
        return n;
      });
      const manuais = r.skipped.filter((s) => !/vazio|já enviada/i.test(s.reason));
      setDmResult(
        `✓ ${r.sent.length} enviada${r.sent.length === 1 ? '' : 's'} automático` +
          (jaEnviadas.length ? ` · ${jaEnviadas.length} já tinham recebido (não repete)` : '') +
          (manuais.length
            ? ` · ${manuais.length} pra enviar manual: ${manuais.map((s) => s.customerName).slice(0, 5).join(', ')}${manuais.length > 5 ? '…' : ''}`
            : ''),
      );
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Falha no envio automático.';
      try {
        const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch { /* mensagem crua */ }
      setDmResult(`⚠️ ${msg}`);
    } finally {
      setSendingDm(false);
    }
  }

  // Estado do envio WhatsApp por carrinho — feedback visual + trava de
  // duplo clique (sem isso o sucesso era silencioso e cada clique reenviava).
  const [whatsState, setWhatsState] = useState<Record<string, 'sending' | 'sent' | undefined>>({});

  // Cobra UMA cliente da fila: Direct abre o perfil (colar Ctrl+V);
  // WhatsApp dispara DIRETO pela API do ManyChat (template aprovado — chega
  // sozinho, sem abrir app). Se a API falhar, cai no wa.me como plano B.
  async function chargeOne(c: Cart, canal: 'direct' | 'whats') {
    const link = c.payCode
      ? `${publicBase()}/p/${c.payCode}`
      : `${publicBase()}/pagar/${c.id}`;
    const first = (c.customerName || '').trim().split(/\s+/)[0] || 'cliente';
    const msg = `Oi, ${first}! 💜 Suas peças da live deram ${brl(c.totalCents)} + frete. Fecha sua compra aqui: ${link}`;
    if (canal === 'direct' && c.customerInstagram) {
      navigator.clipboard?.writeText(msg);
      window.open(
        `https://www.instagram.com/${String(c.customerInstagram).replace(/^@/, '')}/`,
        '_blank',
        'noopener,noreferrer',
      );
    } else if (canal === 'whats' && c.customerPhone) {
      if (whatsState[c.id] === 'sending') return; // trava duplo clique
      if (whatsState[c.id] === 'sent' && !confirm(`Já foi enviado o WhatsApp pra ${c.customerName}. Enviar DE NOVO?`)) {
        return;
      }
      setWhatsState((s) => ({ ...s, [c.id]: 'sending' }));
      try {
        await api(`/live-pdv/carts/${c.id}/cobranca-whats`, { method: 'POST', body: JSON.stringify({}) });
        setWhatsState((s) => ({ ...s, [c.id]: 'sent' }));
      } catch (e: any) {
        setWhatsState((s) => ({ ...s, [c.id]: undefined }));
        // API indisponível/recusou → plano B: wa.me manual (comportamento antigo)
        const raw = String(e?.message || '');
        let m = 'ManyChat indisponível';
        try {
          const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
          if (j?.message) m = Array.isArray(j.message) ? j.message[0] : j.message;
        } catch { /* cru */ }
        alert(`Não consegui enviar pela API (${m}).\nAbrindo o WhatsApp manual como plano B — a mensagem já está copiada.`);
        navigator.clipboard?.writeText(msg);
        const d = String(c.customerPhone).replace(/\D/g, '');
        window.open(`https://wa.me/55${d}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener,noreferrer');
      }
    }
    setChargeAllDone((s) => ({ ...s, [c.id]: true }));
    // Carimba no servidor — o ✓ aparece nos outros PCs também
    api(`/live-pdv/carts/${c.id}/mark-charged`, { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
  }

  // "JÁ PAGOU por fora" direto na fila: vira PAGO → SAI da lista de cobrança
  // (pedido do dono 09/07: cliente que pagou no PIX da loja era recobrada).
  const [payingExternal, setPayingExternal] = useState<Record<string, boolean>>({});
  async function markPaidExternal(c: Cart) {
    if (payingExternal[c.id]) return;
    if (
      !confirm(
        `Confirmar que ${c.customerName} JÁ PAGOU (${brl(c.totalCents)}) por fora?\n\n` +
          'O carrinho vira PAGO, sai da cobrança e entra no fluxo de separação.',
      )
    )
      return;
    setPayingExternal((s) => ({ ...s, [c.id]: true }));
    try {
      await api(`/live-pdv/carts/${c.id}/pay-external`, { method: 'POST', body: JSON.stringify({}) });
      await refreshCarts();
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Erro ao marcar pago.';
      try {
        const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch { /* cru */ }
      alert(msg);
    } finally {
      setPayingExternal((s) => ({ ...s, [c.id]: false }));
    }
  }

  // Cobra UMA cliente automático via ManyChat (DM direto, chega com Insta fechado)
  const [dmOneSending, setDmOneSending] = useState<Record<string, boolean>>({});
  async function chargeOneDm(c: Cart) {
    if (dmOneSending[c.id]) return;
    setDmOneSending((s) => ({ ...s, [c.id]: true }));
    try {
      await api(`/live-pdv/carts/${c.id}/charge-dm`, { method: 'POST', body: JSON.stringify({}) });
      setChargeAllDone((s) => ({ ...s, [c.id]: true }));
      setDmResult(`✓ DM enviada pra ${c.customerName}`);
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Falha no envio da DM.';
      try {
        const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch { /* mensagem crua */ }
      setDmResult(`⚠️ ${c.customerName}: ${msg}`);
    } finally {
      setDmOneSending((s) => ({ ...s, [c.id]: false }));
    }
  }

  async function openSwapStore() {
    setSwapStoreOpen(true);
    try {
      const stores = await api<any[]>('/stores');
      const act = (stores || [])
        .filter((s: any) => s.active !== false)
        .map((s: any) => ({ code: String(s.code), name: String(s.name) }));
      setSwapStores(act);
      setSwapStoreCode(act[0]?.code || '');
    } catch { setSwapStores([]); }
  }

  async function confirmSwapStore() {
    if (!sessionId || !swapStoreCode || swappingStore) return;
    setSwappingStore(true);
    try {
      const s = await api<any>(`/live-pdv/sessions/${sessionId}/store`, {
        method: 'POST',
        body: JSON.stringify({ storeCode: swapStoreCode }),
      });
      setSessionStoreName(s.liveStoreName || '');
      setSwapStoreOpen(false);
    } catch (e: any) {
      alert(e?.message || 'Erro ao trocar a loja da live');
    } finally {
      setSwappingStore(false);
    }
  }

  // Continua a live que já estava aberta (sem fechar nada).
  function continueLive() {
    if (!activeLive) return;
    setSessionId(activeLive.id);
    setSessionTitle(activeLive.title);
    setSessionStoreName(activeLive.storeName || '');
  }

  // Fecha a live atual: guarda os carrinhos na sessão (não apaga) e volta pra
  // tela inicial, liberando pra abrir uma nova.
  async function closeLive() {
    if (!sessionId) return;
    if (
      !confirm(
        `Fechar a live "${sessionTitle}"?\n\n` +
          `Os carrinhos ficam guardados nesta live, mas ela sai da tela. ` +
          `Você pode abrir uma nova live depois.`,
      )
    )
      return;
    try {
      await api(`/live-pdv/sessions/${sessionId}/end`, { method: 'POST' });
      setSessionId(null);
      setSessionTitle('');
      setActiveLive(null);
      setCart(null);
      setProduct(null);
    } catch (e: any) {
      alert('Erro ao fechar live: ' + (e?.message || e));
    }
  }

  // ─── Preço promocional da live ──────────────────────────────────────────────
  async function applyPromo() {
    if (!sessionId || !product?.ref) return;
    const reais = parseFloat(promoInput.replace(',', '.'));
    if (isNaN(reais) || reais <= 0) {
      alert('Informe um preço promocional válido.');
      return;
    }
    try {
      await api(`/live-pdv/sessions/${sessionId}/promo`, {
        method: 'POST',
        body: JSON.stringify({ refCode: product.ref, priceCents: Math.round(reais * 100) }),
      });
      setPromoEditing(false);
      await doSearch();
      await refreshCarts();
      await syncOpenCartAfterPriceChange();
    } catch (e: any) {
      alert('Erro ao aplicar promo: ' + (e?.message || e));
    }
  }

  async function removePromo() {
    if (!sessionId || !product?.ref) return;
    try {
      await api(`/live-pdv/sessions/${sessionId}/promo`, {
        method: 'POST',
        body: JSON.stringify({ refCode: product.ref, priceCents: 0 }),
      });
      setPromoEditing(false);
      await doSearch();
      await refreshCarts();
      await syncOpenCartAfterPriceChange();
    } catch (e: any) {
      alert('Erro ao remover promo: ' + (e?.message || e));
    }
  }

  // Preço ORIGINAL (base) — referência pros descontos rápidos. Quando já tem
  // promo ativa, usa o basePriceCents (o riscado); senão o preço atual.
  function baseCents(): number {
    if (!product) return 0;
    return product.basePriceCents || product.priceCents || 0;
  }

  // Grava um preço final (centavos) como promo da live — usado pelos atalhos
  // "50% OFF" e "Cupom relâmpago". Mesmo endpoint do applyPromo.
  async function setPromoCents(cents: number) {
    if (!sessionId || !product?.ref) return;
    const safe = Math.max(0, Math.round(cents));
    const full = product.basePriceCents || product.priceCents || 0;
    try {
      await api(`/live-pdv/sessions/${sessionId}/promo`, {
        method: 'POST',
        body: JSON.stringify({ refCode: product.ref, priceCents: safe }),
      });
      setPromoEditing(false);
      setCupomEditing(false);
      // Atualiza o preço NA TELA imediatamente — NÃO depende do doSearch (que
      // por sua vez exige o termo ainda estar no campo de busca). Sem isso, o
      // desconto "não abatia" quando o campo de busca já tinha sido limpo.
      setProduct((p) =>
        p
          ? {
              ...p,
              priceCents: safe,
              basePriceCents: p.basePriceCents || p.priceCents,
              promoActive: safe > 0 && safe < full,
              cells: (p.cells || []).map((c) => ({ ...c, priceCents: safe })),
            }
          : p,
      );
      await refreshCarts();
      await syncOpenCartAfterPriceChange();
    } catch (e: any) {
      alert('Erro ao aplicar desconto: ' + (e?.message || e));
    }
  }

  // 50% sobre o preço ORIGINAL.
  function applyMetade() {
    const base = baseCents();
    if (!base) return;
    setPromoCents(Math.round(base / 2));
  }

  // Cupom relâmpago: desconta R$ X do preço ORIGINAL.
  function applyCupom() {
    const base = baseCents();
    const off = parseFloat(cupomInput.replace(',', '.'));
    if (isNaN(off) || off <= 0) {
      alert('Informe o valor do cupom em reais (ex: 20,00).');
      return;
    }
    const offCents = Math.round(off * 100);
    if (offCents >= base) {
      alert('O desconto não pode ser maior ou igual ao preço.');
      return;
    }
    setPromoCents(base - offCents);
  }

  // ─── Frete pelo CEP ──────────────────────────────────────────────────────
  // SP (CEP 01000-19999) = SEDEX R$ 9,99; qualquer outro estado = PAC R$ 19,99.
  async function calcFrete() {
    if (!cart) return;
    // Se o carrinho ainda não tem CEP, pergunta na hora (e o backend salva).
    let cep = (cart.customerCep || '').replace(/\D/g, '');
    if (cep.length !== 8) {
      const typed = prompt('CEP da cliente (pra calcular o frete):', '');
      if (typed === null) return;
      cep = typed.replace(/\D/g, '');
      if (cep.length !== 8) {
        alert('CEP inválido — precisa ter 8 dígitos.');
        return;
      }
    }
    try {
      const res = await api<Cart & { freteServico?: string }>(
        `/live-pdv/carts/${cart.id}/frete/auto`,
        { method: 'POST', body: JSON.stringify({ cep }) },
      );
      setCart(res);
      setQr(null);
      setPaid(false);
    } catch (e: any) {
      alert('Não deu pra calcular o frete: ' + (e?.message || e));
    }
  }

  // Após mudar preço (promo), ressincroniza o carrinho aberto e descarta um
  // PIX/link antigo (o backend já o invalidou quando o total mudou).
  async function syncOpenCartAfterPriceChange() {
    if (!cart) return;
    try {
      const fresh = await api<Cart>(`/live-pdv/carts/${cart.id}`);
      setCart(fresh);
    } catch {}
    setQr(null);
    setPaid(false);
  }

  // ─── Histórico de REFs buscadas (rollback) ────────────────────────────────
  // Toda busca que ACHA produto entra aqui (dedup, mais recente primeiro,
  // máx 30). Persiste por PC no localStorage — sobrevive a reload no meio da
  // live. O dropdown ao lado da busca permite reabrir a grade em 1 clique
  // quando a cliente "volta" numa peça mostrada minutos atrás.
  const [refHistory, setRefHistory] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem('lurds_live_ref_history');
      if (raw) setRefHistory(JSON.parse(raw));
    } catch {}
  }, []);
  function pushRefHistory(q: string) {
    const clean = q.trim().toUpperCase();
    if (!clean) return;
    setRefHistory((prev) => {
      const next = [clean, ...prev.filter((r) => r !== clean)].slice(0, 30);
      try { localStorage.setItem('lurds_live_ref_history', JSON.stringify(next)); } catch {}
      return next;
    });
  }

  // ─── Busca ────────────────────────────────────────────────────────────────
  async function runSearch(q: string) {
    if (!q) return;
    setSearching(true);
    setProduct(null);
    setPromoEditing(false);
    setHistoryOpen(false);
    try {
      const sid = sessionId ? `&sessionId=${sessionId}` : '';
      // Timeout de 12s: se o Giga estiver lento, NÃO deixa o spinner girando pra
      // sempre — avisa e libera a tela pra tentar de novo.
      const res = await Promise.race([
        api<GradeResult>(`/live-pdv/search?term=${encodeURIComponent(q)}${sid}`),
        new Promise<GradeResult>((_, reject) =>
          setTimeout(() => reject(new Error('__timeout__')), 12000),
        ),
      ]);
      setProduct(res);
      if (res?.found) pushRefHistory(res.ref || q);
    } catch (err: any) {
      if (err?.message === '__timeout__') {
        setProduct(null);
        alert('A busca demorou demais (o Giga pode estar lento). Tente de novo.');
      } else {
        setProduct({ found: false });
      }
    } finally {
      setSearching(false);
    }
  }

  async function doSearch(e?: React.FormEvent) {
    e?.preventDefault();
    await runSearch(term.trim());
  }

  // Botão "Atualizar estoque": força o refresh pontual no Giga (só os códigos
  // desta peça) e re-renderiza a grade fresca. Nunca trava: o backend devolve
  // a grade do espelho se o Giga não responder em 8s.
  const [refreshingStock, setRefreshingStock] = useState(false);
  async function refreshStock() {
    const q = (product?.ref || term).trim();
    if (!q || refreshingStock) return;
    setRefreshingStock(true);
    try {
      const res = await api<GradeResult>(`/live-pdv/search/refresh-stock`, {
        method: 'POST',
        body: JSON.stringify({ term: q, sessionId }),
      });
      setProduct(res);
    } catch {
      alert('Não consegui atualizar agora (Giga lento?). A grade continua a do espelho.');
    } finally {
      setRefreshingStock(false);
    }
  }

  /** Rollback: clica numa REF do histórico → preenche a busca e reabre a grade. */
  function searchFromHistory(refCode: string) {
    setTerm(refCode);
    void runSearch(refCode);
  }

  // ─── Clique na grade ──────────────────────────────────────────────────────
  // Fecha o carrinho depois de adicionar — evita jogar a próxima peça no
  // carrinho errado. A peça já ficou salva no carrinho da cliente (aparece na
  // lista CLIENTES DA LIVE). Mostra um aviso rápido e foca a busca.
  function closeAfterAdd(name?: string | null) {
    setActiveCustomer(null);
    setCart(null);
    setQr(null);
    setPaid(false);
    if (name) {
      setAddedFlash(name);
      setTimeout(() => setAddedFlash(null), 2600);
    }
    searchRef.current?.focus();
  }

  async function clickCell(cell: GradeCell) {
    if (cell.available <= 0) return;
    if (!sessionId) {
      alert('Crie/abra uma sessão de live primeiro.');
      return;
    }
    if (!activeCustomer) {
      setPendingCell(cell);
      setShowCustomerModal(true);
      return;
    }
    await addItem(cell);
  }

  async function addItem(cell: GradeCell) {
    if (!sessionId || !product?.ref) return;
    setAdding(cell.itemKey);
    try {
      const body: any = {
        refCode: cell.ref || product.ref,
        cor: cell.cor,
        tamanho: cell.tamanho,
        qty: 1,
      };
      if (cart && ['open', 'awaiting_payment'].includes(cart.status)) {
        body.cartId = cart.id;
      } else if (activeCustomer) {
        body.customer = {
          id: activeCustomer.id,
          name: activeCustomer.name,
          phone: activeCustomer.phone,
          instagram: activeCustomer.instagram,
        };
      }
      const res = await api<{ cart: Cart }>(`/live-pdv/sessions/${sessionId}/items`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setCart(res.cart);
      setQr(null);
      setPaid(false);
      await doSearch(); // atualiza estoque exibido
      await refreshCarts();
      closeAfterAdd(res.cart?.customerName); // fecha o carrinho por segurança
    } catch (e: any) {
      alert(e?.message || 'Erro ao adicionar');
    } finally {
      setAdding(null);
    }
  }

  async function saveCustomerAndAdd(form: {
    name: string;
    phone: string;
    instagram: string;
    cpf: string;
    email: string;
  }) {
    try {
      const c = await api<ActiveCustomer>('/live-pdv/customers/quick', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setActiveCustomer(c);
      setCart(null);
      setShowCustomerModal(false);
      const cell = pendingCell;
      setPendingCell(null);
      if (cell) {
        // addItem precisa do customer atualizado
        setTimeout(() => addItemWith(c, cell), 0);
      }
    } catch (e: any) {
      alert(e?.message || 'Erro ao salvar cliente');
    }
  }

  async function addItemWith(customer: ActiveCustomer, cell: GradeCell) {
    if (!sessionId || !product?.ref) return;
    setAdding(cell.itemKey);
    try {
      const res = await api<{ cart: Cart }>(`/live-pdv/sessions/${sessionId}/items`, {
        method: 'POST',
        body: JSON.stringify({
          customer: {
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            instagram: customer.instagram,
          },
          refCode: cell.ref || product.ref,
          cor: cell.cor,
          tamanho: cell.tamanho,
          qty: 1,
        }),
      });
      setCart(res.cart);
      await doSearch();
      await refreshCarts();
      closeAfterAdd(res.cart?.customerName); // fecha o carrinho por segurança
    } catch (e: any) {
      alert(e?.message || 'Erro ao adicionar');
    } finally {
      setAdding(null);
    }
  }

  // Verificador de @: a operadora escolheu USAR um carrinho já existente (mesma
  // @) em vez de criar outro — abre ele e adiciona a peça pendente nele.
  function handleUseExisting(existing: Cart) {
    setShowCustomerModal(false);
    const cell = pendingCell;
    setPendingCell(null);
    openCart(existing);
    if (cell) setTimeout(() => addItemToCart(existing, cell), 0);
  }

  async function addItemToCart(targetCart: Cart, cell: GradeCell) {
    if (!sessionId || !product?.ref) return;
    setAdding(cell.itemKey);
    try {
      const res = await api<{ cart: Cart }>(`/live-pdv/sessions/${sessionId}/items`, {
        method: 'POST',
        body: JSON.stringify({
          cartId: targetCart.id,
          refCode: cell.ref || product.ref,
          cor: cell.cor,
          tamanho: cell.tamanho,
          qty: 1,
        }),
      });
      setCart(res.cart);
      await doSearch();
      await refreshCarts();
      closeAfterAdd(res.cart?.customerName);
    } catch (e: any) {
      alert(e?.message || 'Erro ao adicionar');
    } finally {
      setAdding(null);
    }
  }

  function newClient() {
    setActiveCustomer(null);
    setCart(null);
    setQr(null);
    setPaid(false);
    searchRef.current?.focus();
  }

  // Exclui (cancela) o carrinho da cliente — libera as reservas
  async function deleteCart() {
    if (!cart) return;
    if (!confirm(`Excluir o carrinho de ${cart.customerName}? As peças reservadas serão liberadas.`)) return;
    try {
      await api(`/live-pdv/carts/${cart.id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      newClient();
      await refreshCarts();
      await doSearch(); // atualiza estoque (reservas liberadas)
    } catch (e: any) {
      alert('Erro ao excluir: ' + (e?.message || e));
    }
  }

  // Exclui (cancela) o carrinho de uma cliente direto pela lista, sem precisar
  // abri-la antes. Mesmo endpoint do deleteCart. Libera as reservas.
  async function deleteCartFromList(c: Cart) {
    if (!confirm(`Excluir a cliente ${c.customerName} da live? As peças reservadas serão liberadas.`)) return;
    try {
      await api(`/live-pdv/carts/${c.id}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      if (cart?.id === c.id) newClient(); // se era a que estava aberta no painel, limpa
      await refreshCarts();
      await doSearch(); // atualiza estoque (reservas liberadas)
    } catch (e: any) {
      alert('Erro ao excluir: ' + (e?.message || e));
    }
  }

  // Recupera carrinhos que expiraram (re-reserva os itens) e deixa por 24h.
  async function recoverCarts() {
    if (!sessionId) return;
    if (!confirm('Recuperar os carrinhos que expiraram e deixá-los reservados por 24h?')) return;
    try {
      const r = await api<{ recovered: number; carts: number }>(
        `/live-pdv/sessions/${sessionId}/recover-expired`,
        { method: 'POST', body: JSON.stringify({ ttlHours: 24 }) },
      );
      await refreshCarts();
      alert(`Recuperados ${r.recovered} item(ns) em ${r.carts} carrinho(s). Válidos por 24h.`);
    } catch (e: any) {
      alert('Erro ao recuperar: ' + (e?.message || e));
    }
  }

  function openCart(c: Cart) {
    setCart(c);
    setActiveCustomer({
      id: '',
      name: c.customerName,
      phone: c.customerPhone,
      instagram: c.customerInstagram,
    });
    // Carrinho JÁ PAGO/EM SEPARAÇÃO: mostra o banner de confirmado — nunca a
    // tela de cobrança de novo (bug: card "SEPARAÇÃO" voltava pro pagamento).
    if (['paid', 'separating', 'shipped', 'delivered'].includes(c.status)) {
      setQr(null);
      setPaid(true);
      return;
    }
    // Se a cliente tem uma cobrança PENDENTE, reabre o QR/link (dá pra mostrar
    // de novo). Senão, limpa. A confirmação de pago segue rodando via socket.
    if (c.status === 'awaiting_payment' && c.qrCodeText) {
      setQr(
        c.paymentMethod === 'link'
          ? { text: '', img: '', valor: (c.totalCents || 0) / 100, link: c.qrCodeText }
          : { text: c.qrCodeText || '', img: c.qrCodeImageUrl || '', valor: (c.totalCents || 0) / 100 },
      );
    } else {
      setQr(null);
    }
    setPaid(false);
  }

  // "Continuar atendendo": esconde a cobrança da tela (NÃO cancela) e volta o
  // foco pra busca. A cobrança segue no ar; quando pagar, a cliente vira PAGO
  // na lista sozinha (socket). Dá pra reabrir clicando na cliente de novo.
  function continueAttending() {
    setQr(null);
    setPaid(false);
    setTimeout(() => searchRef.current?.focus(), 50);
  }

  // Edita/completa o cadastro do carrinho (salva no banco + snapshot). Aceita
  // também endereço (opcional). Se veio de um clique em cobrar (pendingPay),
  // gera o PIX/link logo após salvar.
  async function saveCustomerEdit(form: {
    name: string;
    phone: string;
    instagram: string;
    cpf: string;
    email: string;
    cep?: string;
    endereco?: string;
    numero?: string;
    complemento?: string;
    bairro?: string;
    cidade?: string;
    uf?: string;
  }) {
    if (!cart) return;
    try {
      const updated = await api<Cart>(`/live-pdv/carts/${cart.id}/customer`, {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setCart(updated);
      setActiveCustomer({
        id: '',
        name: updated.customerName,
        phone: updated.customerPhone,
        instagram: updated.customerInstagram,
      });
      setEditCustomerOpen(false);
      await refreshCarts();
      // Se o cadastro foi aberto por um clique em cobrar, gera o pagamento agora.
      const pay = pendingPay;
      setPendingPay(null);
      if (pay === 'pix') await doChargePix();
      else if (pay === 'link') await doChargeLink();
    } catch (e: any) {
      alert('Erro ao salvar cliente: ' + (e?.message || e));
    }
  }

  // Edita o preço de um item (negociação na hora) — só peça ainda não paga
  async function setItemPrice(itemId: string, priceCents: number) {
    if (!cart) return;
    try {
      const updated = await api<Cart>(`/live-pdv/items/${itemId}/price`, {
        method: 'POST',
        body: JSON.stringify({ priceCents }),
      });
      setCart(updated);
      await refreshCarts();
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Erro ao alterar o preço.';
      try {
        const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch { /* mensagem crua */ }
      alert(msg);
    }
  }

  async function removeItem(itemId: string) {
    if (!cart) return;
    try {
      const updated = await api<Cart>(`/live-pdv/items/${itemId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setCart(updated);
      await doSearch();
      await refreshCarts();
    } catch (e: any) {
      alert(e?.message || 'Erro ao remover');
    }
  }

  // ─── Pagamento ────────────────────────────────────────────────────────────
  // Ao clicar em cobrar, abre o cadastro pra completar/confirmar (nome, tel,
  // endereço via CEP — tudo opcional) ANTES de gerar. saveCustomerEdit dispara
  // doChargePix/doChargeLink ao salvar.
  function startPix() {
    if (!cart) return;
    setPendingPay('pix');
    setEditCustomerOpen(true);
  }
  function startLink() {
    if (!cart) return;
    setPendingPay('link');
    setEditCustomerOpen(true);
  }

  async function doChargePix() {
    if (!cart) return;
    setPaying(true);
    try {
      const res = await api<any>(`/live-pdv/carts/${cart.id}/pay`, { method: 'POST' });
      setQr({ text: res.qrCodeText, img: res.qrCodeImageUrl, valor: res.valor });
    } catch (e: any) {
      alert('Erro ao gerar PIX: ' + (e?.message || e));
    } finally {
      setPaying(false);
    }
  }

  async function doChargeLink() {
    if (!cart) return;
    setPaying(true);
    try {
      const res = await api<any>(`/live-pdv/carts/${cart.id}/pay-link`, { method: 'POST' });
      setQr({ text: '', img: '', valor: res.valor, link: res.paymentUrl });
    } catch (e: any) {
      alert('Erro ao gerar link: ' + (e?.message || e));
    } finally {
      setPaying(false);
    }
  }

  // Confirmação MANUAL de pagamento — SEM polling. O polling automático (a cada
  // 4s/6s chamando o gateway lento) era o que inundava o backend e derrubava a
  // live. Agora a operadora clica "Confirmar pagamento" quando vê que caiu:
  // faz UMA checagem no gateway e marca pago (dispara a separação).
  async function confirmPayment() {
    if (!cart) return;
    setConfirming(true);
    try {
      const res = await api<{ paid: boolean; cart: Cart }>(
        `/live-pdv/carts/${cart.id}/payment-status`,
      );
      if (res.paid) {
        setPaid(true);
        setCart(res.cart);
        setQr(null);
        await refreshCarts();
      } else {
        alert(
          'Pagamento ainda não identificado.\n\nSe a cliente já pagou, espere alguns segundos e clique de novo.',
        );
      }
    } catch (e: any) {
      alert('Erro ao confirmar: ' + (e?.message || e));
    } finally {
      setConfirming(false);
    }
  }

  // Confirmação MANUAL pra loja com PIX externo (franquia sem gateway): a
  // cliente pagou o PIX por fora (chave da própria loja) e a operadora marca
  // pago → dispara a separação. Não consulta gateway nenhum.
  async function confirmExternalPay() {
    if (!cart) return;
    if (!window.confirm('Confirmar que a cliente PAGOU o PIX (por fora)?\n\nIsso marca o carrinho como pago e envia pra separação.')) return;
    setConfirming(true);
    try {
      const res = await api<{ paid: boolean; cart: Cart }>(
        `/live-pdv/carts/${cart.id}/pay-external`,
        { method: 'POST' },
      );
      if (res.paid) {
        setPaid(true);
        setCart(res.cart);
        setQr(null);
        await refreshCarts();
      }
    } catch (e: any) {
      alert('Erro ao confirmar: ' + (e?.message || e));
    } finally {
      setConfirming(false);
    }
  }

  // (REMOVIDO) O poll de FUNDO das cobranças pendentes foi retirado: usava
  // setInterval a cada 6s chamando o PagBank (lento); quando um ciclo demorava
  // mais que 6s, os ciclos EMPILHAVAM e multiplicavam sozinhos, inundando o
  // backend (latência crescente → derrubava a live). A confirmação de pagamento
  // volta a sair só do poll do QR aberto (bounded), abaixo.

  // ─── Render ───────────────────────────────────────────────────────────────
  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-6">
        <Zap className="h-12 w-12 text-rose-500" />
        <h1 className="text-2xl font-bold text-slate-800">Live Commerce</h1>
        {activeLive ? (
          <>
            <p className="text-slate-500">
              Tem uma live aberta: <b className="text-slate-700">{activeLive.title}</b>
              {activeLive.storeName ? <> · <b className="text-slate-700">🏬 {activeLive.storeName}</b></> : null}
            </p>
            <button
              onClick={continueLive}
              className="rounded-lg bg-slate-800 px-5 py-2.5 font-semibold text-white hover:bg-slate-900"
            >
              ▶ Continuar esta live
            </button>
            <button
              onClick={createSession}
              className="rounded-lg border border-rose-300 px-5 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50"
            >
              + Abrir nova live (fecha a atual)
            </button>
          </>
        ) : (
          <>
            <p className="text-slate-500">Nenhuma live ativa no momento.</p>
            <button
              onClick={createSession}
              className="rounded-lg bg-rose-600 px-5 py-2.5 font-semibold text-white hover:bg-rose-700"
            >
              ▶ Iniciar nova live
            </button>
          </>
        )}
        <Link href="/minha-loja" className="text-sm text-slate-400 hover:text-slate-600">
          Voltar
        </Link>

        {/* Modal NOVA LIVE: título + loja anfitriã (define PIX/separação/remessa).
            Antes era um prompt só de título e o backend caía na loja padrão fixa
            (Anália Franco) — live de Itanhaém saía com a loja errada. */}
        {newLiveOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-lg font-bold text-slate-800">
                  <Zap className="h-5 w-5 text-rose-500" /> Nova live
                </h3>
                <button
                  type="button"
                  onClick={() => setNewLiveOpen(false)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <label className="mb-3 block">
                <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">
                  Título
                </span>
                <input
                  value={newLiveTitle}
                  onChange={(e) => setNewLiveTitle(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              <label className="mb-1 block">
                <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">
                  Loja anfitriã da live *
                </span>
                <select
                  value={newLiveStore}
                  onChange={(e) => setNewLiveStore(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                >
                  {newLiveStores.length === 0 && <option value="">Carregando lojas…</option>}
                  {newLiveStores.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mb-4 text-[11px] text-slate-500">
                É a loja da venda: define o PIX (PagBank dela), a separação e a remessa.
              </p>
              <button
                type="button"
                onClick={confirmCreateLive}
                disabled={creatingLive}
                className="w-full rounded-lg bg-rose-600 py-2.5 font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {creatingLive ? 'Abrindo…' : '▶ Abrir live'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Carrinhos que já receberam cobrança saem da grade principal e vão pra
  // seção própria "EM PAGAMENTO" (pedido do dono: menos poluição na live).
  const emPagamento = carts
    .filter((c) => c.status === 'awaiting_payment')
    .sort((a, b) =>
      (a.customerName || '').localeCompare(b.customerName || '', 'pt-BR', { sensitivity: 'base' }),
    );
  // PAGAS aguardando a operadora conferir os dados e liberar a separação
  const pagasAguardando = carts
    .filter((c) => c.status === 'paid')
    .sort((a, b) =>
      (a.customerName || '').localeCompare(b.customerName || '', 'pt-BR', { sensitivity: 'base' }),
    );
  const cartsAtivos = carts.filter((c) => c.status !== 'awaiting_payment' && c.status !== 'paid');

  // Lista de clientes filtrada (por nº da comanda, nome ou @) e ordenada
  // alfabeticamente. Se a busca for só dígitos, casa o nº do carrinho.
  const clientesFiltradas = (() => {
    const q = clientFilter.trim().toLowerCase();
    const qIg = q.replace(/^@/, '');
    const qNum = q.replace(/^#/, '');
    const soDigitos = /^\d+$/.test(qNum);
    return [...cartsAtivos]
      .filter(
        (c) =>
          !q ||
          (soDigitos && String(c.cartNumber ?? '') === qNum) ||
          (c.customerName || '').toLowerCase().includes(q) ||
          (c.customerInstagram || '').toLowerCase().replace(/^@/, '').includes(qIg),
      )
      .sort((a, b) =>
        (a.customerName || '').localeCompare(b.customerName || '', 'pt-BR', { sensitivity: 'base' }),
      );
  })();

  // Partição da grade: com peças × vazios (0 itens). Busca ativa ignora o chip.
  const nComPecas = clientesFiltradas.filter((c) => (c.items?.length || 0) > 0).length;
  const nVazios = clientesFiltradas.length - nComPecas;
  const viewEfetiva: 'pecas' | 'vazios' | 'todos' = clientFilter.trim() ? 'todos' : cartView;
  const gridCarts = clientesFiltradas.filter((c) =>
    viewEfetiva === 'todos'
      ? true
      : viewEfetiva === 'pecas'
      ? (c.items?.length || 0) > 0
      : (c.items?.length || 0) === 0,
  );

  // Limpeza em massa dos carrinhos VAZIOS (0 peças = sem reserva/pagamento —
  // excluir é seguro; a cliente continua no CRM e pode ganhar carrinho novo).
  async function clearEmptyCarts() {
    const vazios = cartsAtivos.filter((c) => (c.items?.length || 0) === 0);
    if (!vazios.length || clearingEmpty) return;
    if (
      !confirm(
        `Limpar ${vazios.length} carrinho(s) VAZIO(S) da tela?\n\n` +
          'NADA é apagado: o cadastro da cliente continua salvo no CRM ' +
          '(nome, telefone, @, vínculo ManyChat) e o carrinho fica no histórico ' +
          'como cancelado. Só sai da tela da live.',
      )
    )
      return;
    setClearingEmpty(true);
    try {
      for (const c of vazios) {
        try {
          await api(`/live-pdv/carts/${c.id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason: 'carrinho vazio (limpeza em massa)' }),
          });
        } catch { /* segue os demais */ }
      }
      await refreshCarts();
    } finally {
      setClearingEmpty(false);
    }
  }

  // Carrinhos "cobráveis" em massa: abertos, com peças e ainda sem cobrança.
  const cobraveis = cartsAtivos
    .filter((c) => c.status === 'open' && (c.items?.length || 0) > 0 && (c.totalCents || 0) > 0)
    .sort((a, b) =>
      (a.customerName || '').localeCompare(b.customerName || '', 'pt-BR', { sensitivity: 'base' }),
    );
  // Cobrada = marcada neste navegador OU carimbo do servidor (dmSentAt) — o
  // carimbo sincroniza entre PCs: quem cobrou em outra máquina aparece ✓ aqui.
  const cobradas = cobraveis.filter((c) => chargeAllDone[c.id] || c.dmSentAt).length;

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Aviso rápido: peça adicionada + carrinho fechado (segurança) */}
      {addedFlash && (
        <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg">
          ✓ Adicionado a {addedFlash} · carrinho fechado
        </div>
      )}
      {/* Aviso: QR PIX venceu — cobrança voltou pra aberto (peças intactas) */}
      {expiredFlash && (
        <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-bold text-white shadow-lg">
          ⏰ QR de {expiredFlash} venceu — gere uma nova cobrança
        </div>
      )}
      {showLegenda && sessionId && (
        <LegendaModal sessionId={sessionId} onClose={() => setShowLegenda(false)} />
      )}
      {/* Trocar a loja anfitriã da live ABERTA (sem fechar). Cobranças já
          geradas seguem confirmando na conta antiga; as novas usam a nova. */}
      {swapStoreOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-lg font-bold text-slate-800">
                🏬 Trocar loja anfitriã
              </h3>
              <button
                type="button"
                onClick={() => setSwapStoreOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-3 text-xs text-slate-500">
              A live continua aberta — só muda a loja da venda (PIX, separação e remessa
              das <b>próximas</b> cobranças). QRs já gerados continuam valendo.
            </p>
            <select
              value={swapStoreCode}
              onChange={(e) => setSwapStoreCode(e.target.value)}
              className="mb-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              {swapStores.length === 0 && <option value="">Carregando lojas…</option>}
              {swapStores.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={confirmSwapStore}
              disabled={swappingStore || !swapStoreCode}
              className="w-full rounded-lg bg-rose-600 py-2.5 font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {swappingStore ? 'Trocando…' : 'Trocar loja'}
            </button>
          </div>
        </div>
      )}
      {/* COBRAR TODAS — fila semi-automática de cobrança em massa */}
      {chargeAllOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-800">💰 Cobrar todas</h3>
              <button
                type="button"
                onClick={() => setChargeAllOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-2 text-xs text-slate-500">
              Cada botão <b>copia a mensagem com o link da cliente</b> e abre o canal:
              no <b>Direct</b> é só colar (Ctrl+V) e enviar; no <b>WhatsApp</b> a mensagem já vai pronta.
            </p>
            <button
              type="button"
              onClick={sendAllDm}
              disabled={sendingDm}
              title="Manda a DM sozinho (via ManyChat) pra quem se cadastrou pelo link da live"
              className="mb-2 w-full rounded-lg bg-slate-800 py-2 text-xs font-bold text-white hover:bg-slate-900 disabled:opacity-50"
            >
              {sendingDm ? 'Enviando DMs…' : '🤖 Enviar automático no Direct (ManyChat)'}
            </button>
            {dmResult && (
              <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] text-slate-600">
                {dmResult}
              </div>
            )}
            <a
              href="/retaguarda/manychat-import"
              target="_blank"
              rel="noopener noreferrer"
              className="mb-2 block text-center text-[11px] text-violet-600 underline hover:text-violet-800"
            >
              Alguém sem vínculo? Importar IDs do ManyChat (CSV) →
            </a>
            <div className="mb-2 rounded-lg bg-slate-100 px-3 py-1.5 text-center text-xs font-bold text-slate-600">
              {cobradas}/{cobraveis.length} enviadas
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
              {cobraveis.map((c) => {
                const done = !!chargeAllDone[c.id] || !!c.dmSentAt;
                return (
                  <div
                    key={c.id}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                      done ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-800">
                        {done ? '✓ ' : ''}{c.customerName}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">
                        {c.customerInstagram ? `@${c.customerInstagram}` : ''}
                        {c.customerInstagram && c.customerPhone ? ' · ' : ''}
                        {c.customerPhone || ''}
                        {' · '}
                        <b className="tabular-nums">{brl(c.totalCents)}</b>
                      </div>
                    </div>
                    {c.hasManychat && (
                      <button
                        type="button"
                        onClick={() => chargeOneDm(c)}
                        disabled={!!dmOneSending[c.id]}
                        title="Manda a DM sozinho pela API do ManyChat — chega mesmo com o Instagram fechado"
                        className="shrink-0 rounded-lg bg-slate-800 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-slate-900 disabled:opacity-50"
                      >
                        {dmOneSending[c.id] ? '…' : '🤖 Auto'}
                      </button>
                    )}
                    {c.customerInstagram && (
                      <button
                        type="button"
                        onClick={() => chargeOne(c, 'direct')}
                        title="Copia a mensagem e abre o perfil — clique em Mensagem e cole"
                        className="shrink-0 rounded-lg bg-gradient-to-r from-purple-600 to-pink-500 px-2.5 py-1.5 text-[11px] font-bold text-white hover:opacity-90"
                      >
                        Direct
                      </button>
                    )}
                    {c.customerPhone && (
                      <button
                        type="button"
                        onClick={() => chargeOne(c, 'whats')}
                        disabled={whatsState[c.id] === 'sending'}
                        title="Envia a cobrança DIRETO no WhatsApp da cliente pela API do ManyChat (template aprovado) — sem abrir app"
                        className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-white disabled:opacity-60 ${
                          whatsState[c.id] === 'sent'
                            ? 'bg-emerald-800'
                            : 'bg-emerald-600 hover:bg-emerald-700'
                        }`}
                      >
                        {whatsState[c.id] === 'sending'
                          ? '⏳ enviando…'
                          : whatsState[c.id] === 'sent'
                            ? '✓ WhatsApp enviado'
                            : 'WhatsApp 🤖'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => markPaidExternal(c)}
                      disabled={!!payingExternal[c.id]}
                      title="Cliente já pagou por fora (PIX da loja)? Marca PAGO — sai da cobrança e vai pra separação"
                      className="shrink-0 rounded-lg border border-emerald-300 bg-white px-2.5 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                    >
                      {payingExternal[c.id] ? '…' : '✓ Pagou'}
                    </button>
                  </div>
                );
              })}
              {cobraveis.length === 0 && (
                <div className="py-6 text-center text-sm text-slate-400">
                  Nenhum carrinho aberto pra cobrar. 🎉
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <Link href="/minha-loja" className="text-slate-400 hover:text-slate-600">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <Zap className="h-5 w-5 text-rose-500" />
        <span className="font-bold text-slate-800">Live Commerce</span>
        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
          ● {sessionTitle}
        </span>
        <button
          type="button"
          onClick={openSwapStore}
          title="Loja anfitriã da live (define o PIX, a separação e a remessa) — clique pra trocar"
          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"
        >
          🏬 {sessionStoreName || 'definir loja'}
        </button>
        <button
          onClick={closeLive}
          title="Fechar esta live — guarda os carrinhos e libera pra abrir uma nova"
          className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 hover:border-rose-300 hover:text-rose-600"
        >
          Fechar live
        </button>
        <button
          onClick={() => setShowLegenda(true)}
          title="Legenda da live — atalhos curtos (01, 02...) pra cada referência, com validação"
          className="rounded-md border border-violet-300 bg-violet-50 px-2 py-1 text-xs font-bold text-violet-700 hover:bg-violet-100"
        >
          📋 Legenda
        </button>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-slate-200 p-0.5">
          <button
            onClick={() => setTab('console')}
            className={`rounded-md px-3 py-1 text-sm font-medium ${tab === 'console' ? 'bg-slate-800 text-white' : 'text-slate-600'}`}
          >
            Console
          </button>
          <button
            onClick={() => setTab('dashboard')}
            className={`inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm font-medium ${tab === 'dashboard' ? 'bg-slate-800 text-white' : 'text-slate-600'}`}
          >
            <BarChart3 className="h-4 w-4" /> Dashboard
          </button>
        </div>
      </div>

      {tab === 'dashboard' ? (
        <Dashboard sessionId={sessionId} />
      ) : (
        // Proporção 1.3fr:1fr (~56/44) — antes era [1fr_460px]: a coluna da
        // busca+grade encolheu ~25% pra dar mais espaço aos carrinhos
        // (Carrinho + Clientes da Live).
        <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1.3fr_1fr]">
          {/* Coluna principal: busca + grade */}
          <div>
            <form onSubmit={doSearch} className="mb-4 flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  ref={searchRef}
                  autoFocus
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Referência, código, SKU ou nome… (ENTER)"
                  className="w-full rounded-xl border border-slate-300 bg-white py-3 pl-11 pr-4 text-lg shadow-sm focus:border-rose-400 focus:outline-none focus:ring-2 focus:ring-rose-100"
                />
              </div>
              <button
                type="submit"
                disabled={searching}
                className="rounded-xl bg-rose-600 px-5 font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {searching ? <Loader2 className="h-5 w-5 animate-spin" /> : 'Buscar'}
              </button>

              {/* ROLLBACK — dropdown com as REFs já buscadas na live.
                  A cliente "volta" numa peça de minutos atrás o tempo todo;
                  aqui reabre a grade em 1 clique, sem redigitar. */}
              {refHistory.length > 0 && (
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setHistoryOpen((v) => !v)}
                    title="Referências já buscadas nesta live"
                    className={`h-full rounded-xl border px-4 py-3 text-sm font-semibold transition ${
                      historyOpen
                        ? 'border-rose-400 bg-rose-50 text-rose-700'
                        : 'border-slate-300 bg-white text-slate-600 hover:border-rose-300 hover:text-rose-600'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <History className="h-4 w-4" />
                      Recentes
                      <span className="rounded-full bg-slate-100 px-1.5 text-[11px] font-bold text-slate-500">
                        {refHistory.length}
                      </span>
                    </span>
                  </button>
                  {historyOpen && (
                    <>
                      {/* backdrop invisível — clique fora fecha */}
                      <div className="fixed inset-0 z-30" onClick={() => setHistoryOpen(false)} />
                      <div className="absolute right-0 z-40 mt-1 max-h-[50vh] w-64 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-xl">
                        {refHistory.map((r) => (
                          <button
                            key={r}
                            type="button"
                            onClick={() => searchFromHistory(r)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-mono font-semibold text-slate-700 hover:bg-rose-50 hover:text-rose-700"
                          >
                            <Search className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                            {r}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            setRefHistory([]);
                            try { localStorage.removeItem('lurds_live_ref_history'); } catch {}
                            setHistoryOpen(false);
                          }}
                          className="mt-1 flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-xs text-slate-400 hover:text-rose-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" /> Limpar histórico
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </form>

            {product && !product.found && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center text-amber-700">
                Nada encontrado para “{term}”.
              </div>
            )}

            {product && product.found && (
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                {product.fromMirror && (
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <div className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-500">
                      <Package className="h-3 w-3" /> Estoque atualizado do Giga na busca desta peça
                    </div>
                    <button
                      type="button"
                      onClick={refreshStock}
                      disabled={refreshingStock}
                      title="Busca o estoque desta peça direto no Giga agora"
                      className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-600 hover:bg-rose-100 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${refreshingStock ? 'animate-spin' : ''}`} />
                      {refreshingStock ? 'Atualizando…' : 'Atualizar estoque'}
                    </button>
                  </div>
                )}
                <div className="mb-4 flex gap-4">
                  <div className="h-28 w-28 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                    {product.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.photoUrl} alt={product.descricao || ''} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-300">
                        <Package className="h-10 w-10" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-rose-600">{product.ref}</div>
                    <h2 className="truncate text-lg font-bold text-slate-800">{product.descricao}</h2>

                    {/* Preço + preço promocional da live */}
                    {promoEditing ? (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <div className="relative">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-slate-400">R$</span>
                          <input
                            autoFocus
                            value={promoInput}
                            onChange={(e) => setPromoInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && applyPromo()}
                            inputMode="decimal"
                            placeholder="0,00"
                            className="w-28 rounded-lg border border-rose-300 py-1.5 pl-8 pr-2 text-lg font-bold focus:outline-none focus:ring-2 focus:ring-rose-200"
                          />
                        </div>
                        <button
                          onClick={applyPromo}
                          className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700"
                        >
                          Aplicar
                        </button>
                        {product.promoActive && (
                          <button
                            onClick={removePromo}
                            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
                          >
                            Remover promo
                          </button>
                        )}
                        <button
                          onClick={() => setPromoEditing(false)}
                          className="text-sm text-slate-400 hover:text-slate-600"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <div className="mt-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`text-2xl font-extrabold ${product.promoActive ? 'text-rose-600' : 'text-slate-900'}`}>
                            {brl(product.priceCents || 0)}
                          </span>
                          {product.promoActive && (
                            <>
                              <span className="text-sm text-slate-400 line-through">
                                {brl(product.basePriceCents || 0)}
                              </span>
                              <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-700">
                                <Tag className="h-3 w-3" /> Promo Live
                              </span>
                            </>
                          )}
                          <button
                            onClick={() => {
                              setPromoInput(((product.priceCents || 0) / 100).toFixed(2).replace('.', ','));
                              setCupomEditing(false);
                              setPromoEditing(true);
                            }}
                            title="Definir preço promocional da live"
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-rose-300 hover:text-rose-600"
                          >
                            <Pencil className="h-3.5 w-3.5" /> Preço
                          </button>
                          {/* 50% sobre o preço ORIGINAL */}
                          <button
                            onClick={applyMetade}
                            title="Aplicar 50% de desconto sobre o preço original"
                            className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700 hover:bg-amber-100"
                          >
                            <Percent className="h-3.5 w-3.5" /> 50% OFF
                          </button>
                          {/* Cupom relâmpago — R$ X off editável */}
                          <button
                            onClick={() => {
                              setPromoEditing(false);
                              setCupomEditing((v) => !v);
                            }}
                            title="Cupom relâmpago — desconto em reais sobre o preço original"
                            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-bold ${
                              cupomEditing
                                ? 'border-rose-400 bg-rose-50 text-rose-700'
                                : 'border-rose-300 text-rose-600 hover:bg-rose-50'
                            }`}
                          >
                            <Zap className="h-3.5 w-3.5" /> Cupom relâmpago
                          </button>
                          {product.promoActive && (
                            <button
                              onClick={removePromo}
                              className="text-xs text-slate-400 underline hover:text-slate-600"
                            >
                              remover
                            </button>
                          )}
                        </div>

                        {cupomEditing && (
                          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/50 p-2">
                            <span className="text-xs font-bold uppercase tracking-wide text-rose-700">
                              Cupom relâmpago
                            </span>
                            <div className="relative">
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-slate-400">−R$</span>
                              <input
                                autoFocus
                                value={cupomInput}
                                onChange={(e) => setCupomInput(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && applyCupom()}
                                inputMode="decimal"
                                placeholder="20,00"
                                className="w-28 rounded-lg border border-rose-300 py-1.5 pl-9 pr-2 text-base font-bold focus:outline-none focus:ring-2 focus:ring-rose-200"
                              />
                            </div>
                            <button
                              onClick={applyCupom}
                              className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-700"
                            >
                              Aplicar
                            </button>
                            <span className="text-xs text-slate-500">
                              sobre {brl(product.basePriceCents || product.priceCents || 0)}
                            </span>
                            <button
                              onClick={() => setCupomEditing(false)}
                              className="text-sm text-slate-400 hover:text-slate-600"
                            >
                              Cancelar
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      <Package className="h-3 w-3" /> {product.totalRede} na rede
                    </div>
                  </div>
                </div>

                {/* Grade — matriz cor × tamanho (clique na célula adiciona ao carrinho) */}
                {(() => {
                  const g = buildGrade(product);
                  if (!g.colors.length) {
                    return <div className="text-sm text-slate-400">Sem grade disponível.</div>;
                  }
                  return (
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-100">
                            <th className="sticky left-0 z-10 min-w-[90px] bg-slate-100 px-3 py-2 text-left font-bold text-slate-700">
                              Cor
                            </th>
                            {g.sizes.map((s) => (
                              <th key={s} className="min-w-[42px] px-2 py-1.5 text-center font-bold text-slate-700">
                                {s}
                              </th>
                            ))}
                            <th className="min-w-[48px] bg-slate-200 px-2 py-2 text-center font-bold text-slate-700">
                              Total
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.colors.map((cor) => {
                            const colorTotal = g.totalsByColor.get(cor) || 0;
                            return (
                              <tr key={cor} className="border-b border-slate-100 hover:bg-slate-50">
                                <td className="sticky left-0 z-10 border-r border-slate-100 bg-white px-3 py-2 font-semibold text-slate-800">
                                  <span className="flex items-center gap-2">
                                    <span className={`h-2 w-2 rounded-full ${colorTotal > 0 ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                                    <span className="max-w-[110px] truncate" title={cor}>{cor}</span>
                                  </span>
                                </td>
                                {g.sizes.map((s) => {
                                  const cell = g.cellByKey.get(`${cor}|${s}`);
                                  const qty = cell?.available ?? 0;
                                  const busy = !!cell && adding === cell.itemKey;
                                  const low = qty > 0 && qty <= 2;
                                  const title =
                                    cell && cell.perStore.length
                                      ? cell.perStore.map((ps) => `${ps.storeName}: ${ps.qty}`).join('  ·  ')
                                      : 'Sem estoque';
                                  return (
                                    <td key={s} className="p-0.5 text-center">
                                      <button
                                        type="button"
                                        disabled={!cell || qty <= 0 || busy}
                                        onClick={() => cell && clickCell(cell)}
                                        title={title}
                                        className={`mx-auto flex h-9 w-full items-center justify-center rounded font-extrabold transition ${
                                          qty <= 0
                                            ? 'cursor-not-allowed bg-slate-50 text-slate-300'
                                            : low
                                            ? 'border border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200 active:scale-95'
                                            : 'border border-emerald-300 bg-emerald-100 text-emerald-900 hover:bg-emerald-200 active:scale-95'
                                        }`}
                                      >
                                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : qty > 0 ? qty : '—'}
                                      </button>
                                    </td>
                                  );
                                })}
                                <td className={`bg-slate-50 px-2 py-2 text-center font-bold ${colorTotal > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>
                                  {colorTotal}
                                </td>
                              </tr>
                            );
                          })}
                          <tr className="border-t-2 border-slate-300 bg-slate-100">
                            <td className="sticky left-0 z-10 border-r border-slate-200 bg-slate-100 px-3 py-2 font-bold text-slate-700">
                              Total
                            </td>
                            {g.sizes.map((s) => {
                              const t = g.totalsBySize.get(s) || 0;
                              return (
                                <td key={s} className={`px-2 py-2 text-center font-bold ${t > 0 ? 'text-slate-800' : 'text-slate-400'}`}>
                                  {t}
                                </td>
                              );
                            })}
                            <td className="bg-slate-200 px-2 py-2 text-center font-extrabold text-emerald-700">
                              {product.totalRede}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  );
                })()}

                <div className="mt-2 flex flex-wrap items-center gap-3 px-1 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded border border-emerald-300 bg-emerald-100" /> disponível
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded border border-amber-300 bg-amber-100" /> acabando (≤2)
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="inline-block h-3 w-3 rounded border border-slate-200 bg-slate-50" /> sem estoque
                  </span>
                  <span>· clique na célula pra adicionar · passe o mouse pra ver por loja</span>
                </div>

                {/* Novo carrinho — logo abaixo da grade, pra começar a próxima
                    cliente rápido sem sair da mão. */}
                <div className="mt-4 flex justify-center">
                  <button
                    onClick={newClient}
                    className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-6 py-2.5 font-bold text-white shadow hover:bg-rose-700"
                  >
                    <ShoppingCart className="h-5 w-5" /> Novo carrinho
                  </button>
                </div>
              </div>
            )}

          </div>

          {/* Sidebar: carrinho + lista de clientes da live */}
          <div className="flex flex-col gap-4">
            <CartPanel
              cart={cart}
              activeCustomer={activeCustomer}
              qr={qr}
              paid={paid}
              paying={paying}
              onNewClient={newClient}
              onRemoveItem={removeItem}
              onSetItemPrice={setItemPrice}
              onChargePix={startPix}
              onChargeLink={startLink}
              onEditCustomer={() => setEditCustomerOpen(true)}
              onDeleteCart={deleteCart}
              onCalcFrete={calcFrete}
              onContinue={continueAttending}
              onConfirmPayment={confirmPayment}
              confirming={confirming}
              pixExterno={pixExterno}
              onConfirmExternal={confirmExternalPay}
              onReleaseSeparation={releaseSeparation}
              releasing={releasing}
              onRetracted={async (fresh) => {
                setCart(fresh);
                await refreshCarts();
              }}
            />

            {/* Cadastradas pelo link (ManyChat) aguardando — SEMPRE visível durante a
                live (mesmo vazia) pra ficar claro que o recurso está ali. */}
            {sessionId && (
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <UserPlus className="h-5 w-5 text-amber-600" />
                    <span className="text-sm font-bold uppercase tracking-wide text-slate-800">
                      Cadastradas na live ({pendingRegs.length})
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={refreshPending}
                    title="Atualizar a fila de cadastradas"
                    className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700 hover:bg-amber-100"
                  >
                    Atualizar
                  </button>
                </div>
                <div className="mb-2 text-[11px] text-slate-500">
                  Quem se cadastrou pelo link e ainda não tem carrinho. Clique pra iniciar.
                </div>
                {pendingRegs.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-amber-200 bg-amber-50/40 px-3 py-4 text-center text-xs text-slate-400">
                    Ninguém aguardando ainda. Aparece aqui quando alguém comentar <b>CARRINHO</b> e se cadastrar pelo link.
                  </div>
                ) : (
                <div className="grid max-h-[40vh] grid-cols-1 content-start gap-1.5 overflow-y-auto rounded-xl border border-amber-200 bg-amber-50/50 p-1.5 sm:grid-cols-2">
                  {pendingRegs.map((p) => (
                    <div
                      key={p.customerId}
                      className="flex items-center gap-2 rounded-lg border border-amber-100 bg-white px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-slate-800" title={p.name || ''}>
                          {p.name || 'Sem nome'}
                        </div>
                        <div className="truncate text-[11px] text-slate-500">
                          {p.instagram ? `@${p.instagram}` : ''}
                          {p.instagram && p.phone ? ' · ' : ''}
                          {p.phone || ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => pullRegisteredCustomer(p.customerId)}
                        disabled={pullingId === p.customerId}
                        className="shrink-0 rounded-md bg-amber-600 px-2 py-1 text-[11px] font-bold text-white hover:bg-amber-700 disabled:opacity-60"
                      >
                        {pullingId === p.customerId ? '…' : 'Iniciar carrinho'}
                      </button>
                    </div>
                  ))}
                </div>
                )}
              </div>
            )}

            {/* Clientes da live — na lateral pra não ser empurrada pela grade */}
            {/* EM PAGAMENTO — carrinhos aguardando o PIX/link. Saem da grade
                principal pra live ficar limpa; clicar reabre o QR/link. */}
            {emPagamento.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <QrCode className="h-5 w-5 text-sky-600" />
                  <span className="text-sm font-bold uppercase tracking-wide text-slate-800">
                    Em pagamento ({emPagamento.length})
                  </span>
                </div>
                <div className="grid grid-cols-1 content-start gap-1.5 rounded-xl border border-sky-200 bg-sky-50/50 p-1.5 sm:grid-cols-2">
                  {emPagamento.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => openCart(c)}
                      className={`flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 text-left transition ${
                        cart?.id === c.id ? 'border-sky-400' : 'border-sky-100 hover:border-sky-300'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-slate-800" title={c.customerName}>
                          {c.customerName}
                        </div>
                        <div className="text-[11px] text-slate-500 tabular-nums">{brl(c.totalCents)}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-sky-700">
                        {c.paymentMethod === 'link' ? 'Link/cartão' : 'PIX'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* PAGAS — operadora confere os dados e libera pra separação */}
            {pagasAguardando.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <Check className="h-5 w-5 text-emerald-600" />
                  <span className="text-sm font-bold uppercase tracking-wide text-slate-800">
                    Pagas — enviar p/ separação ({pagasAguardando.length})
                  </span>
                </div>
                <div className="mb-2 text-[11px] text-slate-500">
                  Pagamento confirmado. Clique, confira o endereço e envie pra loja separar.
                </div>
                <div className="grid grid-cols-1 content-start gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50/50 p-1.5 sm:grid-cols-2">
                  {pagasAguardando.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => openCart(c)}
                      className={`flex items-center gap-2 rounded-lg border bg-white px-2 py-1.5 text-left transition ${
                        cart?.id === c.id ? 'border-emerald-400' : 'border-emerald-100 hover:border-emerald-300'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-slate-800" title={c.customerName}>
                          {c.customerName}
                        </div>
                        <div className="text-[11px] text-slate-500 tabular-nums">{brl(c.totalCents)}</div>
                      </div>
                      <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                        conferir
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Cobrança em massa: fila semi-automática (Direct/WhatsApp) */}
            {cobraveis.length > 0 && (
              <button
                type="button"
                onClick={() => setChargeAllOpen(true)}
                className="w-full rounded-xl border-2 border-[#D4AF37] bg-[#FBF6E6] py-2.5 text-sm font-extrabold text-[#8C7325] hover:bg-[#F5EBC8]"
              >
                💰 Cobrar todas ({cobraveis.length})
                {cobradas > 0 ? ` · ${cobradas} enviada${cobradas > 1 ? 's' : ''}` : ''}
              </button>
            )}

            {cartsAtivos.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <User className="h-5 w-5 text-rose-500" />
                    <span className="text-sm font-bold uppercase tracking-wide text-slate-800">
                      Clientes da live ({gridCarts.length}
                      {gridCarts.length !== cartsAtivos.length ? `/${cartsAtivos.length}` : ''})
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={recoverCarts}
                    title="Re-reserva os itens que expiraram e deixa por 24h"
                    className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-700 hover:bg-amber-100"
                  >
                    Recuperar 24h
                  </button>
                </div>
                {/* Chips: grade limpa por padrão (só quem tem peças). A busca ignora o chip. */}
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCartView('pecas')}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition ${
                      viewEfetiva === 'pecas'
                        ? 'bg-rose-600 text-white'
                        : 'border border-slate-200 bg-white text-slate-600 hover:border-rose-300'
                    }`}
                  >
                    🛍 Com peças ({nComPecas})
                  </button>
                  <button
                    type="button"
                    onClick={() => setCartView('vazios')}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition ${
                      viewEfetiva === 'vazios'
                        ? 'bg-slate-700 text-white'
                        : 'border border-slate-200 bg-white text-slate-500 hover:border-slate-400'
                    }`}
                  >
                    Vazios ({nVazios})
                  </button>
                  <button
                    type="button"
                    onClick={() => setCartView('todos')}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition ${
                      viewEfetiva === 'todos'
                        ? 'bg-slate-700 text-white'
                        : 'border border-slate-200 bg-white text-slate-500 hover:border-slate-400'
                    }`}
                  >
                    Todos ({clientesFiltradas.length})
                  </button>
                  {nVazios > 0 && (
                    <button
                      type="button"
                      onClick={clearEmptyCarts}
                      disabled={clearingEmpty}
                      title="Exclui todos os carrinhos com 0 peças (sem reserva/pagamento — clientes seguem no CRM)"
                      className="ml-auto rounded-full border border-rose-200 bg-white px-2.5 py-1 text-[11px] font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                    >
                      {clearingEmpty ? 'Limpando…' : `🧹 Limpar vazios (${nVazios})`}
                    </button>
                  )}
                </div>
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={clientFilter}
                    onChange={(e) => setClientFilter(e.target.value)}
                    placeholder="Buscar por nº, nome ou @"
                    className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-8 text-sm focus:border-rose-400 focus:outline-none"
                  />
                  {clientFilter && (
                    <button
                      type="button"
                      onClick={() => setClientFilter('')}
                      title="Limpar busca"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {/* GRID em LINHAS, 3 colunas (08/07): o dono trocou as 6 colunas
                    por linhas maiores pra ver o NOME COMPLETO da cliente.
                    Em telas menores cai pra 2/1. */}
                <div className="grid max-h-[60vh] grid-cols-1 content-start gap-1.5 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  {gridCarts.length === 0 && (
                    <div className="col-span-full px-3 py-4 text-center text-sm text-slate-400">
                      {viewEfetiva === 'pecas' && nVazios > 0
                        ? 'Ninguém com peças ainda — os carrinhos vazios estão no chip "Vazios".'
                        : 'Nenhuma cliente encontrada.'}
                    </div>
                  )}
                  {gridCarts.map((c) => {
                    const active = cart?.id === c.id;
                    return (
                      <div
                        key={c.id}
                        className={`relative flex min-w-0 items-start rounded-lg border transition ${
                          active
                            ? 'border-rose-400 bg-rose-50'
                            : 'border-slate-100 hover:border-rose-200 hover:bg-slate-50'
                        }`}
                      >
                        <button
                          onClick={() => openCart(c)}
                          className="flex min-w-0 flex-1 flex-col gap-0.5 px-2 py-1.5 text-left"
                        >
                          <span
                            className={`flex w-full min-w-0 items-start gap-1 text-sm ${active ? 'font-extrabold text-rose-700' : 'font-semibold text-slate-800'}`}
                            title={c.cartNumber ? `#${c.cartNumber} · ${c.customerName}` : c.customerName}
                          >
                            {c.cartNumber != null && (
                              // Verde = já tem peça no carrinho; cinza = vazio.
                              // Pedido do dono: bater o olho e saber quem comprou.
                              <span
                                className={`shrink-0 rounded px-1.5 py-px text-[11px] font-bold tabular-nums text-white ${
                                  c.items.length > 0 ? 'bg-emerald-600' : 'bg-slate-400'
                                }`}
                              >
                                {c.cartNumber}
                              </span>
                            )}
                            {/* Nome COMPLETO (08/07): sem truncate — a grade virou linhas/3 colunas */}
                            <span className="break-words leading-tight">{c.customerName}</span>
                          </span>
                          <span className="text-xs font-bold tabular-nums text-slate-900">
                            {brl(c.totalCents)}
                          </span>
                          <div className="flex w-full flex-wrap items-center gap-1 text-[10px] text-slate-500">
                            {active && (
                              <span className="rounded-full bg-rose-600 px-1.5 py-px font-bold uppercase text-white">
                                Atendendo
                              </span>
                            )}
                            <span>
                              {c.items.length} {c.items.length === 1 ? 'item' : 'itens'}
                            </span>
                            <span
                              className={`rounded-full px-1.5 py-px font-bold uppercase ${
                                STATUS_PILL[c.status] || 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {STATUS_LABEL[c.status] || c.status}
                            </span>
                          </div>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteCartFromList(c);
                          }}
                          title="Excluir esta cliente da live (libera as reservas)"
                          className="mr-1 mt-1 shrink-0 rounded-md p-1 text-slate-300 transition hover:bg-rose-100 hover:text-rose-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal editar cliente do carrinho */}
      {editCustomerOpen && cart && (
        <CustomerModal
          title={pendingPay ? 'Cadastro pra envio' : 'Editar cliente'}
          submitLabel={
            pendingPay === 'pix'
              ? 'Salvar e gerar PIX'
              : pendingPay === 'link'
              ? 'Salvar e gerar link'
              : 'Salvar alterações'
          }
          showAddress
          initial={{
            name: cart.customerName,
            phone: cart.customerPhone,
            instagram: cart.customerInstagram,
            cpf: cart.customerCpf,
            email: cart.customerEmail,
            cep: cart.customerCep,
            endereco: cart.customerEndereco,
            numero: cart.customerNumero,
            complemento: cart.customerComplemento,
            bairro: cart.customerBairro,
            cidade: cart.customerCidade,
            uf: cart.customerUf,
          }}
          onClose={() => {
            setEditCustomerOpen(false);
            setPendingPay(null);
          }}
          onSave={saveCustomerEdit}
        />
      )}

      {/* Modal cliente — SÓ o @ (obrigatório) + verificador de @ duplicada.
          Dados extras (nome/telefone/etc) ficam pro "Editar cliente". */}
      {showCustomerModal && (
        <CustomerModal
          title="Identificar cliente (@)"
          onlyInstagram
          onClose={() => {
            setShowCustomerModal(false);
            setPendingCell(null);
          }}
          onSave={saveCustomerAndAdd}
          dupCarts={carts}
          onUseExisting={handleUseExisting}
        />
      )}
    </div>
  );
}

/* ─── Carrinho ─── */
function CartPanel({
  cart,
  activeCustomer,
  qr,
  paid,
  paying,
  onNewClient,
  onRemoveItem,
  onSetItemPrice,
  onChargePix,
  onChargeLink,
  onEditCustomer,
  onDeleteCart,
  onCalcFrete,
  onContinue,
  onConfirmPayment,
  confirming,
  pixExterno,
  onConfirmExternal,
  onReleaseSeparation,
  releasing,
  onRetracted,
}: {
  cart: Cart | null;
  activeCustomer: ActiveCustomer | null;
  qr: { text: string; img: string; valor: number; link?: string } | null;
  paid: boolean;
  paying: boolean;
  onNewClient: () => void;
  onRemoveItem: (id: string) => void;
  onSetItemPrice: (id: string, priceCents: number) => Promise<void> | void;
  onChargePix: () => void;
  onChargeLink: () => void;
  onEditCustomer: () => void;
  onDeleteCart: () => void;
  onCalcFrete: () => void;
  onContinue: () => void;
  onConfirmPayment: () => void;
  confirming: boolean;
  pixExterno: boolean;
  onConfirmExternal: () => void;
  onReleaseSeparation: () => void;
  releasing: boolean;
  onRetracted: (fresh: Cart) => void | Promise<void>;
}) {
  const [linkCopied, setLinkCopied] = useState(false);
  // Rastreio copiado (feedback visual por item)
  const [trackingCopied, setTrackingCopied] = useState<string | null>(null);
  // Edição inline do PREÇO de um item (clica no valor → digita → Enter)
  const [editPriceId, setEditPriceId] = useState<string | null>(null);
  const [editPriceVal, setEditPriceVal] = useState('');
  async function savePrice(itemId: string) {
    const cents = Math.round(parseFloat(editPriceVal.replace(/\./g, '').replace(',', '.')) * 100);
    setEditPriceId(null);
    if (!Number.isFinite(cents) || cents <= 0) return;
    await onSetItemPrice(itemId, cents);
  }
  // DM automática via ManyChat — estado do envio individual
  const [dmSending, setDmSending] = useState(false);
  const [dmStatus, setDmStatus] = useState<string | null>(null);
  // Carrinho já pago/em separação: esconde ações de cobrança (link /pagar, frete)
  const cartPago = !!cart && ['paid', 'separating', 'shipped', 'delivered'].includes(cart.status);

  // RECOLHER pedido: puxa TODOS os itens de volta pra UMA loja (ex.: matriz)
  // e tira das filas de separação — pra repensar roteamento/frete de remessa.
  const [retractOpen, setRetractOpen] = useState(false);
  const [retractStores, setRetractStores] = useState<{ code: string; name: string }[]>([]);
  const [retractCode, setRetractCode] = useState('');
  const [retracting, setRetracting] = useState(false);
  const podeRecolher = !!cart && ['paid', 'separating'].includes(cart.status);
  async function openRetract() {
    setRetractOpen(true);
    try {
      const stores = await api<any[]>('/stores');
      const act = (stores || [])
        .filter((s: any) => s.active !== false)
        .map((s: any) => ({ code: String(s.code), name: String(s.name) }));
      setRetractStores(act);
      // pré-seleciona a matriz se existir (é o caso de uso típico)
      const matriz = act.find((s) => /matriz/i.test(s.name));
      setRetractCode(matriz?.code || act[0]?.code || '');
    } catch {
      setRetractStores([]);
    }
  }
  async function confirmRetract() {
    if (!cart || !retractCode || retracting) return;
    setRetracting(true);
    try {
      const fresh = await api<Cart>(`/live-pdv/carts/${cart.id}/retract-separation`, {
        method: 'POST',
        body: JSON.stringify({ storeCode: retractCode }),
      });
      setRetractOpen(false);
      await onRetracted(fresh);
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Não consegui recolher o pedido.';
      try {
        const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch { /* mensagem crua */ }
      alert(msg);
    } finally {
      setRetracting(false);
    }
  }

  // Manda a DM sozinho pela API do ManyChat — chega mesmo com o Insta fechado,
  // porque sai da conta da loja (janela de 24h de quem comentou/se cadastrou).
  async function sendDmAuto() {
    if (!cart || dmSending) return;
    setDmSending(true);
    setDmStatus(null);
    try {
      await api(`/live-pdv/carts/${cart.id}/charge-dm`, { method: 'POST', body: JSON.stringify({}) });
      setDmStatus('✓ DM enviada no Direct da cliente!');
    } catch (e: any) {
      const raw = String(e?.message || '');
      let msg = 'Falha no envio da DM.';
      try {
        const j = JSON.parse(raw.slice(raw.indexOf(': ') + 2));
        if (j?.message) msg = Array.isArray(j.message) ? j.message[0] : j.message;
      } catch { /* mensagem crua */ }
      setDmStatus(`⚠️ ${msg}`);
    } finally {
      setDmSending(false);
    }
  }
  // Link curto (/p/<code>) quando o carrinho tem payCode; senão o longo (/pagar/<uuid>)
  const payLink = cart && !cartPago && typeof window !== 'undefined'
    ? (cart.payCode
        ? `${publicBase()}/p/${cart.payCode}`
        : `${publicBase()}/pagar/${cart.id}`)
    : '';
  const payMsg = `Oi! 💜 É pra fechar sua compra da live: ${payLink}`;
  return (
    <div className="lg:sticky lg:top-16 lg:h-fit">
      {/* Modal RECOLHER PEDIDO: junta todos os itens numa loja só */}
      {retractOpen && cart && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl">
            <div className="mb-1 text-base font-bold text-slate-800">↩ Recolher pedido</div>
            <p className="mb-3 text-xs text-slate-500">
              Todos os itens saem das filas das lojas e ficam com origem numa loja só.
              O pedido volta pra <b>PAGO</b> — você envia pra separação de novo quando decidir.
              Peça já bipada bloqueia (estoque já baixou na loja).
            </p>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Levar tudo pra:</label>
            <select
              value={retractCode}
              onChange={(e) => setRetractCode(e.target.value)}
              className="mb-3 w-full rounded-lg border border-slate-300 p-2 text-sm"
            >
              {retractStores.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={() => setRetractOpen(false)}
                className="flex-1 rounded-lg border border-slate-300 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={confirmRetract}
                disabled={retracting || !retractCode}
                className="flex-1 rounded-lg bg-amber-500 py-2 text-sm font-bold text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {retracting ? 'Recolhendo…' : 'Recolher'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 p-3">
          <div className="flex items-center gap-2 font-semibold text-slate-800">
            <ShoppingCart className="h-5 w-5 text-rose-500" /> Carrinho
          </div>
          <button
            onClick={onNewClient}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
          >
            <ShoppingCart className="h-3.5 w-3.5" /> Novo carrinho
          </button>
        </div>

        {!activeCustomer && !cart && (
          <div className="p-6 text-center text-sm text-slate-400">
            Clique numa peça da grade pra começar.
          </div>
        )}

        {(activeCustomer || cart) && (
          <div className="p-3">
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <User className="h-4 w-4 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 font-semibold text-slate-800">
                  {cart?.cartNumber != null && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-bold tabular-nums text-white ${
                        (cart?.items?.length || 0) > 0 ? 'bg-emerald-600' : 'bg-slate-400'
                      }`}
                    >
                      #{cart.cartNumber}
                    </span>
                  )}
                  <span className="truncate">{cart?.customerName || activeCustomer?.name}</span>
                </div>
                <div className="truncate text-xs text-slate-500">
                  {cart?.customerPhone || activeCustomer?.phone || 'sem telefone'}
                  {(cart?.customerInstagram || activeCustomer?.instagram) &&
                    ` · @${cart?.customerInstagram || activeCustomer?.instagram}`}
                </div>
              </div>
              {cart && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={onEditCustomer}
                    title="Editar dados da cliente"
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-rose-300 hover:text-rose-600"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </button>
                  <button
                    onClick={onDeleteCart}
                    title="Excluir o carrinho desta cliente (libera as reservas)"
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-xs font-medium text-rose-600 hover:border-rose-400 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Excluir
                  </button>
                </div>
              )}
            </div>

            <div className="max-h-[40vh] space-y-1.5 overflow-y-auto">
              {(cart?.items || []).map((it) => (
                <div key={it.id} className="flex items-center gap-2 rounded-lg border border-slate-100 p-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-800">
                      {it.refCode} · {it.cor} {it.tamanho}
                    </div>
                    <div className="flex items-center gap-1 text-[11px] text-slate-500">
                      <Store className="h-3 w-3" /> {it.originStoreName}
                      <span className="ml-1 rounded bg-slate-100 px-1">{STATUS_LABEL[it.status] || it.status}</span>
                    </div>
                    {/* Rastreio do despacho — clica pra copiar (manda pra cliente no Direct/Whats) */}
                    {it.trackingCode && (
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(it.trackingCode!);
                          setTrackingCopied(it.id);
                          setTimeout(() => setTrackingCopied(null), 2000);
                        }}
                        title="Copiar código de rastreio"
                        className="mt-0.5 inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
                      >
                        📦 {it.trackingCode}
                        <span className="font-sans font-semibold">
                          {trackingCopied === it.id ? '✓ copiado' : '📋'}
                        </span>
                      </button>
                    )}
                  </div>
                  {editPriceId === it.id ? (
                    <input
                      autoFocus
                      value={editPriceVal}
                      onChange={(e) => setEditPriceVal(e.target.value.replace(/[^\d.,]/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') savePrice(it.id);
                        if (e.key === 'Escape') setEditPriceId(null);
                      }}
                      onBlur={() => savePrice(it.id)}
                      inputMode="decimal"
                      className="w-20 rounded border border-[#D4AF37] px-1.5 py-0.5 text-right text-sm font-semibold text-slate-800 outline-none focus:ring-2 focus:ring-[#EBD9A6]"
                    />
                  ) : it.status === 'reserved' ? (
                    <button
                      onClick={() => {
                        setEditPriceId(it.id);
                        // Edita o valor UNITÁRIO da peça (com qty>1 o total recalcula)
                        setEditPriceVal((it.priceCents / 100).toFixed(2).replace('.', ','));
                      }}
                      title={`Clique pra editar o valor da peça (negociação na hora)${it.qty > 1 ? ' — valor unitário' : ''}`}
                      className="rounded px-1 text-sm font-semibold text-slate-800 underline decoration-dotted decoration-[#D4AF37] underline-offset-4 hover:bg-[#FBF6E6]"
                    >
                      {brl(it.priceCents * it.qty)}
                    </button>
                  ) : (
                    <div className="text-sm font-semibold text-slate-800">{brl(it.priceCents * it.qty)}</div>
                  )}
                  {['reserved', 'open'].includes(it.status) && (
                    <button onClick={() => onRemoveItem(it.id)} className="text-slate-300 hover:text-rose-500">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
              {cart && cart.items.length === 0 && (
                <div className="py-4 text-center text-sm text-slate-400">Carrinho vazio</div>
              )}
            </div>

            {cart && cart.items.length > 0 && (
              <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
                <div className="flex justify-between text-slate-500">
                  <span>Subtotal</span>
                  <span>{brl(cart.subtotalCents)}</span>
                </div>
                {cart.freteCents > 0 && (
                  <div className="flex justify-between text-slate-500">
                    <span>
                      Frete{' '}
                      {cart.freteCents === 999
                        ? '(SEDEX · SP)'
                        : cart.freteCents === 1999
                        ? '(PAC · Sul/Sudeste)'
                        : cart.freteCents === 3999
                        ? '(PAC · Demais)'
                        : ''}
                    </span>
                    <span>{brl(cart.freteCents)}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-bold text-slate-900">
                  <span>Total</span>
                  <span>{brl(cart.totalCents)}</span>
                </div>
                {!cartPago && (
                <button
                  onClick={onCalcFrete}
                  title="Frete pelo CEP: SP SEDEX R$ 9,99 · Sul/Sudeste PAC R$ 19,99 · demais PAC R$ 39,99"
                  className="mt-1 w-full rounded-lg border border-slate-300 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Calcular frete pelo CEP · SP 9,99 / Sul-Sudeste 19,99 / demais 39,99
                </button>
                )}
                {payLink && (
                  <div className="mt-2 rounded-lg border border-[#ECD9A0] bg-[#FBF6E6]/50 p-2">
                    <div className="mb-1.5 text-[11px] font-bold text-[#8C7325]">
                      Mandar link pra cliente fechar (ela escolhe PIX ou cartão 12x + informa o CEP):
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { navigator.clipboard?.writeText(payLink); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2500); }}
                        className="flex-1 rounded-lg border border-[#D4AF37] bg-white py-2 text-xs font-bold text-[#8C7325] hover:bg-[#FBF6E6]"
                      >
                        {linkCopied ? 'Copiado! ✓' : 'Copiar link'}
                      </button>
                      <a
                        href={`https://wa.me/?text=${encodeURIComponent(payMsg)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 rounded-lg bg-emerald-600 py-2 text-center text-xs font-bold text-white hover:bg-emerald-700"
                      >
                        WhatsApp
                      </a>
                      {cart?.customerInstagram && (
                        <button
                          onClick={() => {
                            // O Instagram não deixa pré-preencher DM (e o atalho
                            // ig.me/m/ não funciona no desktop). Então: copia a
                            // mensagem pronta e abre o PERFIL da cliente — a
                            // operadora clica em "Mensagem" e cola (Ctrl+V).
                            navigator.clipboard?.writeText(payMsg);
                            setLinkCopied(true);
                            setTimeout(() => setLinkCopied(false), 2500);
                            window.open(
                              `https://www.instagram.com/${String(cart.customerInstagram).replace(/^@/, '')}/`,
                              '_blank',
                              'noopener,noreferrer',
                            );
                          }}
                          title="Copia a mensagem com o link e abre o perfil da cliente — clique em Mensagem e cole (Ctrl+V)"
                          className="flex-1 rounded-lg bg-gradient-to-r from-purple-600 to-pink-500 py-2 text-center text-xs font-bold text-white hover:opacity-90"
                        >
                          Direct
                        </button>
                      )}
                    </div>
                    {cart?.hasManychat && (
                      <button
                        onClick={sendDmAuto}
                        disabled={dmSending}
                        title="Manda a DM sozinho pela API do ManyChat — chega mesmo com o Instagram fechado"
                        className="mt-2 w-full rounded-lg bg-slate-800 py-2 text-xs font-bold text-white hover:bg-slate-900 disabled:opacity-50"
                      >
                        {dmSending ? 'Enviando DM…' : '🤖 Enviar automático no Direct (ManyChat)'}
                      </button>
                    )}
                    {dmStatus && (
                      <div className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center text-[11px] text-slate-600">
                        {dmStatus}
                      </div>
                    )}
                    {payLink.includes('/p/') && (
                      <div className="mt-1.5 truncate text-center font-mono text-[10px] text-[#A08A4E]" title={payLink}>
                        {payLink.replace(/^https?:\/\//, '')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Pagamento */}
            {paid && cart?.status === 'paid' ? (
              /* PAGO mas AINDA NÃO liberado: operadora confere/completa os dados
                 e envia pra separação — igual ao fluxo dos pedidos do site. */
              <div className="mt-3 flex flex-col items-center gap-1 rounded-lg border-2 border-amber-300 bg-amber-50 p-4 text-amber-800">
                <Check className="h-8 w-8" />
                <span className="font-bold">Pagamento confirmado!</span>
                <span className="text-center text-xs">
                  Confira os dados da cliente (endereço) e envie pra separação.
                </span>
                <button
                  onClick={onReleaseSeparation}
                  disabled={releasing}
                  className="mt-2 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {releasing ? 'Enviando…' : '📦 Enviar pra separação'}
                </button>
                <button
                  onClick={onEditCustomer}
                  className="w-full rounded-lg border border-amber-400 bg-white py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100"
                >
                  Conferir / completar dados
                </button>
                <button
                  onClick={openRetract}
                  className="w-full rounded-lg border border-amber-300 bg-white py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100"
                  title="Junta todos os itens numa loja só (ex.: matriz) antes de liberar — evita remessa/frete de várias lojas"
                >
                  ↩ Recolher pedido pra UMA loja
                </button>
              </div>
            ) : paid ? (
              <div className="mt-3 flex flex-col items-center gap-1 rounded-lg bg-emerald-50 p-4 text-emerald-700">
                <Check className="h-8 w-8" />
                <span className="font-bold">Pagamento confirmado!</span>
                <span className="text-center text-xs">
                  Pedido enviado pra <b>Pedidos &amp; Separação</b> — o roteamento pra loja é feito lá (aba Processando).
                </span>
                <button
                  onClick={onContinue}
                  className="mt-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  Continuar atendendo →
                </button>
                {podeRecolher && (
                  <button
                    onClick={openRetract}
                    className="mt-1 w-full rounded-lg border border-emerald-300 bg-white py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                    title="Tira o pedido das filas das lojas e junta tudo numa loja só (ex.: matriz) — o pedido volta pra PAGO e você libera de novo quando decidir"
                  >
                    ↩ Recolher pedido das lojas
                  </button>
                )}
              </div>
            ) : qr?.link ? (
              <div className="mt-3 flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
                <div className="text-sm font-semibold text-slate-700">Link de pagamento · {brl(qr.valor * 100)}</div>
                <input
                  readOnly
                  value={qr.link}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="w-full rounded border border-slate-200 p-2 text-xs text-slate-600"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => navigator.clipboard?.writeText(qr.link!)}
                    className="flex-1 rounded-lg border border-slate-300 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Copiar link
                  </button>
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent('Link de pagamento Lurd\'s: ' + qr.link)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 rounded-lg bg-emerald-600 py-2 text-center text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    Enviar no WhatsApp
                  </a>
                </div>
                <button
                  onClick={onConfirmPayment}
                  disabled={confirming}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Já pagou? Confirmar pagamento
                </button>
                <span className="text-center text-[11px] text-slate-400">
                  Clique quando a cliente pagar — confirma e envia pra separação.
                </span>
                <button
                  onClick={onContinue}
                  className="w-full rounded-lg border border-slate-300 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Continuar atendendo →
                </button>
              </div>
            ) : qr ? (
              <div className="mt-3 flex flex-col items-center gap-2 rounded-lg border border-slate-200 p-3">
                <div className="text-sm font-semibold text-slate-700">PIX · {brl(qr.valor * 100)}</div>
                {qr.img && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qr.img} alt="QR PIX" className="h-44 w-44" />
                )}
                <textarea
                  readOnly
                  value={qr.text}
                  onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                  className="h-16 w-full rounded border border-slate-200 p-1.5 text-[10px] text-slate-600"
                />
                <button
                  onClick={() => navigator.clipboard?.writeText(qr.text)}
                  className="text-xs text-rose-600 hover:underline"
                >
                  Copiar código PIX
                </button>
                <button
                  onClick={onConfirmPayment}
                  disabled={confirming}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Já pagou? Confirmar pagamento
                </button>
                <span className="text-center text-[11px] text-slate-400">
                  Clique quando a cliente pagar — confirma e envia pra separação.
                </span>
                <button
                  onClick={onContinue}
                  className="w-full rounded-lg border border-slate-300 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Continuar atendendo →
                </button>
              </div>
            ) : (
              cart &&
              cart.items.some((i) => i.status === 'reserved') && (
                pixExterno ? (
                  // Loja sem gateway: PIX é por fora (chave da própria loja).
                  // A operadora manda o PIX como quiser e marca pago aqui.
                  <div className="mt-3 space-y-2">
                    <div className="rounded-lg border border-sky-200 bg-sky-50 p-2.5 text-center text-[12px] text-sky-800">
                      PIX externo — mande sua chave pra cliente e marque pago quando cair.
                    </div>
                    <button
                      onClick={onConfirmExternal}
                      disabled={confirming}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-3 font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {confirming ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
                      Cliente pagou? Confirmar ({brl(cart.totalCents)})
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    <button
                      onClick={onChargePix}
                      disabled={paying}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-3 font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {paying ? <Loader2 className="h-5 w-5 animate-spin" /> : <QrCode className="h-5 w-5" />}
                      Cobrar PIX ({brl(cart.totalCents)})
                    </button>
                    <button
                      onClick={onChargeLink}
                      disabled={paying}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-600 py-2.5 font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                    >
                      <Link2 className="h-4 w-4" /> Link de pagamento
                    </button>
                  </div>
                )
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* Máscara de celular BR: (XX) XXXXX-XXXX. Aplica ao digitar; aceita digitação
 * parcial. Guarda só os dígitos no banco (a máscara é só visual). */
function maskPhoneBR(value: string): string {
  const d = (value || '').replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/* ─── Modal de cliente (criar / editar) ─── */
function CustomerModal({
  onClose,
  onSave,
  initial,
  title = 'Identificar cliente',
  submitLabel = 'Salvar e adicionar item',
  showAddress = false,
  onlyInstagram = false,
  dupCarts,
  onUseExisting,
}: {
  onClose: () => void;
  onSave: (f: {
    name: string; phone: string; instagram: string; cpf: string; email: string;
    cep?: string; endereco?: string; numero?: string; complemento?: string; bairro?: string; cidade?: string; uf?: string;
  }) => void;
  initial?: {
    name?: string; phone?: string; instagram?: string | null; cpf?: string | null; email?: string | null;
    cep?: string | null; endereco?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null;
  };
  title?: string;
  submitLabel?: string;
  showAddress?: boolean;
  /** Abertura de carrinho na live: mostra SÓ o campo @ (nome/telefone/CPF/
      e-mail saem — dá pra completar depois no "Editar"). Pedido do dono:
      na live a apresentadora só cola o arroba e segue. */
  onlyInstagram?: boolean;
  dupCarts?: Cart[];
  onUseExisting?: (cart: Cart) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(maskPhoneBR(initial?.phone ?? ''));
  const [instagram, setInstagram] = useState(initial?.instagram ?? '');
  const [cpf, setCpf] = useState(initial?.cpf ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [cep, setCep] = useState(initial?.cep ?? '');
  const [endereco, setEndereco] = useState(initial?.endereco ?? '');
  const [numero, setNumero] = useState(initial?.numero ?? '');
  const [complemento, setComplemento] = useState(initial?.complemento ?? '');
  const [bairro, setBairro] = useState(initial?.bairro ?? '');
  const [cidade, setCidade] = useState(initial?.cidade ?? '');
  const [uf, setUf] = useState(initial?.uf ?? '');
  const [cepLoading, setCepLoading] = useState(false);
  const igRef = useRef<HTMLInputElement>(null);
  useEffect(() => igRef.current?.focus(), []);

  // Busca por @ (autocomplete) — só na abertura de carrinho da live (onlyInstagram).
  // Acha quem já se cadastrou/participou (cadastradas na live vêm primeiro).
  const [atMatches, setAtMatches] = useState<
    Array<{ customerId: string; name: string | null; instagram: string | null; phone: string | null; registered: boolean }>
  >([]);
  const skipNextSearch = useRef(false);
  useEffect(() => {
    if (!onlyInstagram) return;
    if (skipNextSearch.current) { skipNextSearch.current = false; setAtMatches([]); return; }
    const term = instagram.trim().replace(/^@/, '');
    if (term.length < 2) { setAtMatches([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await api<any[]>(`/live-pdv/customers/search-at?term=${encodeURIComponent(term)}`);
        if (alive) setAtMatches(r || []);
      } catch { if (alive) setAtMatches([]); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [instagram, onlyInstagram]);
  function pickMatch(m: { name: string | null; instagram: string | null }) {
    skipNextSearch.current = true;
    setInstagram(m.instagram || '');
    setName(m.name || '');
    setAtMatches([]);
  }

  // VERIFICADOR de @ duplicada: normaliza (sem @, minúsculo) e procura um
  // carrinho ABERTO com a mesma @ na lista da live. Evita pedido duplicado.
  const normIg = (s?: string | null) => (s || '').trim().toLowerCase().replace(/^@/, '');
  const igDup =
    normIg(instagram).length >= 2
      ? (dupCarts || []).find(
          (c) =>
            ['open', 'awaiting_payment'].includes(c.status) &&
            normIg(c.customerInstagram) === normIg(instagram),
        ) || null
      : null;

  // CEP → endereço via ViaCEP (mesmo padrão do PDV). Só preenche o que estiver
  // vazio pra não sobrescrever edição manual.
  async function lookupCep(raw: string) {
    const clean = raw.replace(/\D/g, '');
    if (clean.length !== 8) return;
    setCepLoading(true);
    try {
      const r = await fetch(`https://viacep.com.br/ws/${clean}/json/`);
      const data = await r.json();
      if (!data?.erro) {
        setEndereco((prev) => prev || data.logradouro || '');
        setBairro((prev) => prev || data.bairro || '');
        setCidade((prev) => prev || data.localidade || '');
        setUf((prev) => prev || (data.uf || '').toUpperCase());
      }
    } catch {
      /* CEP indisponível — operadora preenche manual */
    } finally {
      setCepLoading(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const ig = instagram.trim().replace(/^@/, '');
    if (!ig) {
      alert('O @ do Instagram é obrigatório.');
      igRef.current?.focus();
      return;
    }
    // Se já existe carrinho aberto pra essa @, não cria de novo — usa o existente.
    if (igDup && onUseExisting) {
      onUseExisting(igDup);
      return;
    }
    // Nome é opcional: se vazio, usa a @ como nome de exibição.
    const finalName = name.trim() || ig;
    onSave({
      name: finalName, phone: phone.replace(/\D/g, ''), instagram: ig, cpf, email,
      ...(showAddress
        ? { cep: cep.replace(/\D/g, ''), endereco, numero, complemento, bairro, cidade, uf }
        : {}),
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-bold text-slate-800">
            <UserPlus className="h-5 w-5 text-rose-500" /> {title}
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-2.5">
          {/* @ do Instagram — PRIMEIRO e OBRIGATÓRIO */}
          <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-slate-500">
              @ do Instagram *
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">@</span>
              <input
                ref={igRef}
                value={instagram}
                onChange={(e) => setInstagram(e.target.value)}
                placeholder="usuaria_do_insta"
                autoCapitalize="none"
                autoCorrect="off"
                className={`w-full rounded-lg border px-3 py-2 pl-7 ${
                  igDup ? 'border-amber-400 bg-amber-50' : 'border-slate-300'
                }`}
              />
            </div>

            {/* Autocomplete: clientes que já se cadastraram/participaram.
                Cadastradas pela live aparecem primeiro (badge). */}
            {onlyInstagram && atMatches.length > 0 && (
              <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                {atMatches.map((m) => (
                  <button
                    key={m.customerId}
                    type="button"
                    onClick={() => pickMatch(m)}
                    className="flex w-full items-center gap-2 border-b border-slate-50 px-3 py-2 text-left last:border-0 hover:bg-rose-50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-800">
                        {m.name || m.instagram}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">
                        @{m.instagram}
                        {m.phone ? ` · ${m.phone}` : ''}
                      </div>
                    </div>
                    {m.registered && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                        cadastrou na live
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* VERIFICADOR: essa @ já tem carrinho aberto na live */}
          {igDup && onUseExisting && (
            <div className="rounded-lg border-2 border-amber-400 bg-amber-50 p-2.5">
              <div className="text-xs font-bold text-amber-800">
                ⚠️ @{normIg(igDup.customerInstagram)} já está na live — carrinho aberto
                {' '}({igDup.items?.length || 0} item{(igDup.items?.length || 0) === 1 ? '' : 's'} · {brl(igDup.totalCents)})
              </div>
              <button
                type="button"
                onClick={() => onUseExisting(igDup)}
                className="mt-2 w-full rounded-lg bg-amber-600 py-2 text-sm font-bold text-white hover:bg-amber-700"
              >
                Usar esse carrinho (não duplicar)
              </button>
            </div>
          )}

          {/* Nome/telefone/CPF/e-mail — OPCIONAIS. Na abertura de carrinho
              (onlyInstagram) ficam ocultos: só o @ importa na hora da live;
              o resto se completa depois no "Editar cliente". */}
          {!onlyInstagram && (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (opcional)" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              <input value={phone} onChange={(e) => setPhone(maskPhoneBR(e.target.value))} placeholder="Telefone (opcional)" inputMode="tel" maxLength={15} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="CPF (opcional)" className="rounded-lg border border-slate-300 px-3 py-2" />
                <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail (opcional)" className="rounded-lg border border-slate-300 px-3 py-2" />
              </div>
            </>
          )}

          {showAddress && (
            <div className="mt-1 space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Endereço de entrega (opcional — CEP puxa o resto)
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={cep}
                  onChange={(e) => { setCep(e.target.value); lookupCep(e.target.value); }}
                  placeholder="CEP"
                  inputMode="numeric"
                  maxLength={9}
                  className="w-32 rounded-lg border border-slate-300 px-3 py-2"
                />
                {cepLoading && <span className="text-xs text-slate-400">buscando…</span>}
              </div>
              <input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="Rua / logradouro" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              <div className="grid grid-cols-2 gap-2">
                <input value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="Número" className="rounded-lg border border-slate-300 px-3 py-2" />
                <input value={complemento} onChange={(e) => setComplemento(e.target.value)} placeholder="Complemento" className="rounded-lg border border-slate-300 px-3 py-2" />
              </div>
              <input value={bairro} onChange={(e) => setBairro(e.target.value)} placeholder="Bairro" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
              <div className="grid grid-cols-[1fr_72px] gap-2">
                <input value={cidade} onChange={(e) => setCidade(e.target.value)} placeholder="Cidade" className="rounded-lg border border-slate-300 px-3 py-2" />
                <input value={uf} onChange={(e) => setUf(e.target.value.toUpperCase().slice(0, 2))} placeholder="UF" maxLength={2} className="rounded-lg border border-slate-300 px-3 py-2 uppercase" />
              </div>
            </div>
          )}
        </div>
        <button type="submit" className="mt-4 w-full rounded-lg bg-rose-600 py-2.5 font-semibold text-white hover:bg-rose-700">
          {submitLabel}
        </button>
      </form>
    </div>
  );
}

/* ─── Dashboard ─── */
function Dashboard({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api(`/live-pdv/sessions/${sessionId}/dashboard`)
        .then((d) => alive && setData(d))
        .catch(() => {});
    load();
    const iv = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [sessionId]);

  if (!data) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-500">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando dashboard…
      </div>
    );
  }
  const k = data.kpis;
  const cards = [
    { label: 'Clientes atendidas', value: k.clientesAtendidas },
    { label: 'Carrinhos em aberto', value: k.carrinhosAbertos ?? 0 },
    { label: 'Valor nos carrinhos', value: brl(k.valorNosCarrinhosCents ?? 0) },
    { label: 'Pedidos criados', value: k.pedidosCriados },
    { label: 'Pedidos pagos', value: k.pedidosPagos },
    { label: 'Faturamento', value: brl(k.faturamentoCents) },
    { label: 'Ticket médio', value: brl(k.ticketMedioCents) },
    { label: 'Peças vendidas', value: k.pecasVendidas },
    { label: 'Reservas ativas', value: k.reservasAtivas },
    // Sem funil (backend antigo) mantém o card simples de conversão
    ...(k.funil ? [] : [{ label: 'Conversão', value: `${k.conversao}%` }]),
  ];
  // Funil em camadas: criados → com produto → pagos (cada barra é % dos criados)
  const funilRows = k.funil
    ? [
        { label: 'Carrinhos criados', n: k.funil.criados, pctBar: 100, detalhe: 'comentou e abriu carrinho' },
        { label: 'Com produto', n: k.funil.comProduto, pctBar: k.funil.pctComProduto, detalhe: `${k.funil.pctComProduto}% dos criados` },
        { label: 'Pagos', n: k.funil.pagos, pctBar: k.funil.pctPagosDoTotal, detalhe: `${k.funil.pctPagosDosComProduto}% dos com produto · ${k.funil.pctPagosDoTotal}% do total` },
      ]
    : [];
  return (
    <div className="p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-400">{c.label}</div>
            <div className="mt-1 text-2xl font-extrabold text-slate-900">{c.value}</div>
          </div>
        ))}
      </div>

      {/* Funil de conversão em camadas: criados → com produto → pagos */}
      {funilRows.length > 0 && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-slate-400">Conversão — funil da live</span>
            <span className="text-xs text-slate-400">cada barra é % dos carrinhos criados</span>
          </div>
          <div className="space-y-2.5">
            {funilRows.map((r, i) => (
              <div key={r.label} className="flex items-center gap-3">
                <span className="w-36 shrink-0 text-sm font-semibold text-slate-700">{r.label}</span>
                <div className="relative h-7 flex-1 overflow-hidden rounded-lg bg-slate-100">
                  <div
                    className={`h-full rounded-lg transition-all ${i === 0 ? 'bg-slate-300' : i === 1 ? 'bg-amber-300' : 'bg-emerald-400'}`}
                    style={{ width: `${Math.max(r.pctBar, r.n > 0 ? 3 : 0)}%` }}
                  />
                  <span className="absolute inset-y-0 left-2 flex items-center text-sm font-extrabold text-slate-800 tabular-nums">
                    {r.n}
                  </span>
                </div>
                <span className="w-64 shrink-0 text-right text-xs text-slate-500">{r.detalhe}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quem já pagou — conferência ao vivo (nome, valor, forma, status) */}
      <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-semibold text-slate-800">💰 Clientes que pagaram ({(data.pagos || []).length})</span>
          <span className="text-xs text-slate-400">mais recente primeiro</span>
        </div>
        {(!data.pagos || data.pagos.length === 0) && (
          <div className="py-4 text-center text-sm text-slate-400">Nenhum pagamento confirmado ainda.</div>
        )}
        <div className="space-y-1">
          {(data.pagos || []).map((p: any) => (
            <div key={p.cartId} className="flex items-center gap-2 border-b border-slate-50 py-1.5 text-sm">
              {p.cartNumber != null && (
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-600">
                  {p.cartNumber}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-slate-700">
                <span className="font-semibold text-slate-900">{p.customerName || 'cliente'}</span>
                {p.customerInstagram ? <span className="text-slate-400"> @{p.customerInstagram}</span> : null}
              </span>
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-500">
                {p.paymentMethod === 'link' ? 'Link/cartão' : p.paymentMethod === 'pix' ? 'PIX' : '—'}
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                  p.status === 'delivered'
                    ? 'bg-emerald-100 text-emerald-700'
                    : p.status === 'shipped'
                    ? 'bg-blue-100 text-blue-700'
                    : p.status === 'separating'
                    ? 'bg-violet-100 text-violet-700'
                    : 'bg-amber-100 text-amber-700'
                }`}
              >
                {p.status === 'delivered' ? 'Entregue' : p.status === 'shipped' ? 'Enviado' : p.status === 'separating' ? 'Separação' : 'Pago'}
              </span>
              <span className="shrink-0 font-bold tabular-nums text-emerald-700">{brl(p.totalCents)}</span>
              <span className="shrink-0 text-xs tabular-nums text-slate-400">
                {p.paidAt ? new Date(p.paidAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 font-semibold text-slate-800">Produtos mais vendidos</div>
        {(!data.topProducts || data.topProducts.length === 0) && (
          <div className="py-4 text-center text-sm text-slate-400">Nenhuma venda ainda.</div>
        )}
        <div className="space-y-1">
          {(data.topProducts || []).map((p: any) => (
            <div key={p.ref} className="flex items-center justify-between border-b border-slate-50 py-1.5 text-sm">
              <span className="truncate text-slate-700">
                <span className="font-semibold text-rose-600">{p.ref}</span> · {p.descricao}
              </span>
              <span className="shrink-0 font-semibold text-slate-800">
                {p.qty} pç · {brl(p.valorCents)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── LEGENDA DA LIVE — atalhos curtos → referência completa ─────────────────
// A equipe monta a sequência dos produtos ANTES da transmissão: cada linha tem
// um ATALHO (01, 02...) e a REFERÊNCIA completa. Cada referência é validada na
// hora pela MESMA rota GET /live-pdv/search usada pelo operador durante a live
// (zero lógica de busca paralela) e a prévia mostra exatamente a grade que vai
// abrir na transmissão. Linha inválida NÃO salva (o backend revalida no POST).
type LegendaStatus = 'vazia' | 'buscando' | 'ok' | 'nao_encontrada' | 'ambigua' | 'erro';
type LegendaRow = {
  id: string | null;
  atalho: string;
  refCode: string;
  status: LegendaStatus;
  grade: any | null;
  erro: string | null;
  salva: boolean;      // true = persistida e sem edição pendente
  salvando: boolean;
};

function LegendaModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [rows, setRows] = useState<LegendaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [topErr, setTopErr] = useState<string | null>(null);
  // Debounce por linha: digitou → 700ms → valida (cancela o timer anterior)
  const timersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  // Sequência por linha: descarta resposta de validação antiga (digitação rápida)
  const seqRef = useRef<Record<number, number>>({});

  const patchRow = (idx: number, patch: Partial<LegendaRow>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  // Valida UMA linha usando a MESMA busca da live (com sessionId — inclusive
  // preço promocional aparece igualzinho ao que o operador vê).
  const validarLinha = useCallback(async (idx: number, refCode: string) => {
    const q = refCode.trim();
    if (!q) { patchRow(idx, { status: 'vazia', grade: null, erro: null }); return; }
    const seq = (seqRef.current[idx] = (seqRef.current[idx] || 0) + 1);
    patchRow(idx, { status: 'buscando', erro: null });
    try {
      const r = await api<any>(
        `/live-pdv/search?term=${encodeURIComponent(q)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (seq !== seqRef.current[idx]) return; // resposta velha — descarta
      if (!r?.found) {
        patchRow(idx, { status: 'nao_encontrada', grade: null, erro: null });
      } else if (!r.exactMatch && (r.matchedRefs?.length || 0) > 1) {
        patchRow(idx, { status: 'ambigua', grade: r, erro: null });
      } else {
        patchRow(idx, { status: 'ok', grade: r, erro: null });
      }
    } catch (e: any) {
      if (seq !== seqRef.current[idx]) return;
      patchRow(idx, { status: 'erro', grade: null, erro: e?.message || 'Falha na busca' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Carrega linhas salvas e REVALIDA uma a uma (a equipe confere tudo antes
  // da live — estoque pode ter mudado desde o cadastro).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const salvos = await api<any[]>(`/live-pdv/sessions/${sessionId}/atalhos`);
        if (cancelled) return;
        const iniciais: LegendaRow[] = (salvos || []).map((a) => ({
          id: a.id, atalho: a.atalho, refCode: a.refCode,
          status: 'buscando' as LegendaStatus, grade: null, erro: null, salva: true, salvando: false,
        }));
        if (iniciais.length === 0) {
          iniciais.push({ id: null, atalho: '01', refCode: '', status: 'vazia', grade: null, erro: null, salva: false, salvando: false });
        }
        setRows(iniciais);
        setLoading(false);
        // Revalidação sequencial (não afoga o backend com N buscas paralelas)
        for (let i = 0; i < iniciais.length; i++) {
          if (cancelled) return;
          if (iniciais[i].refCode.trim()) await validarLinha(i, iniciais[i].refCode);
          else patchRow(i, { status: 'vazia' });
        }
      } catch (e: any) {
        if (!cancelled) { setTopErr(e?.message || 'Falha ao carregar a legenda'); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const onRefChange = (idx: number, value: string) => {
    patchRow(idx, { refCode: value, salva: false, status: value.trim() ? 'buscando' : 'vazia', grade: null });
    if (timersRef.current[idx]) clearTimeout(timersRef.current[idx]);
    timersRef.current[idx] = setTimeout(() => validarLinha(idx, value), 700);
  };

  const proximoAtalho = (lista: LegendaRow[]): string => {
    const nums = lista.map((r) => parseInt(r.atalho, 10)).filter((n) => !isNaN(n));
    const prox = (nums.length ? Math.max(...nums) : 0) + 1;
    return String(prox).padStart(2, '0');
  };

  const addLinha = () =>
    setRows((prev) => [...prev, {
      id: null, atalho: proximoAtalho(prev), refCode: '',
      status: 'vazia' as LegendaStatus, grade: null, erro: null, salva: false, salvando: false,
    }]);

  const salvarLinha = async (idx: number) => {
    const row = rows[idx];
    if (row.status !== 'ok' || !row.atalho.trim()) return;
    patchRow(idx, { salvando: true, erro: null });
    try {
      const r = await api<any>(`/live-pdv/sessions/${sessionId}/atalhos`, {
        method: 'POST',
        body: JSON.stringify({ id: row.id, atalho: row.atalho, refCode: row.refCode.trim() }),
      });
      patchRow(idx, { id: r?.atalho?.id || row.id, atalho: r?.atalho?.atalho || row.atalho, salva: true, salvando: false });
    } catch (e: any) {
      patchRow(idx, { salvando: false, erro: e?.message || 'Falha ao salvar' });
    }
  };

  const removerLinha = async (idx: number) => {
    const row = rows[idx];
    if (row.id) {
      try {
        await api(`/live-pdv/sessions/${sessionId}/atalhos/${row.id}/delete`, { method: 'POST' });
      } catch (e: any) {
        patchRow(idx, { erro: e?.message || 'Falha ao excluir' });
        return;
      }
    }
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const pendentes = rows.filter((r) => r.refCode.trim() && (!r.salva || r.status !== 'ok')).length;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-3 sm:p-6 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <h2 className="text-lg font-bold text-slate-800">📋 Legenda da Live</h2>
            <p className="text-xs text-slate-500">
              Atalho curto → referência completa. Cada linha é validada pela <b>mesma busca da live</b> —
              a grade abaixo é exatamente o que o operador vai ver ao digitar o atalho.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>

        {topErr && <div className="mx-5 mt-3 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800">{topErr}</div>}

        <div className="max-h-[70vh] overflow-y-auto px-5 py-3 space-y-3">
          {loading && (
            <div className="flex items-center gap-2 py-8 justify-center text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando legenda…
            </div>
          )}

          {!loading && (
            <div className="grid grid-cols-[80px_1fr_40px] gap-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 px-1">
              <span>Atalho</span><span>Referência</span><span />
            </div>
          )}

          {!loading && rows.map((row, idx) => (
            <div key={idx} className={`rounded-xl border-2 p-2.5 space-y-2 ${
              row.status === 'ok' ? 'border-emerald-300 bg-emerald-50/40'
              : row.status === 'nao_encontrada' || row.status === 'erro' ? 'border-rose-300 bg-rose-50/40'
              : row.status === 'ambigua' ? 'border-amber-300 bg-amber-50/40'
              : 'border-slate-200'
            }`}>
              <div className="grid grid-cols-[80px_1fr_40px] gap-2 items-center">
                <input
                  value={row.atalho}
                  onChange={(e) => patchRow(idx, { atalho: e.target.value.toUpperCase(), salva: false })}
                  placeholder="01"
                  className="rounded-lg border-2 border-slate-300 px-2 py-2 text-center text-base font-black tracking-widest focus:border-violet-500 focus:outline-none"
                  maxLength={10}
                />
                <input
                  value={row.refCode}
                  onChange={(e) => onRefChange(idx, e.target.value.toUpperCase())}
                  placeholder="Referência completa (ex: VLM-222)"
                  className="rounded-lg border-2 border-slate-300 px-3 py-2 text-sm font-semibold focus:border-violet-500 focus:outline-none"
                />
                <button
                  onClick={() => removerLinha(idx)}
                  title="Remover esta linha"
                  className="justify-self-center text-slate-400 hover:text-rose-600"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {/* Status + prévia — exatamente o resultado da busca da live */}
              {row.status === 'buscando' && (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Validando pela busca da live…
                </div>
              )}
              {row.status === 'nao_encontrada' && (
                <div className="text-xs font-bold text-rose-700">
                  🔴 Referência não encontrada. Confira a referência informada.
                </div>
              )}
              {row.status === 'ambigua' && (
                <div className="text-xs font-bold text-amber-700">
                  🟠 Referência possui mais de um resultado ({(row.grade?.matchedRefs || []).slice(0, 5).join(', ')}
                  {(row.grade?.matchedRefs?.length || 0) > 5 ? '…' : ''}). Informe a referência completa.
                </div>
              )}
              {row.status === 'erro' && (
                <div className="text-xs font-bold text-rose-700">🔴 {row.erro || 'Falha na validação'}</div>
              )}

              {row.status === 'ok' && row.grade && (
                <div className="rounded-lg bg-white border border-emerald-200 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-bold text-emerald-700">🟢 Referência validada</div>
                    <div className="text-xs font-black text-emerald-700 tabular-nums">
                      {((row.grade.priceCents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                      {row.grade.promoActive ? ' (promo da live)' : ''}
                    </div>
                  </div>
                  <div className="text-sm font-bold text-slate-800">{row.grade.descricao}</div>
                  <div className="text-[11px] text-slate-500">
                    Referência: <b>{row.grade.ref}</b> · {row.grade.totalRede} peças na rede
                  </div>
                  {/* Grade por cor × tamanho — mesmo dado que abre na live */}
                  {(() => {
                    const porCor = new Map<string, any[]>();
                    for (const c of row.grade.cells || []) {
                      const cor = c.cor || '—';
                      if (!porCor.has(cor)) porCor.set(cor, []);
                      porCor.get(cor)!.push(c);
                    }
                    return Array.from(porCor.entries()).map(([cor, cells]) => (
                      <div key={cor} className="text-xs">
                        <span className="font-bold text-slate-600">{cor}:</span>{' '}
                        <span className="tabular-nums">
                          {cells.map((c: any) => `${c.tamanho || '—'} ${c.available} pç`).join(' · ')}
                        </span>
                      </div>
                    ));
                  })()}
                </div>
              )}

              {row.erro && row.status !== 'erro' && (
                <div className="text-xs font-bold text-rose-700">🔴 {row.erro}</div>
              )}

              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-400">
                  {row.salva ? '✓ salvo — o operador já pode digitar o atalho' : row.id ? 'editado — salve de novo' : 'não salvo'}
                </span>
                <button
                  onClick={() => salvarLinha(idx)}
                  disabled={row.status !== 'ok' || !row.atalho.trim() || row.salvando || row.salva}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={row.status !== 'ok' ? 'Só salva com a referência validada (🟢)' : 'Salvar esta linha'}
                >
                  {row.salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : row.salva ? 'Salvo ✓' : 'Salvar'}
                </button>
              </div>
            </div>
          ))}

          {!loading && (
            <button
              onClick={addLinha}
              className="w-full rounded-xl border-2 border-dashed border-slate-300 py-2.5 text-sm font-bold text-slate-500 hover:border-violet-400 hover:text-violet-600"
            >
              + Adicionar linha
            </button>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3">
          <span className="text-xs text-slate-500">
            {pendentes > 0
              ? `⚠️ ${pendentes} linha(s) inválida(s) ou não salva(s) — corrija antes da live`
              : rows.some((r) => r.salva)
                ? '✓ Legenda pronta — todos os atalhos validados'
                : 'Preencha atalho + referência; a validação roda sozinha'}
          </span>
          <button onClick={onClose} className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-bold text-white hover:bg-slate-700">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
