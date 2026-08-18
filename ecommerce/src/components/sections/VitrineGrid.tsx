'use client';

import { HOME_GRID_SIZES, ProductCard } from '@/components/cards/ProductCard';
import { VITRINE_GRID_MAX } from '@/data/home';
import type { Product } from '@/types';
import { trackSelectItem } from '@/lib/tracking';

/**
 * VITRINE EM GRADE — as vitrines de produto da home.
 *
 * Pedido do dono (18/08): "no DESKTOP, cada linha da vitrine deve ter 6
 * COLUNAS e devemos ter 3 LINHAS. No CELULAR, 2 COLUNAS com 9 LINHAS." Ou
 * seja: 18 posições por vitrine, em grade — o carrossel esconde peça atrás de
 * uma seta, a grade mostra as 18 de uma vez.
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
       * A virada é `xl:` (1280) e NÃO `lg:` (1024) por medição: a 1024 o
       * container tem 929px, então 6 colunas dariam um card de 135px — mais
       * estreito que um card de celular em 2 colunas, e é justamente ali que a
       * camada de hover (que é `lg:`) já está ligada. Com 3 colunas valendo
       * até 1279, o card a 1024 fica com 288px, do tamanho do card de 4
       * colunas que está no ar hoje.
       *
       * `grid-cols-N` (frações fixas) e não `auto-fit/minmax`: a vitrine
       * curada tem ~10 peças, então a última linha vem incompleta de
       * propósito. Com fração fixa a linha incompleta apenas sobra à direita e
       * o card mantém a largura dos vizinhos; com `auto-fit` os poucos que
       * restam esticariam pra preencher a linha e a peça curada apareceria
       * maior que as outras.
       *
       * NÃO existe passo intermediário de 4 ou 5 colunas porque o dono pediu
       * dois layouts, 3 e 6 — não porque 4 ou 5 quebrariam a grade (não
       * quebram: com 18 peças a linha incompleta cairia no fim de qualquer
       * jeito, 4+4+4+4+2). O preço dessa escolha está MEDIDO e é a faixa de
       * 1024 a 1279: a 1024 o card infla pra 288px e UMA vitrine fica com
       * 3.240px de altura; a 1280 o mesmo card cai pra 174px e a vitrine
       * inteira mede 1.264px. São 1px de janela pra quase 3× de rolagem —
       * quem for mexer nessa faixa mexe sabendo disso.
       *
       * O `lg:gap-x-6` existe justamente por causa dela: é onde o card é o
       * MAIOR do site (288px a 1024, ~379px a 1279) e a calha ainda era a de
       * celular, 16px — cards enormes quase se encostando. 24px a partir de
       * 1024 é o que toda outra grade de produto do projeto já faz
       * (SearchResults, DescobrirFeed, RecommendationRail, ListaDeDesejos).
       */
      className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:gap-x-6 xl:grid-cols-6 xl:gap-y-12"
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
          className="min-w-0"
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
