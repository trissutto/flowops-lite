'use client';

/**
 * SellerTag — tag de vendedora atribuída a um pedido WC.
 *
 * Usado em /separacao (ao lado do pedido) e na tela de detalhe /pedidos/wc/[id].
 *
 * Clique abre dropdown com as vendedoras ativas; seleção dispara
 * PATCH /sellers/assign/:wcOrderId. Suporta desatribuir ("Sem atribuição").
 *
 * Props:
 *   - wcOrderId: id numérico do pedido WooCommerce (NÃO é o wcOrderNumber de string)
 *   - currentSellerId: id atual ou null
 *   - currentSellerName: nome cacheado no pedido (pode estar null)
 *   - onChange(sellerId, sellerName): callback chamado após salvar
 *   - compact: reduz tamanho/padding — usado em listas densas (/separacao)
 */

import { useEffect, useRef, useState } from 'react';
import { UserCircle2, ChevronDown, Check, X as XIcon } from 'lucide-react';
import { api } from '@/lib/api';

type Seller = {
  id: string;
  name: string;
  active: boolean;
};

type Props = {
  wcOrderId: number;
  currentSellerId: string | null;
  currentSellerName: string | null;
  onChange?: (sellerId: string | null, sellerName: string | null) => void;
  compact?: boolean;
};

// Cache em memória — a lista de vendedoras muda pouco, não precisa bater
// no backend a cada abertura de dropdown.
let _cache: { data: Seller[] | null; ts: number } = { data: null, ts: 0 };
const CACHE_TTL = 60 * 1000; // 1min

async function loadSellers(force = false): Promise<Seller[]> {
  if (!force && _cache.data && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;
  const data = await api<Seller[]>('/sellers');
  _cache = { data, ts: Date.now() };
  return data;
}

export function invalidateSellerCache() {
  _cache = { data: null, ts: 0 };
}

export default function SellerTag({
  wcOrderId,
  currentSellerId,
  currentSellerName,
  onChange,
  compact = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fecha clicando fora
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Carrega quando abre
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    loadSellers()
      .then(setSellers)
      .catch(() => setSellers([]))
      .finally(() => setLoading(false));
  }, [open]);

  const escolher = async (sellerId: string | null, sellerName: string | null) => {
    if (saving) return;
    setSaving(true);
    try {
      await api(`/sellers/assign/${wcOrderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ sellerId }),
      });
      onChange?.(sellerId, sellerName);
      setOpen(false);
    } catch (err: any) {
      alert(`Erro: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  const hasSeller = !!currentSellerId && !!currentSellerName;

  // Estilos
  const baseCls = compact
    ? 'text-[11px] px-2 py-0.5 rounded-full border inline-flex items-center gap-1 font-semibold'
    : 'text-xs px-2.5 py-1 rounded-lg border inline-flex items-center gap-1.5 font-semibold';
  const pillCls = hasSeller
    ? 'bg-fuchsia-50 text-fuchsia-800 border-fuchsia-300 hover:bg-fuchsia-100'
    : 'bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-200 border-dashed';

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        disabled={saving}
        className={`${baseCls} ${pillCls} transition disabled:opacity-60`}
        title={hasSeller ? `Vendedora: ${currentSellerName}` : 'Atribuir vendedora'}
      >
        <UserCircle2 className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
        <span className="truncate max-w-[120px]">
          {hasSeller ? currentSellerName : 'Vendedora?'}
        </span>
        <ChevronDown className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 right-0 min-w-[200px] bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="max-h-[240px] overflow-y-auto">
            {loading ? (
              <div className="px-3 py-3 text-xs text-slate-500 text-center">Carregando…</div>
            ) : sellers.length === 0 ? (
              <div className="px-3 py-3 text-xs text-slate-500 text-center">
                Nenhuma vendedora cadastrada.
                <br />
                <a href="/retaguarda/vendedoras" className="text-brand hover:underline">
                  Cadastrar →
                </a>
              </div>
            ) : (
              sellers.map((s) => {
                const selected = currentSellerId === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => escolher(s.id, s.name)}
                    disabled={saving}
                    className={`w-full text-left text-sm px-3 py-2 flex items-center gap-2 hover:bg-slate-50 ${
                      selected ? 'bg-fuchsia-50 text-fuchsia-800 font-semibold' : 'text-slate-700'
                    }`}
                  >
                    {selected ? (
                      <Check className="w-3.5 h-3.5 text-fuchsia-600" />
                    ) : (
                      <span className="w-3.5 h-3.5" />
                    )}
                    {s.name}
                  </button>
                );
              })
            )}
          </div>
          {hasSeller && (
            <>
              <div className="border-t border-slate-100" />
              <button
                onClick={() => escolher(null, null)}
                disabled={saving}
                className="w-full text-left text-xs px-3 py-2 flex items-center gap-2 text-slate-500 hover:bg-slate-50"
              >
                <XIcon className="w-3.5 h-3.5" />
                Desatribuir
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
