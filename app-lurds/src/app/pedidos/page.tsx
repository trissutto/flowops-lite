'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShoppingBag, Loader2, Truck, Package, CheckCircle2, Clock, ExternalLink } from 'lucide-react';
import BottomNav from '@/components/BottomNav';
import { getOrders, isLoggedIn, type AppOrder } from '@/lib/api';

const STATUS_LABEL: Record<string, { label: string; color: string; icon: any }> = {
  pending: { label: 'Aguardando pagamento', color: 'text-amber-300', icon: Package },
  processing: { label: 'Processando', color: 'text-amber-300', icon: Package },
  routing: { label: 'Em separação', color: 'text-blue-300', icon: Package },
  awaiting_stock: { label: 'Aguardando estoque', color: 'text-amber-300', icon: Package },
  separating: { label: 'Separando', color: 'text-blue-300', icon: Package },
  ready: { label: 'Pronto pra envio', color: 'text-blue-300', icon: Package },
  shipped: { label: 'Postado', color: 'text-purple-300', icon: Truck },
  delivered: { label: 'Entregue', color: 'text-emerald-400', icon: CheckCircle2 },
  completed: { label: 'Finalizado', color: 'text-emerald-400', icon: CheckCircle2 },
  cancelled: { label: 'Cancelado', color: 'text-rose-300', icon: Package },
  refunded: { label: 'Estornado', color: 'text-rose-300', icon: Package },
};

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type PendingOrder = {
  token: string;
  createdAt: number;
  items: Array<{
    name: string;
    quantity: number;
    price: number;
    image?: string;
  }>;
  total: number;
  paymentMethod: 'pix' | 'credit_card';
  shippingLabel: string;
  checkoutUrl?: string;
};

const PENDING_KEY = 'lurds_pending_order';
const PENDING_TTL_MS = 60 * 60 * 1000; // 1h

