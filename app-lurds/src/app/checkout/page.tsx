'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, MapPin, Truck, CreditCard, Loader2, AlertCircle,
  CheckCircle2, Sparkles, Plus, ChevronRight, ExternalLink, Store,
} from 'lucide-react';
import { useCart } from '@/contexts/CartContext';
import {
  getAddresses, getMe, calculateShipping, createWcOrder,
  isLoggedIn, getCustomerFromToken,
  type AppAddress, type ShippingOption,
} from '@/lib/api';

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type Step = 'address' | 'shipping' | 'payment' | 'processing';

export default function CheckoutPage() {
  const router = useRouter();
  const { items, subtotal, clear } = useCart();

  const [step, setStep] = useState<Step>('address');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Cliente
  const [me, setMe] = useState<any>(null);
  const [addresses, setAddresses] = useState<AppAddress[]>([]);
  const [selectedAddrId, setSelectedAddrId] = useState<string | null>(null);
  const selectedAddress = addresses.find((a) => a.id === selectedAddrId) || null;

  // Frete
  const [shippingOptions, setShippingOptions] = useState<ShippingOption[]>([]);
  const [selectedShipping, setSelectedShipping] = useState<ShippingOption | null>(null);
  const [loadingShipping, setLoadingShipping] = useState(false);

  // Cashback
  const [cashbackAvail, setCashbackAvail] = useState(0);
  const [useCashback, setUseCashback] = useState(false);

  // Pagamento
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'credit_card'>('pix');
  const [creating, setCreating] = useState(false);

  const cashbackUsed = useCashback ? Math.min(cashbackAvail, subtotal * 0.5) : 0;
  const shippingCost = selectedShipping?.price || 0;
  const pixDiscount = paymentMethod === 'pix' ? subtotal * 0.05 : 0;
  const total = Math.max(0, subtotal - cashbackUsed + shippingCost - pixDiscount);

  // Carrega dados iniciais
  useEffect(() => {
    if (!isLoggedIn()) {
      router.push('/login?next=/checkout');
      return;
    }
    if (items.length === 0) {
      router.push('/carrinho');
      return;
    }
    Promise.all([
      getAddresses().catch(() => ({ addresses: [] })),
      getMe().catch(() => null),
    ]).then(([addrR, meR]) => {
      setAddresses(addrR.addresses);
      if (addrR.addresses.length > 0) {
        const primary = addrR.addresses.find((a) => a.isPrimary) || addrR.addresses[0];
        setSelectedAddrId(primary.id);
      }
      if (meR) {
        setMe(meR);
        setCashbackAvail(meR.cashback?.balance || 0);
      }
      setLoading(false);
    });
  }, [items.length, router]);

  // Calcula frete ao escolher endereço
  const handleSelectAddress = async (addr: AppAddress) => {
    setSelectedAddrId(addr.id);
    if (!addr.cep) return;
    setLoadingShipping(true);
    try {
      const r = await calculateShipping(addr.cep);
      setShippingOptions(r.options);
    } catch {
      setShippingOptions([]);
    } finally {
      setLoadingShipping(false);
    }
  };

  // Auto-calcula frete quando seleciona o primeiro endereço
  useEffect(() => {
    if (selectedAddress && shippingOptions.length === 0 && !loadingShipping) {
      handleSelectAddress(selectedAddress);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAddress]);

  const handleCreateOrder = async () => {
    if (!selectedAddress || !selectedShipping || !me) {
      setErr('Faltam dados');
      return;
    }
    const c = getCustomerFromToken();
    const cpf = (c?.cpf || '').replace(/\D/g, '');

    setCreating(true);
    setErr(null);
    try {
      const order = await createWcOrder({
        customer: {
          first_name: (me.name || c?.name || 'Cliente').split(' ')[0],
          last_name: (me.name || c?.name || '').split(' ').slice(1).join(' '),
          email: me.email || '',
          phone: me.phone || '',
          cpf,
        },
        shipping: {
          address_1: selectedAddress.street || '',
          number: selectedAddress.number || '',
          address_2: selectedAddress.complement || '',
          city: selectedAddress.city || '',
          state: selectedAddress.state || 'SP',
          postcode: (selectedAddress.cep || '').replace(/\D/g, ''),
        },
        lineItems: items.map((i) => ({
          product_id: i.productId,
          variation_id: i.variationId || undefined,
          quantity: i.quantity,
        })),
        paymentMethod,
        cashbackUsedCents: Math.round(cashbackUsed * 100),
        shippingMethod: selectedShipping.name,
        shippingCost: selectedShipping.price,
        pickupStoreCode: selectedShipping.type === 'pickup' ? selectedShipping.storeCode : undefined,
      });

      // Limpa carrinho
      clear();
      // PIX: vai pra /pedido/[id] (mostra QR Code dentro do app — não sai)
      // Cartão: vai pra WC checkout (precisa do form de cartão dele)
      if (paymentMethod === 'pix') {
        router.push(`/pedido/${order.id}`);
      } else {
        window.location.href = order.paymentUrl;
      }
    } catch (e: any) {
      setErr(e?.message || 'Erro ao criar pedido');
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gold" />
      </div>
    );
  }

  return (
    <div
      style={{ paddingBottom: 'calc(20rem + env(safe-area-inset-bottom))' }}
    >
      <header className="flex items-center gap-3 px-5 pt-5">
        <Link href="/carrinho" className="p-2 rounded-full bg-ink-800 hover:bg-ink-700 transition">
          <ArrowLeft className="w-5 h-5 text-gold" />
        </Link>
        <h1 className="font-serif text-xl font-bold">Finalizar compra</h1>
      </header>

      {/* ───────── Endereço ───────── */}
      <section className="mt-6 px-5">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="w-5 h-5 text-gold" />
          <h2 className="font-bold text-sm uppercase tracking-wider">Endereço</h2>
        </div>
        {addresses.length === 0 ? (
          <div className="card-dark text-center py-6">
            <p className="text-sm text-cream/60 mb-3">
              Você ainda não tem endereço cadastrado.
            </p>
            <Link href="/conta/enderecos" className="btn-gold inline-flex">
              <Plus className="w-4 h-4" /> Adicionar endereço
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {addresses.map((a) => (
              <button
                key={a.id}
                onClick={() => handleSelectAddress(a)}
                className={`w-full text-left card-dark transition ${
                  selectedAddrId === a.id ? 'border-gold/60' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm">
                      {a.street}, {a.number} {a.complement && `· ${a.complement}`}
                    </div>
                    <div className="text-xs text-cream/60">
                      {a.district && `${a.district} · `}{a.city} — {a.state}
                    </div>
                    {a.cep && <div className="text-[11px] text-cream/40 mt-0.5">CEP {a.cep}</div>}
                  </div>
                  {selectedAddrId === a.id && (
                    <CheckCircle2 className="w-5 h-5 text-gold shrink-0" />
                  )}
                </div>
              </button>
            ))}
            <Link href="/conta/enderecos" className="block text-center text-xs text-gold/80 underline mt-2">
              Gerenciar endereços
            </Link>
          </div>
        )}
      </section>

      {/* ───────── Frete ───────── */}
      {selectedAddress && (
        <section className="mt-7 px-5">
          <div className="flex items-center gap-2 mb-3">
            <Truck className="w-5 h-5 text-gold" />
            <h2 className="font-bold text-sm uppercase tracking-wider">Receber em casa ou retirar</h2>
          </div>
          {loadingShipping ? (
            <div className="text-center py-4 text-cream/50">
              <Loader2 className="w-5 h-5 animate-spin mx-auto" />
            </div>
          ) : shippingOptions.length === 0 ? (
            <div className="text-sm text-cream/50">Sem opções pra esse CEP</div>
          ) : (
            <div className="space-y-3">
              {/* CORREIOS */}
              {shippingOptions.filter((o) => o.type === 'shipping').length > 0 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-cream/40 mb-1.5 px-1">
                    Receber em casa
                  </p>
                  <div className="space-y-2">
                    {shippingOptions
                      .filter((o) => o.type === 'shipping')
                      .map((opt) => (
                        <button
                          key={opt.code}
                          onClick={() => setSelectedShipping(opt)}
                          className={`w-full card-dark text-left transition ${
                            selectedShipping?.code === opt.code ? 'border-gold/60' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Truck className="w-4 h-4 text-cream/70" />
                              <div>
                                <div className="font-bold text-sm">{opt.name}</div>
                                <div className="text-xs text-cream/60">
                                  Em até {opt.days} dia{opt.days > 1 ? 's' : ''} úteis
                                </div>
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-black text-gold tabular-nums">{brl(opt.price)}</div>
                              {selectedShipping?.code === opt.code && (
                                <CheckCircle2 className="w-4 h-4 text-gold ml-auto mt-1" />
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {/* PICKUP */}
              {shippingOptions.filter((o) => o.type === 'pickup').length > 0 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-cream/40 mb-1.5 px-1 flex items-center gap-1">
                    <Store className="w-3 h-3" /> Retirar (grátis — você está perto)
                  </p>
                  <div className="space-y-2">
                    {shippingOptions
                      .filter((o) => o.type === 'pickup')
                      .map((opt) => (
                        <button
                          key={opt.code}
                          onClick={() => setSelectedShipping(opt)}
                          className={`w-full card-dark text-left transition ${
                            selectedShipping?.code === opt.code
                              ? 'border-gold/60 bg-emerald-900/10'
                              : ''
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Store className="w-4 h-4 text-emerald-400" />
                              <div>
                                <div className="font-bold text-sm">{opt.name}</div>
                                <div className="text-xs text-cream/60">
                                  {opt.storeAddress || `Pronto em até ${opt.days} dia${opt.days > 1 ? 's' : ''}`}
                                </div>
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-black text-emerald-400 tabular-nums text-xs uppercase">
                                Grátis
                              </div>
                              {selectedShipping?.code === opt.code && (
                                <CheckCircle2 className="w-4 h-4 text-gold ml-auto mt-1" />
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ───────── Cashback ───────── */}
      {cashbackAvail > 0 && (
        <section className="mt-7 px-5">
          <button
            onClick={() => setUseCashback(!useCashback)}
            className={`w-full card-gold-border bg-emerald-900/20 flex items-center justify-between transition ${
              useCashback ? 'border-emerald-400/60' : ''
            }`}
          >
            <div className="flex items-center gap-3">
              <Sparkles className="w-5 h-5 text-emerald-400" />
              <div className="text-left">
                <div className="font-bold text-sm text-white">
                  Usar cashback
                </div>
                <div className="text-[11px] text-cream/60">
                  Saldo: <strong className="text-emerald-300">{brl(cashbackAvail)}</strong> (até 50% da compra)
                </div>
              </div>
            </div>
            <div className={`w-11 h-6 rounded-full relative transition ${
              useCashback ? 'bg-emerald-500' : 'bg-ink-600'
            }`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                useCashback ? 'translate-x-5' : 'translate-x-0.5'
              }`} />
            </div>
          </button>
          {useCashback && (
            <div className="mt-2 text-[11px] text-emerald-400 text-center">
              −{brl(cashbackUsed)} aplicado no total
            </div>
          )}
        </section>
      )}

      {/* ───────── Pagamento ───────── */}
      <section className="mt-7 px-5">
        <div className="flex items-center gap-2 mb-3">
          <CreditCard className="w-5 h-5 text-gold" />
          <h2 className="font-bold text-sm uppercase tracking-wider">Pagamento</h2>
        </div>
        <div className="space-y-2">
          <button
            onClick={() => setPaymentMethod('pix')}
            className={`w-full card-dark text-left transition ${
              paymentMethod === 'pix' ? 'border-gold/60' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-bold text-sm flex items-center gap-2">
                  <span>💰 PIX</span>
                  <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full font-bold uppercase">
                    5% off
                  </span>
                </div>
                <div className="text-xs text-cream/60">Aprovação imediata</div>
              </div>
              {paymentMethod === 'pix' && <CheckCircle2 className="w-5 h-5 text-gold" />}
            </div>
          </button>
          <button
            onClick={() => setPaymentMethod('credit_card')}
            className={`w-full card-dark text-left transition ${
              paymentMethod === 'credit_card' ? 'border-gold/60' : ''
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-bold text-sm">💳 Cartão de crédito</div>
                <div className="text-xs text-cream/60">Em até 6x sem juros</div>
              </div>
              {paymentMethod === 'credit_card' && <CheckCircle2 className="w-5 h-5 text-gold" />}
            </div>
          </button>
        </div>
      </section>

      {/* ───────── Total + Botão ───────── */}
      <div
        className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-app bg-ink/95 backdrop-blur-md border-t border-ink-600 px-5 pt-3"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
      >
        <div className="space-y-1 text-sm">
          <div className="flex justify-between text-cream/70">
            <span>Subtotal</span>
            <span className="tabular-nums">{brl(subtotal)}</span>
          </div>
          {useCashback && (
            <div className="flex justify-between text-emerald-400">
              <span>Cashback</span>
              <span className="tabular-nums">−{brl(cashbackUsed)}</span>
            </div>
          )}
          {pixDiscount > 0 && (
            <div className="flex justify-between text-emerald-400">
              <span>Desconto PIX 5%</span>
              <span className="tabular-nums">−{brl(pixDiscount)}</span>
            </div>
          )}
          {selectedShipping && (
            <div className="flex justify-between text-cream/70">
              <span>
                {selectedShipping.type === 'pickup'
                  ? `Retirada em loja`
                  : `Frete (${selectedShipping.code})`}
              </span>
              <span className="tabular-nums">
                {selectedShipping.price === 0 ? 'Grátis' : brl(shippingCost)}
              </span>
            </div>
          )}
          <div className="flex justify-between items-baseline pt-2 border-t border-ink-600">
            <span className="text-cream/80 font-bold">Total</span>
            <span className="font-serif text-2xl font-black text-gold tabular-nums">
              {brl(total)}
            </span>
          </div>
        </div>

        {err && (
          <div className="mt-2 p-2 bg-rose-900/30 border border-rose-700/50 rounded text-xs text-rose-200 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {err}
          </div>
        )}

        <button
          onClick={handleCreateOrder}
          disabled={!selectedAddress || !selectedShipping || creating}
          className="btn-gold-lg w-full mt-3"
        >
          {creating ? (
            <><Loader2 className="w-5 h-5 animate-spin" /> Criando pedido...</>
          ) : (
            <>Pagar {brl(total)} <ExternalLink className="w-4 h-4" /></>
          )}
        </button>
        <p className="text-[10px] text-cream/40 text-center mt-2">
          Você será levado pra finalizar o pagamento de forma segura
        </p>
      </div>
    </div>
  );
}
