'use client';

import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ProductCard } from '@/components/cards/ProductCard';
import { Skeleton } from '@/components/ui/Skeleton';
import { useWishlistStore } from '@/store/wishlist';
import { useMounted } from '@/hooks';
import { mapPeca, type PecaApi } from '@/services/products';
import type { Product } from '@/types';

/**
 * As peças guardadas, carregadas do catálogo (item 69).
 *
 * O store guarda só o ID (a REF) — de propósito: guardar preço e foto no
 * localStorage é guardar a vitrine de meses atrás. A peça é relida agora, com
 * o preço e o estoque de hoje.
 *
 * A REF que sumiu do catálogo é REMOVIDA da lista em vez de virar card
 * quebrado. Peça descontinuada ocupando espaço na lista de desejos é ruído
 * permanente — a cliente não tem como limpar o que não renderiza.
 *
 * Em SÉRIE limitada, não tudo de uma vez: lista grande dispararia dezenas de
 * requisições paralelas no 4G da cliente.
 */
const TETO = 40;

export function ListaDeDesejos() {
  const mounted = useMounted();
  const ids = useWishlistStore((s) => s.ids);
  const toggle = useWishlistStore((s) => s.toggle);

  const [pecas, setPecas] = useState<Product[]>([]);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    if (!mounted) return;
    if (!ids.length) {
      setPecas([]);
      setCarregando(false);
      return;
    }

    let vivo = true;
    setCarregando(true);

    (async () => {
      const achadas: Product[] = [];
      const sumiram: string[] = [];

      for (const id of ids.slice(0, TETO)) {
        try {
          // O slug canônico de uma REF sem curadoria é `ref-<ref>`, e o
          // backend aceita os dois — então o ID basta.
          const res = await fetch(`/api/loja/produto/${encodeURIComponent(`ref-${id}`)}`);
          if (!res.ok) {
            sumiram.push(id);
            continue;
          }
          const p = (await res.json()) as PecaApi;
          if (p?.slug) achadas.push(mapPeca(p));
          else sumiram.push(id);
        } catch {
          // Falha de REDE não é peça que sumiu — não mexe na lista.
        }
      }

      if (!vivo) return;
      setPecas(achadas);
      setCarregando(false);
      // Limpa só o que o catálogo negou de verdade.
      sumiram.forEach((id) => toggle(id));
    })();

    return () => {
      vivo = false;
    };
    // `toggle` é estável no zustand; `ids` é a dependência real.
  }, [mounted, ids, toggle]);

  if (!mounted || carregando) {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="aspect-3/4 rounded-sm" />
        ))}
      </div>
    );
  }

  if (!pecas.length) {
    return (
      <EmptyState
        icon={<Heart strokeWidth={1.25} />}
        title="Sua lista está vazia"
        description="Toque no coração das peças que você quer guardar — elas ficam aqui esperando, com o preço de hoje."
        action={{ label: 'Ver novidades', href: '/novidades' }}
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">
      {pecas.map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  );
}
