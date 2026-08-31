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
 * Aqui a diferença vira prateleira: peças que aproximam a sacola do frete
 * grátis. O TETO (`falta × 1,6`) existe pra não oferecer um vestido de R$ 900
 * pra fechar um buraco de R$ 40 — ela pagaria R$ 860 pra economizar o frete, e
 * isso não é oferta, é pegadinha.
 *
 * ── O PISO ESTAVA ERRADO (corrigido 31/08/2026, achado do dono) ──
 *
 * O piso era a PRÓPRIA FALTA: só entrava peça capaz de fechar a conta sozinha.
 * A premissa é falsa — **a cliente pode levar mais de uma peça**, e é isso que
 * ela faz.
 *
 * O estrago, medido: com a régua em R$ 499,90 e a mediana do pedido em
 * R$ 149,89, faltam ~R$ 350 na sacola típica. O piso antigo mandava procurar
 * peça de R$ 350 a R$ 560 — **49 das 734 no ar**, e todas erradas pro momento:
 * "leve um vestido de R$ 400 pra economizar R$ 10 de frete". Deu **3 cliques em
 * 7 dias**. Com o piso em `falta / 3`, a mesma sacola passa a ver **595 peças**,
 * e ela soma as que quiser — a barra anda a cada uma, e este bloco recalcula
 * sozinho porque `falta` é dependência do efeito.
 *
 * O título acompanha: prometer "qualquer uma destas fecha a conta" quando
 * nenhuma fecha é a mesma mentira do sentido contrário.
 *
 * Não aparece quando o frete grátis está desligado, quando ela já bateu a
 * régua, ou quando o catálogo não tem nada na faixa — prateleira que não
 * resolve o problema anunciado é pior que nenhuma.
 */

/** Até quanto acima da falta ainda é uma sugestão honesta. */
const TETO_DA_FAIXA = 1.6;

/**
 * Em quantas peças a cliente pode fechar a conta. Três é o que separa
 * "sugestão" de "lista de compras": com a falta dividida por três, a peça mais
 * barata da faixa ainda representa um terço do caminho — abaixo disso a
 * prateleira viraria catálogo inteiro e não ajudaria a decidir nada.
 */
const PECAS_PARA_FECHAR = 3;

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
      // O piso é a falta DIVIDIDA, não a falta: ela pode levar mais de uma.
      precoMin: (falta / PECAS_PARA_FECHAR).toFixed(2),
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

  /**
   * Alguma das peças na tela fecha a conta SOZINHA? A resposta muda a promessa
   * do título — e ela é lida das peças que de fato vieram, não do palpite da
   * faixa. Com o frete grátis longe, nenhuma fecha, e prometer que fecha seria
   * a mesma mentira que este bloco existe pra desfazer.
   */
  const alguemFecha = pecas.some((p) => p.price >= falta);

  return (
    <Section space="sm" width="wide" aria-labelledby="completar-frete">
      <SectionTitle
        id="completar-frete"
        eyebrow="Frete grátis"
        title={
          alguemFecha
            ? `Faltam ${formatPrice(falta)} — qualquer uma destas fecha a conta`
            : `Faltam ${formatPrice(falta)} para o frete grátis`
        }
        description={
          alguemFecha
            ? 'Peças que sozinhas levam sua sacola até o frete por nossa conta.'
            : 'Vá somando: a cada peça a barra anda, e esta lista se ajusta ao que ainda falta.'
        }
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
