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
  Search,
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
}
interface Cart {
  id: string;
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
  const [activeLive, setActiveLive] = useState<{ id: string; title: string } | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<'console' | 'dashboard'>('console');

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
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [pendingCell, setPendingCell] = useState<GradeCell | null>(null);
  // Aviso rápido "adicionado a Fulana" após fechar o carrinho.
  const [addedFlash, setAddedFlash] = useState<string | null>(null);
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
        if (live) setActiveLive({ id: live.id, title: live.title });
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

  // Realtime: atualiza listas quando algo muda
  useEffect(() => {
    if (!sessionId) return;
    const socket = getSocket();
    const onChange = () => refreshCarts();
    socket.on('live-pdv:cart-paid', onChange);
    socket.on('live-pdv:reservations-expired', onChange);
    socket.on('live-pdv:item-shipped', onChange);
    socket.on('live-pdv:promo', onChange);
    return () => {
      socket.off('live-pdv:cart-paid', onChange);
      socket.off('live-pdv:reservations-expired', onChange);
      socket.off('live-pdv:item-shipped', onChange);
      socket.off('live-pdv:promo', onChange);
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
    const title = prompt('Título da nova live:', `Live ${new Date().toLocaleDateString('pt-BR')}`);
    if (title === null) return;
    try {
      const s = await api<any>('/live-pdv/sessions', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      setActiveLive(null);
      setSessionId(s.id);
      setSessionTitle(s.title);
    } catch (e: any) {
      alert('Erro ao criar sessão: ' + (e?.message || e));
    }
  }

  // Continua a live que já estava aberta (sem fechar nada).
  function continueLive() {
    if (!activeLive) return;
    setSessionId(activeLive.id);
    setSessionTitle(activeLive.title);
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

  // ─── Busca ────────────────────────────────────────────────────────────────
  async function doSearch(e?: React.FormEvent) {
    e?.preventDefault();
    const q = term.trim();
    if (!q) return;
    setSearching(true);
    setProduct(null);
    setPromoEditing(false);
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
        refCode: product.ref,
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
          refCode: product.ref,
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
          refCode: product.ref,
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
      </div>
    );
  }

  // Lista de clientes filtrada (por nome ou @) e ordenada alfabeticamente.
  const clientesFiltradas = (() => {
    const q = clientFilter.trim().toLowerCase();
    const qIg = q.replace(/^@/, '');
    return [...carts]
      .filter(
        (c) =>
          !q ||
          (c.customerName || '').toLowerCase().includes(q) ||
          (c.customerInstagram || '').toLowerCase().replace(/^@/, '').includes(qIg),
      )
      .sort((a, b) =>
        (a.customerName || '').localeCompare(b.customerName || '', 'pt-BR', { sensitivity: 'base' }),
      );
  })();

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Aviso rápido: peça adicionada + carrinho fechado (segurança) */}
      {addedFlash && (
        <div className="fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg">
          ✓ Adicionado a {addedFlash} · carrinho fechado
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
          onClick={closeLive}
          title="Fechar esta live — guarda os carrinhos e libera pra abrir uma nova"
          className="rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-slate-500 hover:border-rose-300 hover:text-rose-600"
        >
          Fechar live
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
        <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_460px]">
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
            </form>

            {product && !product.found && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center text-amber-700">
                Nada encontrado para “{term}”.
              </div>
            )}

            {product && product.found && (
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                {product.fromMirror && (
                  <div className="mb-3 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-500">
                    <Package className="h-3 w-3" /> Estoque do espelho · atualiza de hora em hora
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
              onChargePix={startPix}
              onChargeLink={startLink}
              onEditCustomer={() => setEditCustomerOpen(true)}
              onDeleteCart={deleteCart}
              onCalcFrete={calcFrete}
              onContinue={continueAttending}
              onConfirmPayment={confirmPayment}
              confirming={confirming}
            />

            {/* Clientes da live — na lateral pra não ser empurrada pela grade */}
            {carts.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <User className="h-5 w-5 text-rose-500" />
                    <span className="text-sm font-bold uppercase tracking-wide text-slate-800">
                      Clientes da live ({clientesFiltradas.length}
                      {clientFilter.trim() && clientesFiltradas.length !== carts.length ? `/${carts.length}` : ''})
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
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={clientFilter}
                    onChange={(e) => setClientFilter(e.target.value)}
                    placeholder="Buscar cliente por nome ou @"
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
                <div className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white">
                  {clientesFiltradas.length === 0 && (
                    <div className="px-3 py-4 text-center text-sm text-slate-400">
                      Nenhuma cliente encontrada.
                    </div>
                  )}
                  {clientesFiltradas.map((c) => {
                    const active = cart?.id === c.id;
                    return (
                      <div
                        key={c.id}
                        className={`flex w-full items-center transition ${
                          active ? 'bg-rose-50' : 'hover:bg-slate-50'
                        }`}
                        style={active ? { boxShadow: 'inset 4px 0 0 0 #e11d48' } : undefined}
                      >
                        <button
                          onClick={() => openCart(c)}
                          className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-1.5 text-left"
                        >
                          <div className="flex w-full items-center gap-2">
                            <span
                              className={`min-w-0 flex-1 truncate ${active ? 'font-extrabold text-rose-700' : 'font-semibold text-slate-800'}`}
                              title={c.customerName}
                            >
                              {c.customerName}
                            </span>
                            <span className="shrink-0 text-xs font-bold tabular-nums text-slate-900">
                              {brl(c.totalCents)}
                            </span>
                          </div>
                          <div className="flex w-full items-center gap-1.5 text-[10px] text-slate-500">
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
                          className="mr-1.5 shrink-0 rounded-md p-1.5 text-slate-400 transition hover:bg-rose-100 hover:text-rose-600"
                        >
                          <Trash2 className="h-4 w-4" />
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

      {/* Modal cliente — @ primeiro/obrigatório + verificador de @ duplicada */}
      {showCustomerModal && (
        <CustomerModal
          title="Identificar cliente (@)"
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
  onChargePix,
  onChargeLink,
  onEditCustomer,
  onDeleteCart,
  onCalcFrete,
  onContinue,
  onConfirmPayment,
  confirming,
}: {
  cart: Cart | null;
  activeCustomer: ActiveCustomer | null;
  qr: { text: string; img: string; valor: number; link?: string } | null;
  paid: boolean;
  paying: boolean;
  onNewClient: () => void;
  onRemoveItem: (id: string) => void;
  onChargePix: () => void;
  onChargeLink: () => void;
  onEditCustomer: () => void;
  onDeleteCart: () => void;
  onCalcFrete: () => void;
  onContinue: () => void;
  onConfirmPayment: () => void;
  confirming: boolean;
}) {
  return (
    <div className="lg:sticky lg:top-16 lg:h-fit">
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
                <div className="truncate font-semibold text-slate-800">
                  {cart?.customerName || activeCustomer?.name}
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
                  </div>
                  <div className="text-sm font-semibold text-slate-800">{brl(it.priceCents * it.qty)}</div>
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
                        ? '(PAC)'
                        : ''}
                    </span>
                    <span>{brl(cart.freteCents)}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-bold text-slate-900">
                  <span>Total</span>
                  <span>{brl(cart.totalCents)}</span>
                </div>
                <button
                  onClick={onCalcFrete}
                  title="Calcula o frete pelo CEP da cliente: SP = SEDEX R$ 9,99 · demais estados = PAC R$ 19,99"
                  className="mt-1 w-full rounded-lg border border-slate-300 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Calcular frete pelo CEP · SEDEX SP R$ 9,99 / PAC R$ 19,99
                </button>
              </div>
            )}

            {/* Pagamento */}
            {paid ? (
              <div className="mt-3 flex flex-col items-center gap-1 rounded-lg bg-emerald-50 p-4 text-emerald-700">
                <Check className="h-8 w-8" />
                <span className="font-bold">Pagamento confirmado!</span>
                <span className="text-xs">Ordem de separação enviada à loja de origem.</span>
                <button
                  onClick={onContinue}
                  className="mt-2 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
                >
                  Continuar atendendo →
                </button>
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

          {/* Nome — SEGUNDO e OPCIONAL (se vazio, usa a @) */}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (opcional)" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
          <input value={phone} onChange={(e) => setPhone(maskPhoneBR(e.target.value))} placeholder="Telefone (opcional)" inputMode="tel" maxLength={15} className="w-full rounded-lg border border-slate-300 px-3 py-2" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="CPF (opcional)" className="rounded-lg border border-slate-300 px-3 py-2" />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail (opcional)" className="rounded-lg border border-slate-300 px-3 py-2" />
          </div>

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
    { label: 'Pedidos criados', value: k.pedidosCriados },
    { label: 'Pedidos pagos', value: k.pedidosPagos },
    { label: 'Faturamento', value: brl(k.faturamentoCents) },
    { label: 'Ticket médio', value: brl(k.ticketMedioCents) },
    { label: 'Peças vendidas', value: k.pecasVendidas },
    { label: 'Reservas ativas', value: k.reservasAtivas },
    { label: 'Conversão', value: `${k.conversao}%` },
  ];
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
