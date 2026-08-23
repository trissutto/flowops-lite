'use client';

import { useEffect, useState } from 'react';

import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { LuxuryCarousel } from '@/components/ui/LuxuryCarousel';
import { CAROUSEL_PRODUCT_SIZES, ProductCard } from '@/components/cards/ProductCard';
import { chaveDoCard, mapPeca } from '@/services/products';
import { freeShippingGap } from '@/lib/commerce/frete';
import { useLojaConfig } from '@/hooks/useLojaConfig';
import { trackSelectItem } from '@/lib/tracking';
import { formatPrice } from '@/lib/utils';
import type { Product } from '@/types';

/**
 * "FALTAM R$ 340" — AGORA COM O CAMINHO, NÃO SÓ A DISTÂNCIA.
 *
 * A barra de progresso anunciava a diferença até o frete grátis e parava aí.
 * Pra cliente isso é uma conta pra fazer sozinha, num catálogo de milhares de
 * peças: "o que custa R$ 340 e eu ia querer?". Na prática o aviso informava o
 * quanto faltava pra desistir.
 *
 * Aqui a diferença vira prateleira: peças cujo preço FECHA A CONTA sozinho —
 * de `falta` até `falta × 1,6`. O teto existe pra não oferecer um vestido de
 * R$ 900 pra fechar um buraco de R$ 40 (ela pagaria R$ 860 pra economizar o
 * frete, e isso não é oferta, é pegadinha). O piso é a própria falta: peça
 * mais barata que isso não resolve, e sugerir "leve mais três" é pedir
 * trabalho.
 *
 * Não aparece quando o frete grátis está desligado, quando ela já bateu a
 * régua, ou quando o catálogo não tem nada na faixa — prateleira que não
 * resolve o problema anunciado é pior que nenhuma.
 */

/** Até quanto acima da falta ainda é uma sugestão honesta. */
const TETO_DA_FAIXA = 1.6;

export function CompletarFreteGratis({ subtotal }: { subtotal: number }) {
  const { freteGratis } = useLojaConfig();
  const gap = freeShippingGap(subtotal, freteGratis.minimo);
  const falta = gap.missing;
  const vale = freteGratis.ativo && freteGratis.minimo > 0 && !gap.reached && falta > 0;

  // null = ainda buscando; [] = buscou e não há o que mostrar.
  const [pecas, setPecas] = useState<Product[] | null>(null);

  useEffect(() => {
    if (!vale) {
      setPecas([]);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      precoMin: falta.toFixed(2),
      precoMax: (falta * TETO_DA_FAIXA).toFixed(2),
      // Mais barata primeiro: entre as que resolvem, a que custa menos é a
      // que a cliente aceita sem pensar duas vezes.
      ordenar: 'preco-asc',
      perPage: '8',
    });

    void fetch(`/api/loja/produtos?${params}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : { itens: [] }))
      .then((dados) => {
        if (controller.signal.aborted) return;
        setPecas(((dados.itens ?? []) as Parameters<typeof mapPeca>[0][]).map(mapPeca));
      })
      // Sugestão é cortesia: catálogo fora do ar vira seção ausente, nunca
      // erro na cara de quem está fechando a compra.
      .catch(() => {
        if (!controller.signal.aborted) setPecas([]);
      });

    return () => controller.abort();
    // `falta` muda a cada peça somada — é ela que define a faixa da busca.
  }, [vale, falta]);

  if (!vale || !pecas?.length) return null;

  return (
    <Section space="sm" width="wide" aria-labelledby="completar-frete">
      <SectionTitle
        id="completar-frete"
        eyebrow="Frete grátis"
        title={`Faltam ${formatPrice(falta)} — qualquer uma destas fecha a conta`}
        description="Peças que sozinhas levam sua sacola até o frete por nossa conta."
        align="left"
      />
      <div className="mt-8">
        <LuxuryCarousel ariaLabel="Peças que completam o frete grátis">
          {pecas.map((product, index) => (
            <ProductCard
              key={chaveDoCard(product)}
              product={product}
              index={index}
              sizes={CAROUSEL_PRODUCT_SIZES}
              onProductClick={() => trackSelectItem(product, 'completar-frete-gratis', index)}
            />
          ))}
        </LuxuryCarousel>
      </div>
    </Section>
  );
}
