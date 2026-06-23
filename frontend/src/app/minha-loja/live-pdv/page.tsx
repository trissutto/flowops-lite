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
  Loader2,
  Package,
  Pencil,
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
  status: string;
  subtotalCents: number;
  freteCents: number;
  totalCents: number;
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
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<'console' | 'dashboard'>('console');

  // Busca / grade
  const [term, setTerm] = useState('');
  const [product, setProduct] = useState<GradeResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [promoEditing, setPromoEditing] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Cliente / carrinho
  const [activeCustomer, setActiveCustomer] = useState<ActiveCustomer | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [carts, setCarts] = useState<Cart[]>([]);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [pendingCell, setPendingCell] = useState<GradeCell | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  // Pagamento
  const [qr, setQr] = useState<{ text: string; img: string; valor: number } | null>(null);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);

  // ─── Boot: pega sessão "live" ou cria uma ─────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const list = await api<any[]>('/live-pdv/sessions');
        const live = (list || []).find((s) => s.status === 'live');
        if (live) {
          setSessionId(live.id);
          setSessionTitle(live.title);
        }
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
    const title = prompt('Título da live:', `Live ${new Date().toLocaleDateString('pt-BR')}`);
    if (title === null) return;
    try {
      const s = await api<any>('/live-pdv/sessions', {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      setSessionId(s.id);
      setSessionTitle(s.title);
    } catch (e: any) {
      alert('Erro ao criar sessão: ' + (e?.message || e));
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
    } catch (e: any) {
      alert('Erro ao remover promo: ' + (e?.message || e));
    }
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
      const res = await api<GradeResult>(`/live-pdv/search?term=${encodeURIComponent(q)}${sid}`);
      setProduct(res);
    } catch (err: any) {
      setProduct({ found: false });
    } finally {
      setSearching(false);
    }
  }

  // ─── Clique na grade ──────────────────────────────────────────────────────
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

  function openCart(c: Cart) {
    setCart(c);
    setActiveCustomer({
      id: '',
      name: c.customerName,
      phone: c.customerPhone,
      instagram: c.customerInstagram,
    });
    setQr(null);
    setPaid(false);
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
  async function chargePix() {
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

  // Poll status enquanto QR aberto
  useEffect(() => {
    if (!qr || !cart || paid) return;
    const iv = setInterval(async () => {
      try {
        const res = await api<{ paid: boolean; cart: Cart }>(
          `/live-pdv/carts/${cart.id}/payment-status`,
        );
        if (res.paid) {
          setPaid(true);
          setCart(res.cart);
          setQr(null);
          refreshCarts();
        }
      } catch {}
    }, 4000);
    return () => clearInterval(iv);
  }, [qr, cart, paid, refreshCarts]);

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
        <p className="text-slate-500">Nenhuma live ativa no momento.</p>
        <button
          onClick={createSession}
          className="rounded-lg bg-rose-600 px-5 py-2.5 font-semibold text-white hover:bg-rose-700"
        >
          ▶ Iniciar nova live
        </button>
        <Link href="/minha-loja" className="text-sm text-slate-400 hover:text-slate-600">
          Voltar
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100">
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
        <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_380px]">
          {/* Coluna principal: busca + grade */}
          <div>
            <form onSubmit={doSearch} className="mb-4 flex gap-2">
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
                      <div className="mt-1 flex items-center gap-2">
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
                            setPromoEditing(true);
                          }}
                          title="Definir preço promocional da live"
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:border-rose-300 hover:text-rose-600"
                        >
                          <Pencil className="h-3.5 w-3.5" /> Preço
                        </button>
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
                              <th key={s} className="min-w-[48px] px-2 py-2 text-center font-bold text-slate-700">
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
                                        className={`mx-auto flex h-10 w-full items-center justify-center rounded font-extrabold transition ${
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
              </div>
            )}

            {/* Clientes da live — destaque e ordem alfabética pra achar rápido na live */}
            {carts.length > 0 && (
              <div className="mt-5">
                <div className="mb-2 flex items-center gap-2">
                  <User className="h-5 w-5 text-rose-500" />
                  <span className="text-base font-bold uppercase tracking-wide text-slate-800">
                    Clientes da live ({carts.length})
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
                  {[...carts]
                    .sort((a, b) =>
                      (a.customerName || '').localeCompare(b.customerName || '', 'pt-BR', { sensitivity: 'base' }),
                    )
                    .map((c) => {
                      const active = cart?.id === c.id;
                      const isOpen = c.status === 'open' || c.status === 'awaiting_payment';
                      return (
                        <button
                          key={c.id}
                          onClick={() => openCart(c)}
                          className={`rounded-xl border-2 p-3 text-left transition ${
                            active
                              ? 'border-rose-500 bg-rose-50 shadow-md'
                              : isOpen
                              ? 'border-rose-200 bg-white hover:border-rose-400 hover:shadow'
                              : 'border-slate-200 bg-slate-50 hover:bg-white'
                          }`}
                        >
                          <div className="truncate text-base font-bold text-slate-900" title={c.customerName}>
                            {c.customerName}
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-slate-600">
                              {c.items.length} {c.items.length === 1 ? 'item' : 'itens'}
                            </span>
                            <span className="text-sm font-extrabold text-slate-900">{brl(c.totalCents)}</span>
                          </div>
                          <span
                            className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                              STATUS_PILL[c.status] || 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {STATUS_LABEL[c.status] || c.status}
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          {/* Sidebar: carrinho */}
          <CartPanel
            cart={cart}
            activeCustomer={activeCustomer}
            qr={qr}
            paid={paid}
            paying={paying}
            onNewClient={newClient}
            onRemoveItem={removeItem}
            onChargePix={chargePix}
          />
        </div>
      )}

      {/* Modal cliente */}
      {showCustomerModal && (
        <CustomerModal
          onClose={() => {
            setShowCustomerModal(false);
            setPendingCell(null);
          }}
          onSave={saveCustomerAndAdd}
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
}: {
  cart: Cart | null;
  activeCustomer: ActiveCustomer | null;
  qr: { text: string; img: string; valor: number } | null;
  paid: boolean;
  paying: boolean;
  onNewClient: () => void;
  onRemoveItem: (id: string) => void;
  onChargePix: () => void;
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
            <UserPlus className="h-3.5 w-3.5" /> Nova cliente
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
              <div className="min-w-0">
                <div className="truncate font-semibold text-slate-800">
                  {cart?.customerName || activeCustomer?.name}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {cart?.customerPhone || activeCustomer?.phone}
                  {(cart?.customerInstagram || activeCustomer?.instagram) &&
                    ` · @${cart?.customerInstagram || activeCustomer?.instagram}`}
                </div>
              </div>
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
                    <span>Frete</span>
                    <span>{brl(cart.freteCents)}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-bold text-slate-900">
                  <span>Total</span>
                  <span>{brl(cart.totalCents)}</span>
                </div>
              </div>
            )}

            {/* Pagamento */}
            {paid ? (
              <div className="mt-3 flex flex-col items-center gap-1 rounded-lg bg-emerald-50 p-4 text-emerald-700">
                <Check className="h-8 w-8" />
                <span className="font-bold">Pagamento confirmado!</span>
                <span className="text-xs">Ordem de separação enviada à loja de origem.</span>
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
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> Aguardando pagamento…
                </div>
              </div>
            ) : (
              cart &&
              cart.items.some((i) => i.status === 'reserved') && (
                <button
                  onClick={onChargePix}
                  disabled={paying}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-3 font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {paying ? <Loader2 className="h-5 w-5 animate-spin" /> : <QrCode className="h-5 w-5" />}
                  Cobrar PIX ({brl(cart.totalCents)})
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Modal de cliente ─── */
function CustomerModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (f: { name: string; phone: string; instagram: string; cpf: string; email: string }) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [instagram, setInstagram] = useState('');
  const [cpf, setCpf] = useState('');
  const [email, setEmail] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      alert('Nome é obrigatório');
      return;
    }
    onSave({ name, phone, instagram, cpf, email });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-bold text-slate-800">
            <UserPlus className="h-5 w-5 text-rose-500" /> Identificar cliente
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-2.5">
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome *" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Telefone (opcional)" inputMode="tel" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
          <input value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="Instagram (@)" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
          <div className="grid grid-cols-2 gap-2">
            <input value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="CPF (opcional)" className="rounded-lg border border-slate-300 px-3 py-2" />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail (opcional)" className="rounded-lg border border-slate-300 px-3 py-2" />
          </div>
        </div>
        <button type="submit" className="mt-4 w-full rounded-lg bg-rose-600 py-2.5 font-semibold text-white hover:bg-rose-700">
          Salvar e adicionar item
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
