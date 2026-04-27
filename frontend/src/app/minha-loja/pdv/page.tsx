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
import {
  ArrowLeft, Loader2, X, Barcode, ArrowRight, Trash2, Plus, Minus,
  ShoppingCart, User, CreditCard, Banknote, QrCode, Check, AlertCircle,
  Send, Mail, MessageSquare, FileText, RotateCcw, History,
} from 'lucide-react';
import { api } from '@/lib/api';

type Sale = {
  id: string;
  storeCode: string;
  storeName: string;
  vendedorName: string | null;
  customerCpf: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  status: 'open' | 'finalized' | 'cancelled' | string;
  subtotal: number;
  desconto: number;
  total: number;
  paymentMethod: string | null;
  nfceNumber: string | null;
  nfceChave: string | null;
  nfceXml: string | null;
  finalizedAt: string | null;
  items: Array<{
    id: string;
    sku: string;
    ean: string | null;
    ref: string | null;
    cor: string | null;
    tamanho: string | null;
    descricao: string;
    qty: number;
    precoUnit: number;
    desconto: number;
    total: number;
  }>;
};

type Store = { id: string; code: string; name: string; active: boolean };

const PAYMENT_METHODS = [
  { id: 'dinheiro', label: 'Dinheiro', icon: Banknote, tone: 'emerald' },
  { id: 'pix', label: 'PIX', icon: QrCode, tone: 'sky' },
  { id: 'credito', label: 'Crédito', icon: CreditCard, tone: 'violet' },
  { id: 'debito', label: 'Débito', icon: CreditCard, tone: 'blue' },
  { id: 'crediario', label: 'Crediário', icon: User, tone: 'rose' },
] as const;

