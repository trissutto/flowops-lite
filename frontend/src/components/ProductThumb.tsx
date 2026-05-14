'use client';

/**
 * ProductThumb — thumbnail compartilhado de produto.
 *
 * Busca a foto no WooCommerce via /pdv/product-image?sku=X (cache 1h no
 * backend). Mantém cache em memória do navegador (Map global) pra evitar
 * fetch repetido quando o mesmo SKU aparece em várias listas.
 *
 * Enquanto a foto carrega (ou se não tem foto), mostra avatar com inicial
 * do refCode/sku.
 *
 * CLICK pra AMPLIAR — quando enableZoom={true} (default), click na
 * thumbnail abre um lightbox em tela cheia com a foto em tamanho grande,
 * nome e SKU. Esc ou click fora fecha.
 */

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '@/lib/api';

const PRODUCT_IMG_CACHE = new Map<string, string | null>();

export function ProductThumb({
  sku,
  refCode,
  productName,
  size = 56,
  enableZoom = true,
}: {
  sku: string;
  refCode?: string | null;
  /** Nome completo do produto, exibido no lightbox abaixo da foto. */
  productName?: string | null;
  /** Tamanho em px (default 56). Largura = altura. */
  size?: number;
  /** Click amplia em lightbox (default true). Passar false desabilita. */
  enableZoom?: boolean;
}) {
  const [url, setUrl] = useState<string | null | undefined>(
    PRODUCT_IMG_CACHE.has(sku) ? PRODUCT_IMG_CACHE.get(sku) : undefined,
  );
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!sku) return;
    if (PRODUCT_IMG_CACHE.has(sku)) {
      setUrl(PRODUCT_IMG_CACHE.get(sku));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ url: string | null }>(`/pdv/product-image?sku=${encodeURIComponent(sku)}`);
        if (!cancelled) {
          PRODUCT_IMG_CACHE.set(sku, r.url);
          setUrl(r.url);
        }
      } catch {
        if (!cancelled) {
          PRODUCT_IMG_CACHE.set(sku, null);
          setUrl(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sku]);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomed(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  const inicial = (refCode || sku || '?').charAt(0).toUpperCase();
  const wh = `${size}px`;
  const canZoom = enableZoom && !!url;

  if (url === undefined) {
    return (
      <div
        className="rounded-lg bg-slate-200 text-slate-500 flex items-center justify-center font-bold shrink-0 animate-pulse"
        style={{ width: wh, height: wh, fontSize: size * 0.4 }}
        aria-label="Carregando foto"
      >
        {inicial}
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className="rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center font-bold shrink-0 border border-slate-200"
        style={{ width: wh, height: wh, fontSize: size * 0.4 }}
        aria-label="Sem foto"
      >
        {inicial}
      </div>
    );
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={refCode || sku || 'Produto'}
        onClick={canZoom ? () => setZoomed(true) : undefined}
        className={`rounded-lg object-cover shrink-0 border border-slate-200 bg-white ${canZoom ? 'cursor-zoom-in hover:ring-2 hover:ring-violet-400 hover:brightness-95 transition' : ''}`}
        style={{ width: wh, height: wh }}
        loading="lazy"
        title={canZoom ? 'Clica pra ampliar' : undefined}
      />
      {zoomed && (
        <div
          className="fixed inset-0 z-[300] bg-black/85 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setZoomed(false)}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setZoomed(false); }}
            className="absolute top-4 right-4 w-12 h-12 rounded-full bg-white/15 hover:bg-white/30 text-white flex items-center justify-center transition"
            title="Fechar (Esc)"
          >
            <X className="w-7 h-7" />
          </button>
          <div
            className="flex flex-col items-center gap-3 max-w-full max-h-full"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={refCode || sku || 'Produto'}
              className="max-w-[90vw] max-h-[80vh] object-contain rounded-lg shadow-2xl"
            />
            <div className="bg-white/95 backdrop-blur rounded-xl px-4 py-2 text-center shadow-lg">
              {productName && (
                <div className="font-bold text-slate-900 text-sm sm:text-base">
                  {productName}
                </div>
              )}
              <div className="text-xs font-mono text-slate-600 mt-0.5">
                SKU: {sku}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default ProductThumb;
