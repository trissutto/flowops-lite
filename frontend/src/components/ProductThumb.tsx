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
 */

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const PRODUCT_IMG_CACHE = new Map<string, string | null>();

export function ProductThumb({
  sku,
  refCode,
  size = 56,
}: {
  sku: string;
  refCode?: string | null;
  /** Tamanho em px (default 56). Largura = altura. */
  size?: number;
}) {
  const [url, setUrl] = useState<string | null | undefined>(
    PRODUCT_IMG_CACHE.has(sku) ? PRODUCT_IMG_CACHE.get(sku) : undefined,
  );

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

  const inicial = (refCode || sku || '?').charAt(0).toUpperCase();
  const wh = `${size}px`;

  // Carregando: avatar cinza com inicial
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

  // Sem foto: avatar com inicial
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

  // Com foto
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={refCode || sku || 'Produto'}
      className="rounded-lg object-cover shrink-0 border border-slate-200 bg-white"
      style={{ width: wh, height: wh }}
      loading="lazy"
    />
  );
}

export default ProductThumb;
