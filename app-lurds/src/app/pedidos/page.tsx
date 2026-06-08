'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ShoppingBag, Loader2, Truck, Package, CheckCircle2 } from 'lucide-react';
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

export default function PedidosPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<AppOrder[]>([]);
  const [linkedStores, setLinkedStores] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/entrar?next=/pedidos');
      return;
    }
    getOrders()
      .then((r) => {
        setOrders(r.orders);
        setLinkedStores(r.linkedStoresCount);
      })
      .catch(() => setOrders([]))
      .finally(() => setLoading(false));
  }, [router]);

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
            {orders.length === 0 ? (
              <div className="card-dark text-center py-8">
                <ShoppingBag className="w-12 h-12 mx-auto text-gold/40" />
                <h3 className="font-serif text-lg font-bold mt-3">Sem pedidos online</h3>
                <p className="text-sm text-cream/60 mt-1">
                  Quando comprar em <a href="https://lurds.com.br" target="_blank" rel="noopener" className="text-gold underline">lurds.com.br</a>, seus pedidos aparecem aqui.
                </p>
              </div>
            ) : (
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
