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
 * O critério é a marca de PROMOÇÃO do cadastro (`soPromocao`), não um preço
 * teto: outlet é a peça que a loja decidiu baixar, não a peça barata. Vitrine
 * por faixa de preço já existe em `/ate/59-90` e `/ate/99-90`.
 *
 * A página 1 vem pronta do servidor — sem isso a cliente olha esqueleto
 * enquanto o navegador baixa o JS e faz duas viagens à API.
 */

export const revalidate = 3600;

export const metadata = buildMetadata({
  title: 'Outlet — peças com desconto',
  description:
    'Peças selecionadas com desconto na Lurd’s Plus Size, do 44 ao 60. Enquanto durar o estoque.',
  path: '/outlet',
  keywords: ['outlet plus size', 'promoção plus size', 'desconto roupa plus size'],
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
          description="Peças com desconto, do 44 ao 60. O que sai daqui não volta pelo mesmo preço."
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