function readPending(): PendingOrder | null {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PendingOrder;
    if (!data?.createdAt) return null;
    // Expira em 1h
    if (Date.now() - data.createdAt > PENDING_TTL_MS) {
      window.localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function clearPending() {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {}
}

// Detecta se algum pedido real bate com o pendente (mesma data ~ ±5min e mesmo total ±R$0,02)
function matchesRealOrder(pending: PendingOrder, orders: AppOrder[]): boolean {
  const pendingTime = pending.createdAt;
  return orders.some((o) => {
    if (!o.date) return false;
    const orderTime = new Date(o.date).getTime();
    const timeDiff = Math.abs(orderTime - pendingTime);
    const totalDiff = Math.abs((o.total || 0) - pending.total);
    // janela de 1h pra data + tolerância de R$0,02 pro total
    return timeDiff < 60 * 60 * 1000 && totalDiff < 0.02;
  });
}

export default function PedidosPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<AppOrder[]>([]);
  const [linkedStores, setLinkedStores] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingOrder | null>(null);

  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const pollStartedAt = useRef<number>(0);

  // Fetcher reaproveitado pelo polling
  const fetchOrders = async () => {
    try {
      const r = await getOrders();
      setOrders(r.orders);
      setLinkedStores(r.linkedStoresCount);
      return r.orders;
    } catch {
      return [];
    }
  };

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/entrar?next=/pedidos');
      return;
    }

    // 1. Lê pedido pendente do localStorage (se houver)
    const p = readPending();
    setPending(p);

    // 2. Busca pedidos reais
    fetchOrders().then((list) => {
      setLoading(false);
      // Se já achou o real, limpa pendente
      if (p && matchesRealOrder(p, list)) {
        clearPending();
        setPending(null);
      }
    });
  }, [router]);

  // 3. Polling automático enquanto houver pedido pendente
  //    A cada 15s, por até 5 minutos.
  useEffect(() => {
    if (!pending) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollStartedAt.current = Date.now();
    pollRef.current = setInterval(async () => {
      // Para o polling depois de 5 minutos
      if (Date.now() - pollStartedAt.current > 5 * 60 * 1000) {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        return;
      }
      const list = await fetchOrders();
      if (matchesRealOrder(pending, list)) {
        clearPending();
        setPending(null);
      }
    }, 15000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [pending]);

  return (
    <div className="pb-24">
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Meus pedidos</h1>
      </header>

      {loading && (
        <div className="text-center py-16 text-cream/60">
          <Loader2 className="w-8 h-8 animate-spin mx-auto" />
        </div>
      )}

      {!loading && (
        <>
          {/* PEDIDO PENDENTE (vindo do localStorage, antes do webhook chegar) */}
          {pending && (
            <section className="mt-6 px-5">
              <div className="rounded-2xl border-2 border-amber-500/40 bg-amber-900/10 p-4 relative overflow-hidden">
                {/* Pulse glow */}
                <div className="absolute -top-10 -right-10 w-32 h-32 bg-amber-500/10 rounded-full blur-2xl animate-pulse" />

                <div className="relative">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <div className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-amber-300 bg-amber-500/10 px-2 py-1 rounded-full">
                        <Clock className="w-3 h-3 animate-pulse" />
                        Aguardando pagamento
                      </div>
                      <div className="text-[10px] text-cream/40 mt-1 font-mono">
                        Criado há {Math.max(1, Math.floor((Date.now() - pending.createdAt) / 60000))} min
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-black text-amber-300 tabular-nums text-lg">
                        {brl(pending.total)}
                      </div>
                      <div className="text-[10px] text-cream/50 uppercase">
                        {pending.paymentMethod === 'pix' ? 'PIX' : 'Cartão'}
                      </div>
                    </div>
                  </div>

                  {/* Itens */}
                  <div className="space-y-1.5 mt-3">
                    {pending.items.slice(0, 3).map((it, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-xs">
                        {it.image && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={it.image} alt="" className="w-8 h-8 rounded object-cover shrink-0" />
                        )}
                        <span className="text-cream/80 line-clamp-1 flex-1">
                          {it.quantity}× {it.name}
                        </span>
                      </div>
                    ))}
                    {pending.items.length > 3 && (
                      <div className="text-[10px] text-cream/50 pl-10">
                        +{pending.items.length - 3} {pending.items.length - 3 === 1 ? 'item' : 'itens'}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 pt-3 border-t border-amber-500/20 flex items-center justify-between gap-2">
                    <div className="text-[11px] text-cream/60">
                      📦 {pending.shippingLabel}
                    </div>
                    {pending.checkoutUrl && (
                      <a
                        href={pending.checkoutUrl}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1 text-xs font-bold text-amber-300 underline"
                      >
                        Continuar pagamento
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>

                  {/* Mensagem reassuring */}
                  <div className="mt-3 text-[10px] text-cream/50 italic">
                    Assim que confirmarmos o pagamento, seu pedido aparece aqui com o número oficial. 💛
                  </div>

                  {/* Botão pequeno pra dispensar manualmente */}
                  <button
                    onClick={() => {
                      clearPending();
                      setPending(null);
                    }}
                    className="absolute top-2 right-2 w-6 h-6 rounded-full bg-ink-800/60 hover:bg-ink-700 text-cream/40 text-xs flex items-center justify-center"
                    aria-label="Dispensar"
                  >
                    ×
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Resumo lojas físicas */}
          {linkedStores > 0 && (
            <section className="mt-6 px-5">
              <div className="card-gold-border bg-gold/5">
                <div className="text-xs font-bold uppercase tracking-wider text-gold mb-1">
                  🏬 Compras nas lojas físicas
                </div>
                <p className="text-sm text-cream/80">
                  Você tem cadastro em <strong className="text-gold">{linkedStores}</strong>{' '}
                  {linkedStores === 1 ? 'loja Lurd\'s' : 'lojas Lurd\'s'}.
                </p>
                <p className="text-xs text-cream/60 mt-1">
                  Pra consultar o histórico de compras na loja, pode ir presencialmente
                  ou ver em <Link href="/conta/dados" className="text-gold underline">dados pessoais</Link>.
                </p>
              </div>
            </section>
          )}

          {/* Lista de pedidos do site */}
          <section className="mt-6 px-5">
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-cream/40 mb-2 px-1">
              Pedidos do site
            </h2>
            {orders.length === 0 && !pending ? (
              <div className="card-dark text-center py-8">
                <ShoppingBag className="w-12 h-12 mx-auto text-gold/40" />
                <h3 className="font-serif text-lg font-bold mt-3">Sem pedidos online</h3>
                <p className="text-sm text-cream/60 mt-1">
                  Quando comprar em <a href="https://lurds.com.br" target="_blank" rel="noopener" className="text-gold underline">lurds.com.br</a>, seus pedidos aparecem aqui.
                </p>
              </div>
            ) : orders.length === 0 ? null : (
              <div className="space-y-2">
                {orders.map((o) => {
                  const st = STATUS_LABEL[o.status] || {
                    label: o.status,
                    color: 'text-cream/70',
                    icon: Package,
                  };
                  const Icon = st.icon;
                  // Só linka quem tem WC number (pedido site/app — Giga não tem)
                  const wcNumber = o.number && /^\d+$/.test(o.number) ? o.number : null;
                  const Wrapper: any = wcNumber ? Link : 'div';
                  const wrapperProps = wcNumber ? { href: `/pedido/${wcNumber}` } : {};
                  return (
                    <Wrapper key={o.id} className={`card-dark block ${wcNumber ? 'active:scale-[0.98] transition' : ''}`} {...wrapperProps}>
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div>
                          <div className="text-xs text-cream/50 font-mono">
                            {o.number ? `#${o.number}` : `#${o.id.slice(0, 8)}`}
                          </div>
                          <div className={`text-sm font-bold mt-0.5 flex items-center gap-1.5 ${st.color}`}>
                            <Icon className="w-4 h-4" />
                            {st.label}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-black text-gold tabular-nums">
                            {brl(o.total)}
                          </div>
                          {o.date && (
                            <div className="text-[10px] text-cream/50">
                              {new Date(o.date).toLocaleDateString('pt-BR')}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-cream/70 line-clamp-1">
                        {o.itemsCount} {o.itemsCount === 1 ? 'item' : 'itens'}
                        {o.firstItem && (<> · {o.firstItem}</>)}
                      </div>
                      {o.tracking && (
                        <div className="mt-2 pt-2 border-t border-ink-600 flex items-center justify-between text-xs">
                          <span className="text-cream/60">
                            📦 {o.tracking.carrier || 'Rastreio'}
                          </span>
                          <span className="text-gold font-mono">{o.tracking.code}</span>
                        </div>
                      )}
                    </Wrapper>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      <div className="h-20" />
      <BottomNav />
    </div>
  );
}
