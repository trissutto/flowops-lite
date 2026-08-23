'use client';

import { HOME_GRID_SIZES, ProductCard } from '@/components/cards/ProductCard';
import { VITRINE_GRID_MAX, VITRINE_GRID_MAX_MOBILE } from '@/data/home';
import { cn } from '@/lib/utils';
import type { Product } from '@/types';
import { trackSelectItem } from '@/lib/tracking';

/**
 * VITRINE EM GRADE — as vitrines de produto da home.
 *
 * Pedido do dono (20/08, revisando o de 18/08): "no PC pelo menos 12
 * produtos divididos em 4 COLUNAS". No celular seguem as 2 colunas. O teto
 * continua VITRINE_GRID_MAX (18) — quantas peças cada vitrine mostra é o
 * `limite` dela em /retaguarda/vitrines-home; a grade mostra tudo de uma vez
 * (o carrossel escondia peça atrás de seta).
 *
 * Não existe "componente de grade" neste projeto: toda grade de produto é um
 * `div.grid` com a mesma string de classe repetida (SearchResults,
 * DescobrirFeed, ListaDeDesejos, RecommendationRail). Este arquivo só existe
 * porque a home tem CINCO delas e porque a grade da home é a única de 2/6
 * colunas — não é abstração nova, é a mesma linha escrita num lugar só.
 */

export function VitrineGrid({
  products,
  /**
   * Vira o `item_list_name` do `select_item`. Passar o TÍTULO da seção, nunca
   * o slug: é essa string que o GA4 guarda, e trocá-la parte a série histórica
   * das duas vitrines que já estavam no ar ("Mais Top da semana",
   * "Novidades da semana").
   */
  listName,
}: {
  products: Product[];
  listName: string;
}) {
  return (
    /**
     * `div` cru, sem `role="list"`: o card é um `<article>` e virar item de
     * lista exigiria `role="listitem"` em cada um. Quem nomeia a região é o
     * `aria-labelledby` da `Section`, como nas outras grades do site.
     */
    <div
      /**
       * 4 colunas a partir de `lg:` (1024): a 1024 o container tem 929px e o
       * card sai com ~214px — confortável, e é onde a camada de hover (`lg:`)
       * liga. O layout anterior (6 colunas só em `xl:`) tinha um degrau
       * medido na faixa 1024–1279 (card inflava pra 288px e a vitrine quase
       * triplicava de altura); com 4 colunas valendo de 1024 em diante o
       * degrau some.
       *
       * `grid-cols-N` (frações fixas) e não `auto-fit/minmax`: a vitrine
       * curada pode vir com contagem quebrada (ex.: 18 peças em 4 colunas =
       * 4+4+4+4+2) e a última linha incompleta é de propósito. Com fração
       * fixa ela apenas sobra à direita; com `auto-fit` os poucos que restam
       * esticariam e a peça curada apareceria maior que as outras.
       */
      className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 lg:gap-x-6 lg:gap-y-12"
    >
      {products.slice(0, VITRINE_GRID_MAX).map((product, index) => (
        <ProductCard
          /**
           * A chave leva o índice porque a curadoria pode repetir peça: dois
           * REFs curados da MESMA família resolvem para o mesmo card no
           * backend, e o mesmo `id` sairia duas vezes no array.
           */
          key={`${product.id}-${index}`}
          product={product}
          index={index}
          compact
          /**
           * `min-w-0` no filho do grid, e não só nos breakpoints largos: item
           * de grid nasce com `min-width: auto` e conteúdo largo estica o
           * viewport de layout do celular, cortando a página INTEIRA — foi o
           * incidente de 13/08 na página da peça.
           */
          /**
           * O QUE PASSA DE 8 SÓ EXISTE DO `sm:` PRA CIMA.
           *
           * A home media 39,6 telas no celular em 22/08 — uma vitrine de 18
           * peças sozinha ocupava 9. Aqui a peça extra some da ROLAGEM (e a
           * foto dela nem entra na fila de download, porque `progressiveImage`
           * só carrega o que aparece), enquanto o desktop segue com as 12 em
           * 4 colunas que o dono pediu.
           */
          className={cn('min-w-0', index >= VITRINE_GRID_MAX_MOBILE && 'hidden sm:block')}
          sizes={HOME_GRID_SIZES}
          /**
           * Obrigatório aqui: é o que faz vitrine fora da tela custar ZERO
           * byte de imagem. Sem ele as 90 fotos das cinco vitrines entram na
           * fila de download de uma vez. E nenhum card recebe `priority`: o
           * LCP da home é o hero, e `priority` num card roubaria banda dele.
           */
          progressiveImage
          onProductClick={() => trackSelectItem(product, listName, index)}
        />
      ))}
    </div>
  );
}