const brl = (n: number) =>
  Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function PdvPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeCode, setStoreCode] = useState<string>('');
  const [sale, setSale] = useState<Sale | null>(null);
  const [loadingSale, setLoadingSale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scanInput, setScanInput] = useState('');
  const [scanLoading, setScanLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [showCustomer, setShowCustomer] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [showFinalized, setShowFinalized] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

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
    if (!showCustomer && !showPayment && !showFinalized) {
      inputRef.current?.focus();
    }
  }, [sale, showCustomer, showPayment, showFinalized]);

  // Listener global: qualquer tecla redireciona pro input
  useEffect(() => {
    if (!sale || sale.status !== 'open') return;
    if (showCustomer || showPayment || showFinalized) return;
    const handler = (e: KeyboardEvent) => {
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

  // ── Quantidade ──
  const updateQty = async (itemId: string, qty: number) => {
    if (!sale || qty < 1) return;
    try {
      await api(`/pdv/sales/${sale.id}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ qty }),
      });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  const removeItem = async (itemId: string) => {
    if (!sale) return;
    try {
      await api(`/pdv/sales/${sale.id}/items/${itemId}`, { method: 'DELETE' });
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
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
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
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
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    }
  };

  // ── Finalizar ──
  const finalizeSale = async (paymentMethod: string, paymentDetails?: any) => {
    if (!sale) return;
    setFinalizing(true);
    try {
      const result = await api<{ ok: boolean; sale: Sale }>(
        `/pdv/sales/${sale.id}/finalize`,
        {
          method: 'POST',
          body: JSON.stringify({ paymentMethod, paymentDetails }),
        },
      );
      const fresh = await api<Sale>(`/pdv/sales/${sale.id}`);
      setSale(fresh);
      setShowPayment(false);
      setShowFinalized(true);
      localStorage.removeItem(`lurds_pdv_sale_${storeCode}`);
    } catch (e: any) {
      alert(`Erro: ${e?.message}`);
    } finally {
      setFinalizing(false);
    }
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
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white border-b shadow-sm">
        <div className="max-w-3xl mx-auto px-3 py-2 flex items-center gap-2">
          <Link href="/minha-loja" className="text-slate-500 hover:text-slate-700" aria-label="Voltar">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-slate-800 flex items-center gap-1.5">
              <ShoppingCart className="w-4 h-4 text-emerald-600" />
              PDV {sale?.storeCode}
            </h1>
            <p className="text-[11px] text-slate-500 truncate">
              {sale ? `Venda ${sale.id.slice(-6).toUpperCase()} · ${sale.items?.length || 0} item(ns)` : 'Carregando...'}
            </p>
          </div>
          <button
            onClick={() => setShowCustomer(true)}
            disabled={!sale || sale.status !== 'open'}
            className="text-xs px-2 py-1.5 rounded bg-slate-100 hover:bg-slate-200 flex items-center gap-1 disabled:opacity-50"
            title="Identificar cliente"
          >
            <User className="w-3.5 h-3.5" />
            {sale?.customerCpf ? sale.customerName?.split(' ')[0] || 'Cliente' : 'Cliente'}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full p-3 space-y-3 pb-32">
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 p-2 rounded text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Input bipagem */}
        {sale?.status === 'open' && (
          <form
            onSubmit={handleScan}
            className="bg-white rounded-lg border-2 border-emerald-300 p-3 shadow-sm"
          >
            <label className="text-xs uppercase font-semibold text-emerald-700 flex items-center gap-1 mb-1.5">
              <Barcode className="w-3.5 h-3.5" />
              Bipe o produto
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="SKU ou EAN"
                disabled={scanLoading}
                className="flex-1 px-4 py-3 text-lg font-mono border rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-50"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                type="submit"
                disabled={!scanInput || scanLoading}
                className="px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-md flex items-center disabled:opacity-40"
              >
                {scanLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
              </button>
            </div>
          </form>
        )}

        {/* Carrinho */}
        {loadingSale ? (
          <div className="text-center py-10 text-slate-400">
            <Loader2 className="w-6 h-6 animate-spin inline-block" />
          </div>
        ) : sale && sale.items?.length > 0 ? (
          <div className="bg-white rounded-lg border overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 border-b text-xs uppercase font-semibold text-slate-500">
              Carrinho ({sale.items.length})
            </div>
            <div className="divide-y">
              {sale.items.map((it) => (
                <div key={it.id} className="p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm font-bold text-slate-800">
                      {it.ref || it.sku}
                      {it.cor && <span className="ml-1.5 text-slate-500 font-normal">{it.cor}</span>}
                      {it.tamanho && <span className="ml-1 text-slate-500 font-normal">/{it.tamanho}</span>}
                    </div>
                    {it.descricao && (
                      <div className="text-[11px] text-slate-500 truncate">{it.descricao}</div>
                    )}
                    <div className="text-xs text-slate-600 mt-0.5">
                      {brl(it.precoUnit)} cada
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => updateQty(it.id, it.qty - 1)}
                      disabled={it.qty <= 1 || sale.status !== 'open'}
                      className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200 flex items-center justify-center disabled:opacity-30"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <span className="w-8 text-center font-bold tabular-nums">{it.qty}</span>
                    <button
                      onClick={() => updateQty(it.id, it.qty + 1)}
                      disabled={sale.status !== 'open'}
                      className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200 flex items-center justify-center disabled:opacity-30"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="w-20 text-right shrink-0">
                    <div className="font-bold text-emerald-700 tabular-nums">{brl(it.total)}</div>
                  </div>
                  {sale.status === 'open' && (
                    <button
                      onClick={() => removeItem(it.id)}
                      className="text-slate-400 hover:text-rose-600 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : sale?.status === 'open' ? (
          <div className="text-center py-10 text-slate-400 bg-white rounded-lg border-2 border-dashed">
            <ShoppingCart className="w-10 h-10 inline-block mb-2 opacity-50" />
            <div className="text-sm">Carrinho vazio · bipe o primeiro produto</div>
          </div>
        ) : null}
      </main>

      {/* Footer fixo: total + finalizar */}
      {sale?.status === 'open' && (
        <footer className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg z-10">
          <div className="max-w-3xl mx-auto px-3 py-2 flex items-center gap-2">
            <button
              onClick={cancelSale}
              className="text-xs text-rose-600 hover:bg-rose-50 px-2 py-2 rounded"
              title="Cancelar"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex-1">
              <div className="text-[10px] text-slate-500 uppercase">Total</div>
              <div className="text-2xl font-bold text-emerald-700 tabular-nums leading-none">
                {brl(sale.total)}
              </div>
            </div>
            <button
              onClick={() => setShowPayment(true)}
              disabled={!sale.items?.length || sale.total <= 0}
              className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg flex items-center gap-2 disabled:opacity-40"
            >
              <Check className="w-5 h-5" />
              Finalizar
            </button>
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

      {/* Modal Pagamento */}
      {showPayment && sale && (
        <PaymentModal
          total={sale.total}
          customerCpf={sale.customerCpf}
          finalizing={finalizing}
          onClose={() => setShowPayment(false)}
          onConfirm={finalizeSale}
        />
      )}

      {/* Modal Finalizada */}
      {showFinalized && sale && sale.status === 'finalized' && (
        <FinalizedModal sale={sale} onNew={startNewSale} />
      )}
    </div>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────

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
  total,
  customerCpf,
  finalizing,
  onClose,
  onConfirm,
}: {
  total: number;
  customerCpf: string | null;
  finalizing: boolean;
  onClose: () => void;
  onConfirm: (method: string, details?: any) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [parcelas, setParcelas] = useState(1);
  const [recebido, setRecebido] = useState('');

  const recebidoNum = Number((recebido || '0').replace(',', '.'));
  const troco = selected === 'dinheiro' && recebidoNum > total ? recebidoNum - total : 0;

  const canConfirm = useMemo(() => {
    if (!selected) return false;
    if (selected === 'crediario' && !customerCpf) return false;
    if (selected === 'dinheiro' && recebidoNum < total) return false;
    return true;
  }, [selected, recebidoNum, total, customerCpf]);

  const confirm = () => {
    if (!selected) return;
    const details: any = {};
    if (selected === 'credito' || selected === 'crediario') details.parcelas = parcelas;
    if (selected === 'dinheiro') {
      details.recebido = recebidoNum;
      details.troco = troco;
    }
    onConfirm(selected, details);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-lg w-full max-w-md p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2">
            <CreditCard className="w-4 h-4" /> Pagamento
          </h2>
          <button onClick={onClose}><X className="w-4 h-4" /></button>
        </div>

        <div className="text-center py-2 bg-emerald-50 rounded">
          <div className="text-xs text-slate-500 uppercase">Total a pagar</div>
          <div className="text-3xl font-bold text-emerald-700 tabular-nums">{brl(total)}</div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {PAYMENT_METHODS.map((p) => {
            const Icon = p.icon;
            const isSelected = selected === p.id;
            const disabled = p.id === 'crediario' && !customerCpf;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => !disabled && setSelected(p.id)}
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

        {/* Detalhes por método */}
        {selected === 'dinheiro' && (
          <div className="space-y-2 pt-2 border-t">
            <label className="text-xs text-slate-600">Valor recebido</label>
            <input
              type="text"
              inputMode="decimal"
              value={recebido}
              onChange={(e) => setRecebido(e.target.value)}
              placeholder={total.toFixed(2).replace('.', ',')}
              className="w-full border rounded px-3 py-2 text-lg font-mono"
              autoFocus
            />
            {troco > 0 && (
              <div className="flex justify-between text-sm bg-amber-50 p-2 rounded">
                <span>Troco</span>
                <span className="font-bold text-amber-700">{brl(troco)}</span>
              </div>
            )}
          </div>
        )}

        {(selected === 'credito' || selected === 'crediario') && (
          <div className="space-y-2 pt-2 border-t">
            <label className="text-xs text-slate-600">Parcelas</label>
            <div className="grid grid-cols-6 gap-1">
              {[1, 2, 3, 4, 6, 10].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setParcelas(p)}
                  className={`py-2 rounded text-sm font-bold ${
                    parcelas === p ? 'bg-emerald-600 text-white' : 'bg-slate-100 hover:bg-slate-200'
                  }`}
                >
                  {p}x
                </button>
              ))}
            </div>
            <div className="text-center text-xs text-slate-600">
              {parcelas}× de <b>{brl(total / parcelas)}</b>
            </div>
          </div>
        )}

        <button
          onClick={confirm}
          disabled={!canConfirm || finalizing}
          className="w-full px-3 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded text-base disabled:opacity-40 flex items-center justify-center gap-2"
        >
          {finalizing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          Confirmar pagamento
        </button>
      </div>
    </div>
  );
}

function FinalizedModal({ sale, onNew }: { sale: Sale; onNew: () => void }) {
  const [showXml, setShowXml] = useState(false);
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-lg w-full max-w-md my-8 overflow-hidden">
        <div className="px-4 py-3 bg-emerald-50 border-b text-center">
          <Check className="w-10 h-10 mx-auto text-emerald-600 mb-1" />
          <h2 className="font-bold text-lg text-emerald-900">Venda Finalizada</h2>
          <p className="text-xs text-emerald-700">
            {brl(sale.total)} · {sale.paymentMethod?.toUpperCase()}
          </p>
        </div>
        <div className="p-4 space-y-3">
          {/* Mini cupom */}
          <div className="bg-slate-50 border border-dashed rounded p-3 text-xs font-mono space-y-1">
            <div className="text-center font-bold mb-1">CUPOM FISCAL ELETRÔNICO</div>
            <div className="text-center text-[10px] text-slate-500">
              {sale.storeName} · NFC-e {sale.nfceNumber || '—'}
            </div>
            {sale.nfceChave && (
              <div className="text-center text-[9px] text-slate-400 break-all">
                Chave: {sale.nfceChave}
              </div>
            )}
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
            <div className="text-[10px] text-amber-700 text-center mt-2 italic">
              ⚠ NFC-e MODO PREVIEW — não emitida na SEFAZ
            </div>
          </div>

          {/* Ações de envio (mockadas) */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => alert('Envio por email — a integrar (Resend/SES)')}
              disabled={!sale.customerEmail}
              className="px-3 py-2 text-sm border-2 border-blue-200 text-blue-700 rounded hover:bg-blue-50 flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              <Mail className="w-4 h-4" />
              Email
            </button>
            <button
              onClick={() => alert('Envio por WhatsApp — a integrar (Baileys)')}
              disabled={!sale.customerPhone}
              className="px-3 py-2 text-sm border-2 border-emerald-200 text-emerald-700 rounded hover:bg-emerald-50 flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              <MessageSquare className="w-4 h-4" />
              WhatsApp
            </button>
          </div>

          <button
            onClick={() => setShowXml(!showXml)}
            className="w-full text-xs text-slate-500 hover:text-slate-700 flex items-center justify-center gap-1"
          >
            <FileText className="w-3 h-3" />
            {showXml ? 'Esconder XML NFC-e' : 'Ver XML NFC-e (preview)'}
          </button>
          {showXml && sale.nfceXml && (
            <pre className="bg-slate-900 text-emerald-300 text-[9px] font-mono p-2 rounded max-h-60 overflow-auto">
              {sale.nfceXml}
            </pre>
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
