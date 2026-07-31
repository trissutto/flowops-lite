'use client';

import { LuxuryCarousel } from '@/components/ui/LuxuryCarousel';
import { LookCard } from '@/components/cards/LookCard';
import { useCartStore } from '@/store/cart';
import { useToast } from '@/components/feedback/ToastProvider';
import type { Look } from '@/types';

/**
 * Shop the Look — carrossel de looks completos.
 * "Levar o look" adiciona todas as peças na sacola no menor tamanho
 * disponível; a cliente ajusta os tamanhos no carrinho.
 */
export function LookShowcase({ looks }: { looks: Look[] }) {
  const add = useCartStore((s) => s.add);
  const { toast } = useToast();

  function buyLook(look: Look) {
    for (const { product } of look.items) {
      const firstAvailable = product.sizes.find((s) => s.available);
      if (!firstAvailable) continue;
      add({
        productId: product.id,
        slug: product.slug,
        name: product.name,
        image: product.images[0],
        size: firstAvailable.label,
        quantity: 1,
        unitPrice: product.price,
      });
    }
    toast({
      message: `Look "${look.title}" na sacola`,
      description: 'Confira os tamanhos antes de finalizar.',
    });
  }

  return (
    <LuxuryCarousel
      ariaLabel="Looks completos"
      perView={{ base: 1.1, sm: 1.6, lg: 2.4, xl: 3 }}
      gap="lg"
      arrows
    >
      {looks.map((look, index) => (
        <LookCard key={look.id} look={look} index={index} onBuyLook={buyLook} />
      ))}
    </LuxuryCarousel>
  );
}
