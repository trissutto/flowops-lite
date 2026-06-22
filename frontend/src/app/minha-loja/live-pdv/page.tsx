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
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
  Plus,
  QrCode,
  Search,
  ShoppingCart,
  Store,
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

export default function LivePdvPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState('');
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<'console' | 'dashboard'>('console');

  // Busca / grade
  const [term, setTerm] = useState('');
  const [product, setProduct] = useState<GradeResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [expandedCell, setExpandedCell] = useState<string | null>(null);
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
    return () => {
      socket.off('live-pdv:cart-paid', onChange);
      socket.off('live-pdv:reservations-expired', onChange);
      socket.off('live-pdv:item-shipped', onChange);
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

  // ─── Busca ────────────────────────────────────────────────────────────────
  async function doSearch(e?: React.FormEvent) {
    e?.preventDefault();
    const q = term.trim();
    if (!q) return;
    setSearching(true);
    setProduct(null);
    try {
      const res = await api<GradeResult>(`/live-pdv/search?term=${encodeURIComponent(q)}`);
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
                    <div className="mt-1 text-2xl font-extrabold text-slate-900">{brl(product.priceCents || 0)}</div>
                    <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      <Package className="h-3 w-3" /> {product.totalRede} na rede
                    </div>
                  </div>
                </div>

                {/* Grade */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {(product.cells || []).map((cell) => {
                    const out = cell.available <= 0;
                    const isOpen = expandedCell === cell.itemKey;
                    return (
                      <div key={cell.itemKey} className="rounded-lg border border-slate-200">
                        <button
                          onClick={() => clickCell(cell)}
                          disabled={out || adding === cell.itemKey}
                          className={`flex w-full flex-col items-start gap-0.5 rounded-t-lg p-2.5 text-left transition ${
                            out
                              ? 'cursor-not-allowed bg-slate-50 opacity-50'
                              : 'bg-white hover:border-rose-300 hover:bg-rose-50'
                          }`}
                        >
                          <div className="flex w-full items-center justify-between">
                            <span className="font-bold text-slate-800">{cell.cor || '—'}</span>
                            {adding === cell.itemKey ? (
                              <Loader2 className="h-4 w-4 animate-spin text-rose-500" />
                            ) : (
                              <Plus className={`h-4 w-4 ${out ? 'text-slate-300' : 'text-rose-500'}`} />
                            )}
                          </div>
                          <div className="text-2xl font-extrabold leading-none text-slate-900">
                            {cell.tamanho || '—'}
                          </div>
                          <div
                            className={`text-xs font-semibold ${
                              cell.available <= 2 ? 'text-amber-600' : 'text-emerald-600'
                            }`}
                          >
                            {cell.available} disp.
                          </div>
                        </button>
                        <button
                          onClick={() => setExpandedCell(isOpen ? null : cell.itemKey)}
                          className="flex w-full items-center justify-center gap-1 border-t border-slate-100 py-1 text-[11px] text-slate-400 hover:text-slate-600"
                        >
                          {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          por loja
                        </button>
                        {isOpen && (
                          <div className="space-y-0.5 border-t border-slate-100 px-2.5 py-1.5 text-[11px] text-slate-600">
                            {cell.perStore.length === 0 && <div className="text-slate-400">sem estoque</div>}
                            {cell.perStore.map((ps) => (
                              <div key={ps.storeCode} className="flex justify-between">
                                <span className="truncate">{ps.storeName}</span>
                                <span className="font-semibold">{ps.qty}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Lista de clientes da live */}
            {carts.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Clientes da live ({carts.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {carts.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => openCart(c)}
                      className={`rounded-lg border px-3 py-1.5 text-left text-sm ${
                        cart?.id === c.id ? 'border-rose-400 bg-rose-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="font-semibold text-slate-800">{c.customerName}</div>
                      <div className="text-xs text-slate-500">
                        {c.items.length} itens · {brl(c.totalCents)} · {STATUS_LABEL[c.status] || c.status}
                      </div>
                    </button>
                  ))}
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
    if (!name.trim() || !phone.trim()) {
      alert('Nome e telefone são obrigatórios');
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
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Telefone *" inputMode="tel" className="w-full rounded-lg border border-slate-300 px-3 py-2" />
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
