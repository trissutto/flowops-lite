import { Section } from '@/components/layout/Section';
import { Container } from '@/components/layout/Container';
import { SectionTitle } from '@/components/sections/SectionTitle';
import { Breadcrumb } from '@/components/navigation/Breadcrumb';
import { CategoryListing } from '@/components/commerce/CategoryListing';
import { fetchPrimeiraPagina } from '@/services/vitrine';
import { breadcrumbSchema, buildMetadata, jsonLdGraph } from '@/lib/seo';

/**
 * OUTLET — tudo que está com desconto (dono 07/08).
 *
 * ⚠️ A rota NÃO EXISTIA: "Outlet" é o sexto item do menu principal e caía em
 * 404 — medido em produção (15ms, zero produto). Junto com `/categoria`, era
 * o segundo item de menu quebrado do site.
 *
 * O CRITÉRIO MUDOU EM 15/08: entra quem tem DESCONTO DE VERDADE, não quem tem
 * a marquinha de promoção. A marca vinha do `on_sale` do WooCommerce e o preço
 * promocional não veio junto — medido em produção: **49 peças aqui e 1 com
 * "de/por"**. Agora o preço sai da mesma promoção que o caixa aplica na loja
 * (50% em peça de MODA cadastrada até 31/12/2023), com o `precoPromo` digitado
 * na retaguarda vencendo a regra quando existe. Ver
 * `backend/src/promo-site/promo-site.service.ts`.
 *
 * Não é vitrine por faixa de preço: outlet é a peça que a loja baixou, não a
 * peça barata. Preço teto já existe em `/ate/59-90` e `/ate/99-90`.
 *
 * A página 1 vem pronta do servidor — sem isso a cliente olha esqueleto
 * enquanto o navegador baixa o JS e faz duas viagens à API.
 */

/** 60 s (era 3600) — ver `REVALIDATE_VITRINE` em `services/vitrine.ts`. */
export const revalidate = 60;

export const metadata = buildMetadata({
  title: 'Outlet — até 50% OFF',
  description:
    'Coleções passadas com até 50% OFF na Lurd’s Plus Size, do 44 ao 60. Enquanto durar o estoque.',
  path: '/outlet',
  keywords: ['outlet plus size', 'promoção plus size', '50% off plus size', 'desconto roupa plus size'],
});

const trail = [
  { name: 'Início', path: '/' },
  { name: 'Outlet', path: '/outlet' },
];

export default async function OutletPage() {
  const primeiraPagina = await fetchPrimeiraPagina({ soPromocao: true, perPage: 24 });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdGraph(breadcrumbSchema(trail)) }}
      />

      <Section width="text" space="sm">
        <Breadcrumb
          items={trail.map((item, i) => ({
            label: item.name,
            href: i < trail.length - 1 ? item.path : undefined,
          }))}
        />
        <SectionTitle
          eyebrow="Enquanto durar o estoque"
          title="Outlet"
          description="Até 50% OFF nas coleções passadas, do 44 ao 60 — o mesmo desconto que vale no caixa das lojas. O que sai daqui não volta pelo mesmo preço."
          as="h1"
        />
      </Section>

      <Container width="wide">
        <CategoryListing
          category=""
          categoryName="Outlet"
          soPromocao
          primeiraPagina={primeiraPagina}
        />
      </Container>
    </>
  );
}
