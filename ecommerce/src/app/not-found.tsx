import { SearchX } from 'lucide-react';
import { Section } from '@/components/layout/Section';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { ProductCard } from '@/components/cards/ProductCard';
import { BuscaDaPaginaPerdida } from '@/components/navigation/BuscaDaPaginaPerdida';
import { fetchVitrine } from '@/services/vitrine';
import { chaveDoCard } from '@/services/products';
import { buildMetadata } from '@/lib/seo';

/**
 * A PÁGINA DE ERRO É UMA DAS MAIS VISITADAS DO DOMÍNIO — E ATÉ 23/08/2026 ELA
 * NÃO TENTAVA NADA.
 *
 * A Search Console registra **4.156 URLs em 404** neste domínio (medido em
 * 23/08). São links salvos por clientes, posts do Instagram e resultados do
 * Google que sobreviveram à saída do WooCommerce. Todos caíam aqui, e aqui
 * havia duas coisas: "Voltar ao início" e "Ver nossas lojas" — ou seja, a
 * cliente que procurava UMA peça era mandada de volta pro começo do site.
 *
 * Agora a página faz o que uma vendedora faria: pergunta o que ela procurava e
 * mostra o que acabou de chegar enquanto isso.
 *
 * ⚠️ ISTO É A REDE, NÃO O CONSERTO. O conserto de verdade é a peça não cair
 * aqui: a PDP resolve o endereço antigo pelo `wcSlug` e devolve 308 (ver
 * `app/(public)/produto/[slug]/page.tsx`). Esta página existe pro que sobra —
 * peça que saiu de linha, categoria que não existe mais, link digitado torto.
 *
 * `noIndex` continua: página de erro indexada é lixo no índice. O que muda é
 * o que a PESSOA vê.
 */

export const metadata = buildMetadata({
  title: 'Página não encontrada',
  path: '/404',
  noIndex: true,
});

/**
 * Não é `force-dynamic`: a lista de novidades é a mesma pra todo mundo e a
 * página de erro não pode custar uma consulta ao catálogo por 404 de robô —
 * são milhares por dia. Uma hora de cache é de sobra.
 */
export const revalidate = 3600;

export default async function NotFound() {
  // Catálogo fora do ar devolve lista vazia e a página vira o que era antes.
  const novidades = await fetchVitrine({ ordenar: 'novidades', limite: 8, soNovidade: true });

  return (
    <>
      <Section space="lg" width="text">
        <div className="flex flex-col items-center text-center">
          <span className="mb-5 text-primary-strong" aria-hidden>
            <SearchX className="size-9" strokeWidth={1.25} />
          </span>
          <h1 className="font-display text-h2 text-ink">Essa página saiu de coleção.</h1>
          <p className="mt-3 max-w-md text-body font-light text-ink-soft">
            O endereço que você abriu não existe mais. Se você procurava uma peça, escreve aqui o
            nome, a referência ou o seu número — a gente acha.
          </p>
        </div>

        <BuscaDaPaginaPerdida className="mx-auto mt-8 max-w-md" />
      </Section>

      {novidades.length > 0 && (
        <Section space="sm" width="wide" tone="alt" aria-labelledby="404-novidades">
          <SectionTitle
            id="404-novidades"
            eyebrow="Acabou de chegar"
            title="Enquanto isso, olha o que entrou essa semana"
            cta={{ label: 'Ver todas as novidades', href: '/novidades' }}
            align="left"
          />
          <div className="mt-8 grid grid-cols-2 gap-x-2 gap-y-6 lg:grid-cols-4 lg:gap-x-6">
            {novidades.map((product, index) => (
              <ProductCard key={chaveDoCard(product)} product={product} index={index} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
